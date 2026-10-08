import { config } from '../config.ts';
import { getManagerKey, getSettings } from '../store.ts';
import { composeCandidates } from './compose.ts';
import { parseDotenv } from './env.ts';
import { mapLimit, probe } from './probe.ts';
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
		const limit = 100;
		for (let start = 0; start < 10_000; start += limit) {
			const sep = path.includes('?') ? '&' : '?';
			const body = await this.get<{ data?: T[]; pagination?: { totalItems?: number } }>(`${path}${sep}start=${start}&limit=${limit}`);
			const page = Array.isArray(body) ? (body as T[]) : (body.data ?? []);
			out.push(...page);
			const total = body.pagination?.totalItems;
			if (page.length < limit || (total !== undefined && out.length >= total)) break;
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
		try {
			const projects = await client.list<ArcaneProject>(`/environments/${encodeURIComponent(env.id)}/projects`);
			await mapLimit(projects, 6, async (p) => {
				const base = `/environments/${encodeURIComponent(env.id)}/projects/${encodeURIComponent(p.id)}`;
				// Compose and .env content live on the /compose section (older versions return them on the project).
				const detail = await client.data<ArcaneProject>(`${base}/compose`).catch(() => client.data<ArcaneProject>(base));
				if (!detail.composeContent) return;
				const vars = parseDotenv(detail.envContent ?? '');
				const candidates = await composeCandidates(detail.composeContent, {
					project: p.name,
					source: { kind: 'arcane', ref: `${manager.name} · ${entry.name} · ${p.name}` },
					vars,
					// Arcane keeps the project's env next to the compose file; other env_files aren't exposed.
					readEnvFile: async (path) => (/^(\.\/)?\.env$/.test(path) ? vars : {}),
					publishedHost: host
				});
				if (!candidates.length) return;
				const unique = candidates.filter((c, i) => candidates.findIndex((x) => x.fingerprint === c.fingerprint) === i);
				await Promise.all(unique.map(async (c) => (c.reachable = await probe(c.host, c.port))));
				entry.projects.push({ id: p.id, name: p.name, status: p.status ?? detail.status ?? 'unknown', candidates: unique });
				all.push(...unique);
			});
			entry.projects.sort((a, b) => a.name.localeCompare(b.name));
		} catch (err) {
			entry.error = (err as Error).message;
		}
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
