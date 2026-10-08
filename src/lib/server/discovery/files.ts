import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { config } from '../config.ts';
import { getSettings } from '../store.ts';
import { extractCandidates, fingerprint, interpolate, parseDotenv } from './env.ts';
import { mapLimit, probe } from './probe.ts';
import type { Candidate, EnvScanResult } from '#lib/types.ts';

const SKIP_DIRS = new Set([
	'node_modules', '.git', '.hg', '.svn', 'vendor', '.venv', 'venv', '__pycache__', '.cache', '.next', '.nuxt',
	'.svelte-kit', 'dist', 'build', 'target', '.terraform', 'Library', '.Trash', 'proc', 'sys', 'dev'
]);
const ENV_FILE = /^(\.env(\..+)?|.+\.env|stack\.env)$/i;
const COMPOSE_FILE = /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/i;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 5000;
const PG_IMAGE = /postgres|postgis|timescale|pgvector|pgvecto|paradedb|spilo|immich-app\/postgres|tensorchord/i;

export function expandHome(p: string): string {
	return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

export function scanRoots(extra: string[] = []): string[] {
	return [...new Set([...config.scanPaths, ...getSettings().scanPaths, ...extra].map((p) => resolve(expandHome(p))))];
}

async function walk(root: string, depth: number, out: string[], errors: string[]) {
	if (out.length >= MAX_FILES) return;
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (err) {
		errors.push(`${root}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
		return;
	}
	for (const e of entries) {
		const full = join(root, e.name);
		if (e.isFile() && (ENV_FILE.test(e.name) || COMPOSE_FILE.test(e.name))) {
			if (!/\.(example|sample|template|dist)$/i.test(e.name)) out.push(full);
		} else if (e.isDirectory() && depth > 0 && !SKIP_DIRS.has(e.name)) {
			await walk(full, depth - 1, out, errors);
		}
	}
}

async function readSmall(path: string): Promise<string | null> {
	try {
		const s = await stat(path);
		if (s.size > MAX_FILE_BYTES) return null;
		return await readFile(path, 'utf8');
	} catch {
		return null;
	}
}

type ComposeService = {
	image?: string;
	container_name?: string;
	environment?: Record<string, string | number | null> | string[];
	env_file?: string | string[] | { path: string }[];
	ports?: (string | number | { target: number; published?: string | number; host_ip?: string })[];
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
function publishedPort(ports: ComposeService['ports'], target: number): { host: string; port: number } | null {
	for (const p of ports ?? []) {
		if (typeof p === 'object') {
			if (Number(p.target) === target && p.published) return { host: p.host_ip || 'localhost', port: Number(p.published) };
			continue;
		}
		const parts = String(p).replace(/\/(tcp|udp)$/, '').split(':');
		if (parts.length >= 2 && Number(parts[parts.length - 1]) === target) {
			const host = parts.length === 3 ? parts[0] : 'localhost';
			return { host: host === '0.0.0.0' ? 'localhost' : host, port: Number(parts[parts.length - 2]) };
		}
	}
	return null;
}

async function scanCompose(path: string, content: string): Promise<Candidate[]> {
	const dir = dirname(path);
	const dotenv = parseDotenv((await readSmall(join(dir, '.env'))) ?? '');
	const vars = dotenv;
	let doc: { services?: Record<string, ComposeService>; name?: string };
	try {
		doc = parseYaml(content) ?? {};
	} catch {
		return [];
	}
	const services = doc.services ?? {};
	const project = doc.name ?? basename(dir);
	const out: Candidate[] = [];

	const serviceEnv = async (svc: ComposeService) => {
		const files = Array.isArray(svc.env_file) ? svc.env_file : svc.env_file ? [svc.env_file] : [];
		const fromFiles: Record<string, string> = {};
		for (const f of files) {
			const p = typeof f === 'string' ? f : f.path;
			Object.assign(fromFiles, parseDotenv((await readSmall(resolve(dir, interpolate(p, vars)))) ?? ''));
		}
		const env = { ...fromFiles, ...composeEnv(svc.environment) };
		for (const k of Object.keys(env)) env[k] = interpolate(env[k], vars);
		return env;
	};

	// Map service names → reachable addresses, so app services referencing "db" resolve.
	const servers = new Map<string, { host: string; port: number; label: string }[]>();
	for (const [name, svc] of Object.entries(services)) {
		const env = await serviceEnv(svc);
		const isServer = PG_IMAGE.test(interpolate(svc.image ?? '', vars)) || 'POSTGRES_PASSWORD' in env || 'PGDATA' in env;
		if (!isServer) continue;
		const internal = Number(env.PGPORT) || 5432;
		const pub = publishedPort(svc.ports, internal);
		const addrs = [
			...(pub ? [{ ...pub, label: 'published port' }] : []),
			{ host: svc.container_name ?? name, port: internal, label: 'compose service' }
		];
		servers.set(name.toLowerCase(), addrs);
		if (svc.container_name) servers.set(svc.container_name.toLowerCase(), addrs);

		const user = env.POSTGRES_USER || env.POSTGRESQL_USERNAME || 'postgres';
		const password = env.POSTGRES_PASSWORD || env.POSTGRESQL_PASSWORD || undefined;
		const notes: string[] = [];
		if (!password && env.POSTGRES_PASSWORD_FILE) notes.push('Password comes from a secret file; enter it manually.');
		if (!pub) notes.push('No published port — reachable only from the compose network.');
		const base = { host: addrs[0].host, port: addrs[0].port, database: env.POSTGRES_DB || env.POSTGRESQL_DATABASE || user, user };
		out.push({
			...base,
			fingerprint: fingerprint(base),
			name: `${project}/${name}`,
			password,
			hasPassword: !!password,
			sslMode: 'prefer',
			source: { kind: 'env', ref: path },
			alternates: addrs.slice(1),
			notes
		});
	}

	for (const [name, svc] of Object.entries(services)) {
		if (servers.has(name.toLowerCase())) continue;
		for (const c of extractCandidates(await serviceEnv(svc), { label: `${project}/${name}`, source: { kind: 'env', ref: path } })) {
			const target = servers.get(c.host.toLowerCase());
			if (target) {
				c.alternates = [{ host: c.host, port: c.port, label: 'as configured' }, ...target.slice(1)];
				c.host = target[0].host;
				c.port = target[0].port;
				c.fingerprint = fingerprint(c);
			}
			out.push(c);
		}
	}
	return out;
}

export async function scanFiles(extraRoots: string[] = []): Promise<{ result: EnvScanResult; candidates: Candidate[] }> {
	const started = performance.now();
	const roots = scanRoots(extraRoots);
	const errors: string[] = [];
	const paths: string[] = [];
	for (const root of roots) await walk(root, config.scanDepth, paths, errors);

	const composeDirs = new Set(paths.filter((p) => COMPOSE_FILE.test(basename(p))).map(dirname));
	const files: EnvScanResult['files'] = [];
	const all: Candidate[] = [];
	await mapLimit(paths, 16, async (path) => {
		const content = await readSmall(path);
		if (content == null) return;
		const root = roots.find((r) => path.startsWith(r)) ?? dirname(path);
		const label = relative(root, dirname(path)) || basename(root);
		let candidates: Candidate[];
		if (COMPOSE_FILE.test(basename(path))) {
			candidates = await scanCompose(path, content);
		} else {
			const vars = parseDotenv(content);
			for (const k of Object.keys(vars)) vars[k] = interpolate(vars[k], vars);
			candidates = extractCandidates(vars, {
				label,
				source: { kind: 'env', ref: path },
				requireHost: composeDirs.has(dirname(path))
			});
		}
		if (!candidates.length) return;
		// An app service and the server it points at often resolve to the same target; keep the first.
		candidates = candidates.filter((c, i) => candidates.findIndex((x) => x.fingerprint === c.fingerprint) === i);
		await Promise.all(candidates.map(async (c) => (c.reachable = await probe(c.host, c.port))));
		files.push({ path, candidates });
		all.push(...candidates);
	});

	files.sort((a, b) => a.path.localeCompare(b.path));
	return {
		result: { roots, filesScanned: paths.length, durationMs: Math.round(performance.now() - started), errors, files },
		candidates: all
	};
}
