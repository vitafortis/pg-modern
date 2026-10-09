import { parseDocument } from 'yaml';
import { extractCandidates, fingerprint, interpolate } from './env.ts';
import { detectServer, mysqlLogins, type ServerKind } from './detect.ts';
import type { Candidate, ConnectionSource, SelfNetworks } from '#lib/types.ts';
import { composeServiceNetworks, networkPath } from './network.ts';


export interface ComposeContext {
	/** Project name when the file has no top-level `name:`. */
	project: string;
	source: ConnectionSource;
	/** Variables for `${VAR}` interpolation, usually the project's `.env`. */
	vars: Record<string, string>;
	/** Loads an `env_file:` entry (path relative to the compose file). */
	readEnvFile: (path: string) => Promise<Record<string, string>>;
	/** Address that reaches ports published on the Docker host (default: localhost). */
	publishedHost?: string;
	/** Called when the file isn't valid YAML, so callers can surface it instead of silently skipping. */
	onParseError?: (message: string) => void;
	/** pg·modern's own networks, to work out which services it can reach by name. */
	self?: SelfNetworks;
}

/**
 * Lenient parse: compose files lean on YAML merge keys (`<<: *defaults`) and custom tags
 * (`!reset`, `!override`), and a partly broken file should still yield what it can.
 */
export function parseCompose(content: string): { value: unknown; errors: string[] } {
	const doc = parseDocument(content, { merge: true, logLevel: 'silent' });
	return { value: doc.toJS({ maxAliasCount: 1000 }), errors: doc.errors.map((e) => e.message.split('\n')[0]) };
}

type ComposeService = {
	image?: string;
	container_name?: string;
	environment?: Record<string, string | number | null> | string[];
	env_file?: string | string[] | { path: string }[];
	ports?: (string | number | { target: number; published?: string | number; host_ip?: string })[];
	networks?: string[] | Record<string, unknown> | null;
	network_mode?: string;
};

function composeEnv(env: ComposeService['environment']): Record<string, string> {
	if (!env) return {};
	if (Array.isArray(env)) {
		return Object.fromEntries(
			env.map((line) => {
				const i = String(line).indexOf('=');
				return i === -1 ? [String(line), ''] : [String(line).slice(0, i), String(line).slice(i + 1)];
			})
		);
	}
	return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v == null ? '' : String(v)]));
}

/** Host port a service publishes for `target`, from short ("5433:5432") or long syntax. */
function publishedPort(ports: ComposeService['ports'], target: number, dockerHost: string): { host: string; port: number } | null {
	// A bind on all interfaces (or none given) is reached through the Docker host's address.
	const bind = (ip?: string) => (!ip || ip === '0.0.0.0' || ip === '::' ? dockerHost : ip);
	for (const p of ports ?? []) {
		if (typeof p === 'object') {
			if (Number(p.target) === target && p.published) return { host: bind(p.host_ip), port: Number(p.published) };
			continue;
		}
		const parts = String(p).replace(/\/(tcp|udp)$/, '').split(':');
		if (parts.length >= 2 && Number(parts[parts.length - 1]) === target) {
			return { host: bind(parts.length === 3 ? parts[0] : undefined), port: Number(parts[parts.length - 2]) };
		}
	}
	return null;
}

/**
 * Database candidates from a compose file: Postgres / MySQL / MariaDB services
 * (credentials from their environment) and app services whose settings point at them.
 */
export async function composeCandidates(content: string, ctx: ComposeContext): Promise<Candidate[]> {
	const vars = ctx.vars;
	let doc: { services?: Record<string, ComposeService>; name?: string; networks?: Parameters<typeof composeServiceNetworks>[2] };
	try {
		const parsed = parseCompose(content);
		if (parsed.errors.length) ctx.onParseError?.(parsed.errors[0]);
		doc = (parsed.value ?? {}) as typeof doc;
	} catch (err) {
		ctx.onParseError?.((err as Error).message.split('\n')[0]);
		return [];
	}
	const services = doc.services ?? {};
	const project = doc.name ?? ctx.project;
	const out: Candidate[] = [];

	const serviceEnv = async (svc: ComposeService) => {
		const files = Array.isArray(svc.env_file) ? svc.env_file : svc.env_file ? [svc.env_file] : [];
		const fromFiles: Record<string, string> = {};
		for (const f of files) {
			const p = typeof f === 'string' ? f : f.path;
			Object.assign(fromFiles, await ctx.readEnvFile(interpolate(p, vars)));
		}
		const env = { ...fromFiles, ...composeEnv(svc.environment) };
		for (const k of Object.keys(env)) env[k] = interpolate(env[k], vars);
		return env;
	};

	// Map service names → reachable addresses, so app services referencing "db" resolve.
	const servers = new Map<string, { addrs: { host: string; port: number; label: string }[]; server: Candidate; kind: ServerKind }>();
	const self = ctx.self ?? { inContainer: false, networks: [] };
	for (const [name, svc] of Object.entries(services)) {
		const env = await serviceEnv(svc);
		const exposedPort = (port: number) =>
			(svc.ports ?? []).some((p) => new RegExp(`(^|:)${port}(\\/tcp)?$`).test(typeof p === 'object' ? String(p.target) : String(p)));
		const exposed = [5432, 3306].filter(exposedPort).map((p) => `${p}/tcp`);
		const kind = detectServer(interpolate(svc.image ?? '', vars), env, exposed);
		if (!kind) continue;
		const internal = kind.port;
		const pub = publishedPort(svc.ports, internal, ctx.publishedHost ?? 'localhost');
		const addrs = [
			...(pub ? [{ ...pub, label: 'published port' }] : []),
			{ host: svc.container_name ?? name, port: internal, label: 'compose service' }
		];

		const network = networkPath(
			{
				id: name,
				name: svc.container_name ?? name,
				networks: Object.fromEntries(composeServiceNetworks(project, svc, doc.networks).map((n) => [n, ''])),
				published: pub ? [{ host: pub.host, port: pub.port }] : [],
				running: true
			},
			self,
			internal
		);
		const logins =
			kind.engine === 'mysql'
				? mysqlLogins(env)
				: (() => {
						const user = env.POSTGRES_USER || env.POSTGRESQL_USERNAME || 'postgres';
						const password = env.POSTGRES_PASSWORD || env.POSTGRESQL_PASSWORD || undefined;
						const notes: string[] = [];
						if (!password && env.POSTGRES_PASSWORD_FILE) notes.push('Password comes from a secret file; enter it manually.');
						return [{ user, password, database: env.POSTGRES_DB || env.POSTGRESQL_DATABASE || user, notes }];
					})();
		const found = logins.map((login): Candidate => {
			const base = { engine: kind.engine, host: addrs[0].host, port: addrs[0].port, database: login.database, user: login.user };
			return {
				...base,
				...(kind.engine === 'mysql' ? { flavor: kind.flavor } : {}),
				fingerprint: fingerprint(base),
				name: logins.length > 1 ? `${project}/${name} (${login.user})` : `${project}/${name}`,
				password: login.password,
				hasPassword: !!login.password,
				sslMode: 'prefer',
				source: ctx.source,
				alternates: addrs.slice(1),
				notes: [...login.notes],
				network
			};
		});
		out.push(...found);
		const entry = { addrs, server: found[0], kind };
		servers.set(name.toLowerCase(), entry);
		if (svc.container_name) servers.set(svc.container_name.toLowerCase(), entry);
	}

	for (const [name, svc] of Object.entries(services)) {
		if (servers.has(name.toLowerCase())) continue;
		for (const c of extractCandidates(await serviceEnv(svc), { label: `${project}/${name}`, source: ctx.source })) {
			const target = servers.get(c.host.toLowerCase());
			if (target) {
				if (c.engine !== target.kind.engine) {
					c.engine = target.kind.engine;
					if (target.kind.engine === 'mysql' && c.database === c.user) c.database = target.server.database;
				}
				if (target.kind.engine === 'mysql') c.flavor = target.kind.flavor;
				c.alternates = [{ host: c.host, port: c.port, label: 'as configured' }, ...target.addrs.slice(1)];
				c.host = target.addrs[0].host;
				c.port = target.addrs[0].port;
				// No database configured (it defaulted to the user name): use the one the server creates.
				if (c.user === target.server.user && c.database === c.user) c.database = target.server.database;
				c.fingerprint = fingerprint(c);
				c.network = target.server.network;
			}
			out.push(c);
		}
	}
	return out;
}

