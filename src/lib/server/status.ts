/**
 * Up/down status of every connection for dashboards (GET /api/status…). Probes are
 * cached for 30 s and shared between concurrent requests, so a wall of widgets
 * refreshing every few seconds doesn't hammer the databases.
 */
import { testConnection } from './engine.ts';
import * as pg from './pg.ts';
import * as my from './mysql/client.ts';
import { getConnection, listConnections } from './store.ts';
import type { Connection } from '#lib/types.ts';

export const STATUS_TTL_MS = 30_000;

export interface StatusItem {
	id: string;
	name: string;
	engine: string;
	flavor: string | null;
	status: 'up' | 'down';
	latencyMs: number | null;
	sizeBytes: number | null;
	version: string | null;
	lastCheckedAt: string;
	/** Short error code when down (e.g. ECONNREFUSED, 28P01); never the full message, which can name hosts. */
	error?: string;
	/** Only for tokens created with "include addresses". */
	host?: string;
	port?: number;
	database?: string;
}

export interface StatusSummary {
	connections: number;
	online: number;
	offline: number;
	checkedAt: string;
	items: StatusItem[];
}

type Probe = Omit<StatusItem, 'host' | 'port' | 'database'>;

const cache = new Map<string, { at: number; version: string; probe: Promise<Probe> }>();

async function sizeOf(conn: Connection): Promise<number | null> {
	try {
		if (conn.engine === 'postgres') {
			const [r] = await pg.readQuery<{ n: string }>(conn.id, 'select pg_database_size(current_database()) as n', [], 5000);
			return r ? Number(r.n) : null;
		}
		if (conn.engine === 'mysql') {
			const [r] = await my.readQuery<{ n: unknown }>(
				conn.id,
				`SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = COALESCE(DATABASE(), '')`,
				[],
				5000
			);
			return r ? Number(r.n) : null;
		}
	} catch {}
	return null;
}

async function probe(conn: Connection): Promise<Probe> {
	const base = { id: conn.id, name: conn.name, engine: conn.engine as string, flavor: conn.flavor };
	try {
		const r = await testConnection(conn.id);
		const at = new Date().toISOString();
		if (!r.ok) return { ...base, status: 'down', latencyMs: null, sizeBytes: null, version: null, lastCheckedAt: at, error: r.error.code ?? r.error.sqlState ?? 'error' };
		return { ...base, flavor: r.flavor, status: 'up', latencyMs: r.latencyMs, sizeBytes: await sizeOf(conn), version: r.serverVersion, lastCheckedAt: at };
	} catch (err) {
		const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : 'error';
		return { ...base, status: 'down', latencyMs: null, sizeBytes: null, version: null, lastCheckedAt: new Date().toISOString(), error: code };
	}
}

/** A cached probe of one connection (re-probed when older than the TTL or the connection was edited). */
function cachedProbe(conn: Connection): Promise<Probe> {
	const hit = cache.get(conn.id);
	if (hit && hit.version === conn.updatedAt && Date.now() - hit.at < STATUS_TTL_MS) return hit.probe;
	const p = probe(conn);
	cache.set(conn.id, { at: Date.now(), version: conn.updatedAt, probe: p });
	return p;
}

function present(conn: Connection, p: Probe, includeAddresses: boolean): StatusItem {
	return includeAddresses ? { ...p, host: conn.host, port: conn.port, database: conn.database } : { ...p };
}

export async function connectionStatus(id: string, opts: { includeAddresses: boolean }): Promise<StatusItem | null> {
	const conn = getConnection(id);
	if (!conn) return null;
	return present(conn, await cachedProbe(conn), opts.includeAddresses);
}

export async function statusSummary(opts: { includeAddresses: boolean }): Promise<StatusSummary> {
	const conns = listConnections();
	for (const id of cache.keys()) if (!conns.some((c) => c.id === id)) cache.delete(id);
	const items = await Promise.all(conns.map(async (c) => present(c, await cachedProbe(c), opts.includeAddresses)));
	const online = items.filter((i) => i.status === 'up').length;
	return { connections: items.length, online, offline: items.length - online, checkedAt: new Date().toISOString(), items };
}

// --- badge ------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Rough Verdana 11px advance, as shields.io-style badges are sized. */
const textWidth = (s: string) => Math.ceil([...s].reduce((w, c) => w + (/[iljI.,:;'|! ]/.test(c) ? 3.5 : /[mwMW@]/.test(c) ? 9.5 : /[A-Z0-9]/.test(c) ? 7.5 : 6.5), 0));

/** A shields.io-style flat badge: `name | up 3 ms` (green) or `name | down` (red). */
export function statusBadge(label: string, item: Pick<StatusItem, 'status' | 'latencyMs'> | null): string {
	const value = !item ? 'unknown' : item.status === 'up' ? `up${item.latencyMs != null ? ` ${item.latencyMs} ms` : ''}` : 'down';
	const color = !item ? '#9f9f9f' : item.status === 'up' ? '#3fb950' : '#e5534b';
	const lw = textWidth(label) + 12;
	const vw = textWidth(value) + 12;
	const w = lw + vw;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}"><title>${esc(label)}: ${esc(value)}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text></g></svg>`;
}
