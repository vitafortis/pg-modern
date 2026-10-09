import { config } from '../config.ts';
import { getManagerKey, getSettings } from '../store.ts';
import { composeCandidates } from './compose.ts';
import { looksLikePostgresServer } from './detect.ts';
import { envMap, pickReachable, postgresCredentials, settleAddress, uniqueAddresses, type Address } from './docker.ts';
import { extractCandidates, fingerprint, parseDotenv } from './env.ts';
import { mapLimit } from './probe.ts';
import type { Candidate, Manager, ManagerScan } from '#lib/types.ts';

export const ENV_MANAGER_ID = 'env-arcane';

export function listManagers(): Manager[] {
	const fromEnv: Manager[] = config.arcane
		? [{ id: ENV_MANAGER_ID, kind: 'arcane', name: config.arcane.name, url: config.arcane.url, hasKey: !!config.arcane.apiKey, fromEnv: true }]
		: [];
	const saved = (getSettings().managers ?? []).map((m) => ({ ...m, hasKey: !!getManagerKey(m.id) }));
	return [...fromEnv, ...saved];
}

function apiKeyFor(id: string): string | undefined {
	return id === ENV_MANAGER_ID ? config.arcane?.apiKey : getManagerKey(id);
}

// --- Arcane --------------------------------------------------------------------

class ArcaneClient {
	private base: string;
	private apiKey: string;

	constructor(base: string, apiKey: string) {
		this.base = base.replace(/\/+$/, '');
		this.apiKey = apiKey;
	}

	async get<T>(path: string): Promise<T> {
		let res: Response;
		try {
			res = await fetch(`${this.base}/api${path}`, {
				headers: { 'X-API-Key': this.apiKey, accept: 'application/json' },
				signal: AbortSignal.timeout(10_000)
			});
		} catch (err) {
			const cause = (err as { cause?: { code?: string; message?: string } }).cause;
			const reason = cause?.code ?? cause?.message ?? (err as Error).message;
			throw new Error(`Could not reach Arcane at ${this.base} (${reason})`);
		}
		const text = await res.text();
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			throw new Error(`Arcane returned ${res.status} (not JSON) for ${path}`);
		}
		if (!res.ok) {
			const b = body as { error?: string; message?: string; detail?: string; title?: string };
			const reason = b.error ?? b.detail ?? b.message ?? b.title ?? res.statusText;
			throw new Error(res.status === 401 || res.status === 403 ? `Arcane rejected the API key (${reason})` : `Arcane ${res.status}: ${reason}`);
		}
		return body as T;
	}

	/** Arcane wraps responses as { success, data }; some sections nest a `project` object. */
	async data<T>(path: string): Promise<T> {
		const body = await this.get<{ data?: unknown }>(path);
		const data = (body && typeof body === 'object' && 'data' in body ? body.data : body) as Record<string, unknown>;
		return (data && typeof data === 'object' && 'project' in data ? data.project : data) as T;
	}

	/** Reads every page of a paginated list. */
	async list<T>(path: string): Promise<T[]> {
		const out: T[] = [];
		const sep = path.includes('?') ? '&' : '?';
		while (out.length < 10_000) {
			const body = await this.get<{ data?: T[]; pagination?: { totalItems?: number } }>(`${path}${sep}start=${out.length}&limit=100`);
			const page = Array.isArray(body) ? (body as T[]) : (body.data ?? []);
			out.push(...page);
			const total = Array.isArray(body) ? undefined : body.pagination?.totalItems;
			// Advance by what actually came back (Arcane may cap the page size) until its total is reached.
			if (!page.length || (total !== undefined ? out.length >= total : page.length < 100)) break;
		}
		return out;
	}
}

type ArcaneEnvironment = { id: string; name?: string; apiUrl?: string; status?: string; enabled?: boolean };
type ArcaneProject = {
	id: string;
	name: string;
	status?: string;
	composeContent?: string;
	envContent?: string;
};

type ArcaneContainer = {
	id: string;
	name?: string;
	names?: string[];
	image: string;
	state?: string | { status?: string };
	status?: string;
	labels?: Record<string, string> | null;
	ports?: { ip?: string; privatePort: number; publicPort?: number; type?: string }[] | null;
	networkSettings?: { networks?: Record<string, { ipAddress?: string; aliases?: string[] | null }> | null } | null;
	config?: { env?: string[] | null } | null;
};

/**
 * Postgres found in an environment's containers. Covers databases that aren't Arcane
 * projects (deployed elsewhere, or defined in an override/included compose file).
 */
async function scanArcaneContainers(
	client: ArcaneClient,
	manager: Manager,
	env: { id: string; name: string; host: string }
): Promise<{ groups: { project: string; status: string; candidates: Candidate[] }[]; inspected: number; skipped: { name: string; image: string; state: string }[] }> {
	const base = `/environments/${encodeURIComponent(env.id)}/containers`;
	const list = (await client.list<ArcaneContainer>(base)).slice(0, 500);
	const details = await mapLimit(list, 8, (c) =>
		client.data<ArcaneContainer>(`${base}/${encodeURIComponent(c.id)}`).then((d) => ({ ...c, ...d })).catch(() => c)
	);

	const nameOf = (c: ArcaneContainer) => (c.name ?? c.names?.[0] ?? c.id.slice(0, 12)).replace(/^\//, '');
	const stateOf = (c: ArcaneContainer) => (typeof c.state === 'string' ? c.state : (c.state?.status ?? c.status ?? 'unknown'));
	const servers = new Map<string, Address[]>();
	const out = new Map<string, { project: string; status: string; candidates: Candidate[] }>();
	const push = (group: string, status: string, cand: Candidate) => {
		const g = out.get(group) ?? { project: group, status, candidates: [] };
		if (status === 'running') g.status = 'running';
		g.candidates.push(cand);
		out.set(group, g);
	};

	const isServer = (c: ArcaneContainer) =>
		looksLikePostgresServer(c.image, envMap(c.config?.env ?? null), (c.ports ?? []).map((p) => `${p.privatePort}/${p.type ?? 'tcp'}`));

	for (const pass of ['servers', 'apps'] as const) {
		for (const c of details) {
			if ((pass === 'servers') !== isServer(c)) continue;
			const vars = envMap(c.config?.env ?? null);
			const name = nameOf(c);
			const labels = c.labels ?? {};
			const project = labels['com.docker.compose.project'];
			const service = labels['com.docker.compose.service'];
			const group = project ?? name;
			const status = stateOf(c);
			const source = { kind: 'arcane' as const, ref: `${manager.name} · ${env.name} · ${name}` };

			if (pass === 'servers') {
				const internal = Number(vars.PGPORT) || 5432;
				const networks = Object.entries(c.networkSettings?.networks ?? {});
				const addresses = uniqueAddresses<Address>([
					...(c.ports ?? [])
						.filter((p) => p.privatePort === internal && p.publicPort)
						.map((p) => ({
							host: !p.ip || p.ip === '0.0.0.0' || p.ip === '::' ? env.host : p.ip,
							port: p.publicPort!,
							label: 'published port'
						})),
					{ host: name, port: internal, label: 'container name' },
					...networks.filter(([, n]) => n.ipAddress).map(([net, n]) => ({ host: n.ipAddress!, port: internal, label: `${net} network` }))
				]);
				servers.set(name.toLowerCase(), addresses);
				if (project && service) servers.set(`${project}::${service}`.toLowerCase(), addresses);

				const creds = postgresCredentials(vars);
				const { primary, alternates, reachable } = await pickReachable(addresses);
				const notes = [...creds.notes];
				if (status !== 'running') notes.push(`Container is ${status}.`);
				else if (!reachable) {
					const nets = networks.map(([n]) => n).filter((n) => !['bridge', 'host', 'none'].includes(n));
					notes.push(
						addresses[0]?.label === 'published port'
							? `Published on ${primary.host}:${primary.port}, but pg·modern can't reach it — check firewalls between the hosts.`
							: `pg·modern can't reach it: publish port ${internal}${nets.length ? `, or add pg·modern to the ${nets.join(' / ')} network` : ''}.`
					);
				}
				const base = { host: primary.host, port: primary.port, database: creds.database, user: creds.user };
				push(group, status, {
					...base,
					fingerprint: fingerprint(base),
					name: project && service ? `${project}/${service}` : name,
					password: creds.password,
					hasPassword: !!creds.password,
					sslMode: 'prefer',
					source,
					alternates,
					notes,
					reachable
				});
			} else {
				for (const cand of extractCandidates(vars, { label: project && service ? `${project}/${service}` : name, source })) {
					const host = cand.host.toLowerCase();
					const target = (project && servers.get(`${project}::${host}`)) || servers.get(host);
					if (target?.length) {
						const { primary, alternates, reachable } = await pickReachable(target);
						cand.alternates = uniqueAddresses([{ host: cand.host, port: cand.port, label: 'as configured' }, ...alternates]).filter(
							(a) => a.host !== primary.host || a.port !== primary.port
						);
						cand.host = primary.host;
						cand.port = primary.port;
						cand.reachable = reachable;
						cand.fingerprint = fingerprint(cand);
					} else {
						await settleAddress(cand);
					}
					push(group, status, cand);
				}
			}
		}
	}
	const used = new Set<string>();
	for (const c of details) {
		const vars = envMap(c.config?.env ?? null);
		if (isServer(c) || extractCandidates(vars, { label: '', source: { kind: 'arcane' } }).length) used.add(c.id);
	}
	const skipped = details
		.filter((c) => !used.has(c.id))
		.map((c) => ({ name: nameOf(c), image: c.image, state: stateOf(c) }))
		.sort((a, b) => a.name.localeCompare(b.name));
	return { groups: [...out.values()], inspected: details.length, skipped };
}

/** Address for ports published on an environment's Docker host. */
function environmentHost(env: ArcaneEnvironment, managerUrl: string): string {
	const managerHost = new URL(managerUrl).hostname;
	try {
		const h = env.apiUrl ? new URL(env.apiUrl).hostname : '';
		// The local environment points at Arcane itself (often localhost); use the address we reach Arcane on.
		return !h || /^(localhost|127\.|0\.0\.0\.0|::1|\[::1\])/.test(h) ? managerHost : h;
	} catch {
		return managerHost;
	}
}

async function scanArcane(manager: Manager, apiKey: string): Promise<{ scan: ManagerScan; candidates: Candidate[] }> {
	const client = new ArcaneClient(manager.url, apiKey);
	const all: Candidate[] = [];
	const scan: ManagerScan = { manager, environments: [] };
	const environments = (await client.list<ArcaneEnvironment>('/environments')).filter((e) => e.enabled !== false);

	for (const env of environments) {
		const host = environmentHost(env, manager.url);
		const entry: ManagerScan['environments'][number] = { id: env.id, name: env.name ?? env.id, host, projects: [] };
		scan.environments.push(entry);
		// Running containers first: their ports and environment are what's actually deployed,
		// so they win over what a project's compose file says for the same service.
		let live: Awaited<ReturnType<typeof scanArcaneContainers>> | undefined;
		try {
			live = await scanArcaneContainers(client, manager, entry);
			entry.containersInspected = live.inspected;
			entry.skipped = live.skipped;
		} catch (err) {
			const message = (err as Error).message;
			entry.warning = /rejected the API key|403/.test(message)
				? 'Add containers:list and containers:read to the API key to also find databases that aren’t Arcane projects.'
				: `Container scan failed: ${message}`;
		}
		const liveNames = new Set(live?.groups.flatMap((g) => g.candidates.map((c) => c.name.toLowerCase())) ?? []);

		try {
			const projects = await client.list<ArcaneProject>(`/environments/${encodeURIComponent(env.id)}/projects`);
			entry.projectsRead = projects.length;
			await mapLimit(projects, 6, async (p) => {
				const base = `/environments/${encodeURIComponent(env.id)}/projects/${encodeURIComponent(p.id)}`;
				// Compose and .env content live on the /compose section (older versions return them on the project).
				const detail = await client.data<ArcaneProject>(`${base}/compose`).catch(() => client.data<ArcaneProject>(base));
				if (!detail.composeContent) return;
				const vars = parseDotenv(detail.envContent ?? '');
				const candidates = (
					await composeCandidates(detail.composeContent, {
						project: p.name,
						source: { kind: 'arcane', ref: `${manager.name} · ${entry.name} · ${p.name}` },
						vars,
						// Arcane keeps the project's env next to the compose file; other env_files aren't exposed.
						readEnvFile: async (path) => (/^(\.\/)?\.env$/.test(path) ? vars : {}),
						publishedHost: host,
						onParseError: (message) => (entry.parseErrors ??= []).push({ project: p.name, message })
					})
				).filter((c) => !liveNames.has(c.name.toLowerCase()));
				if (!candidates.length) return;
				const unique = candidates.filter((c, i) => candidates.findIndex((x) => x.fingerprint === c.fingerprint) === i);
				await Promise.all(unique.map(settleAddress));
				entry.projects.push({ id: p.id, name: p.name, status: p.status ?? detail.status ?? 'unknown', candidates: unique });
				all.push(...unique);
			});
		} catch (err) {
			entry.error = (err as Error).message;
		}

		const seen = new Set(entry.projects.flatMap((p) => p.candidates.map((c) => c.fingerprint)));
		for (const g of live?.groups ?? []) {
			const fresh = g.candidates.filter((c, i, arr) => !seen.has(c.fingerprint) && arr.findIndex((x) => x.fingerprint === c.fingerprint) === i);
			if (!fresh.length) continue;
			fresh.forEach((c) => seen.add(c.fingerprint));
			const existing = entry.projects.find((p) => p.name === g.project);
			if (existing) existing.candidates.push(...fresh);
			else entry.projects.push({ id: `container:${g.project}`, name: g.project, status: g.status, candidates: fresh });
			all.push(...fresh);
		}
		entry.projects.sort((a, b) => a.name.localeCompare(b.name));
	}
	return { scan, candidates: all };
}

export async function scanManagers(): Promise<{ scans: ManagerScan[]; candidates: Candidate[] }> {
	const results = await Promise.all(
		listManagers().map(async (manager) => {
			const apiKey = apiKeyFor(manager.id);
			if (!apiKey) return { scan: { manager, error: 'No API key configured', environments: [] }, candidates: [] };
			try {
				return await scanArcane(manager, apiKey);
			} catch (err) {
				return { scan: { manager, error: (err as Error).message, environments: [] }, candidates: [] };
			}
		})
	);
	return { scans: results.map((r) => r.scan), candidates: results.flatMap((r) => r.candidates) };
}

/** Checks a URL + key (or a saved manager's key) and reports how many environments it sees. */
export async function testManager(url: string, apiKey: string | undefined, id?: string) {
	const key = apiKey || (id ? apiKeyFor(id) : undefined);
	if (!key) return { ok: false as const, error: 'Enter an API key' };
	try {
		const envs = await new ArcaneClient(url, key).list<ArcaneEnvironment>('/environments');
		return { ok: true as const, environments: envs.length };
	} catch (err) {
		return { ok: false as const, error: (err as Error).message };
	}
}
