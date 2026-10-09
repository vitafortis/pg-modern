/**
 * Schema snapshots: storing captures, the auto-snapshot check, and resolving the two
 * sides of a comparison (a stored snapshot or the live schema, of this connection or
 * another one on the same engine).
 */
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { BadRequest } from './http.ts';
import { NotFound } from './pg.ts';
import { canSee } from './permissions.ts';
import { getConnection, sqlite } from './store.ts';
import { captureSchema, schemaHash } from './schema-capture.ts';
import { snapshotStats, type DiffSource, type SchemaSnapshotData, type SchemaSnapshotMeta } from '#lib/schema/model.ts';
import type { User } from '#lib/types.ts';

/** Largest snapshot kept (uncompressed JSON). Bodies are dropped first to fit. */
export const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
/** Snapshots kept per connection; older ones are pruned. */
export const KEEP_PER_CONNECTION = 50;

type Row = Record<string, unknown>;

export type StoredMeta = SchemaSnapshotMeta & { createdById: string | null };

function toMeta(r: Row): StoredMeta {
	return {
		createdById: (r.created_by as string) ?? null,
		id: r.id as string,
		connectionId: r.connection_id as string,
		engine: r.engine as string,
		label: r.label as string,
		note: (r.note as string) ?? null,
		auto: r.auto === 1,
		hash: r.hash as string,
		sizeBytes: r.size_bytes as number,
		stats: JSON.parse(r.stats as string),
		createdBy: (r.created_by_email as string) ?? null,
		createdAt: r.created_at as string
	};
}

const META_COLUMNS = 'id, connection_id, engine, label, note, auto, hash, size_bytes, stats, created_by, created_by_email, created_at';

export function listSnapshots(connectionId: string): StoredMeta[] {
	return (
		sqlite()
			.prepare(`SELECT ${META_COLUMNS} FROM schema_snapshots WHERE connection_id = ? ORDER BY created_at DESC, rowid DESC`)
			.all(connectionId) as Row[]
	).map(toMeta);
}

export function getSnapshotMeta(id: string): StoredMeta | undefined {
	const r = sqlite().prepare(`SELECT ${META_COLUMNS} FROM schema_snapshots WHERE id = ?`).get(id) as Row | undefined;
	return r && toMeta(r);
}

/** What the browser gets: no internal user id, plus whether this user may delete it. */
export function publicMeta(user: User, { createdById, ...meta }: StoredMeta): SchemaSnapshotMeta {
	return { ...meta, canDelete: canDeleteSnapshot(user, { createdById }) };
}

export function getSnapshotData(id: string): SchemaSnapshotData | undefined {
	const r = sqlite().prepare('SELECT data FROM schema_snapshots WHERE id = ?').get(id) as { data: Uint8Array } | undefined;
	return r && JSON.parse(gunzipSync(r.data).toString('utf8'));
}

export function latestSnapshot(connectionId: string): StoredMeta | undefined {
	const r = sqlite()
		.prepare(`SELECT ${META_COLUMNS} FROM schema_snapshots WHERE connection_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
		.get(connectionId) as Row | undefined;
	return r && toMeta(r);
}

export function deleteSnapshot(id: string): boolean {
	return Number(sqlite().prepare('DELETE FROM schema_snapshots WHERE id = ?').run(id).changes) > 0;
}

/**
 * Serializes a capture within the size cap: if the JSON is too big, routine bodies are
 * dropped (their hashes stay, so changes are still detected); if it's still too big,
 * the snapshot is refused.
 */
export function encodeSnapshot(data: SchemaSnapshotData, max = MAX_SNAPSHOT_BYTES): { json: string; data: SchemaSnapshotData } {
	let json = JSON.stringify(data);
	if (Buffer.byteLength(json) <= max) return { json, data };
	const slim: SchemaSnapshotData = { ...data, bodiesOmitted: true, routines: data.routines.map((r) => ({ ...r, body: null })) };
	json = JSON.stringify(slim);
	if (Buffer.byteLength(json) <= max) return { json, data: slim };
	throw new BadRequest(`The schema is too large to snapshot (${(Buffer.byteLength(json) / 1048576).toFixed(1)} MB, limit ${max / 1048576} MB)`);
}

export function saveSnapshot(
	connectionId: string,
	data: SchemaSnapshotData,
	opts: { label: string; note?: string | null; auto?: boolean; user?: Pick<User, 'id' | 'email'> | null; hash?: string }
): StoredMeta {
	const { json, data: stored } = encodeSnapshot(data);
	const id = randomUUID();
	const h = sqlite();
	h.prepare(
		`INSERT INTO schema_snapshots (id, connection_id, engine, label, note, auto, hash, size_bytes, stats, data, created_by, created_by_email, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		id,
		connectionId,
		stored.engine,
		opts.label,
		opts.note ?? null,
		opts.auto ? 1 : 0,
		opts.hash ?? schemaHash(stored),
		Buffer.byteLength(json),
		JSON.stringify(snapshotStats(stored)),
		gzipSync(json),
		opts.user?.id ?? null,
		opts.user?.email ?? null,
		new Date().toISOString()
	);
	h.prepare(
		`DELETE FROM schema_snapshots WHERE connection_id = ? AND id NOT IN (
			SELECT id FROM schema_snapshots WHERE connection_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`
	).run(connectionId, connectionId, KEEP_PER_CONNECTION);
	return getSnapshotMeta(id)!;
}

// --- auto snapshots ------------------------------------------------------------------

export interface AutoSettings {
	auto: boolean;
	lastCheckedAt: string | null;
	lastError: string | null;
}

export function getAutoSettings(connectionId: string): AutoSettings {
	const r = sqlite().prepare('SELECT * FROM schema_snapshot_settings WHERE connection_id = ?').get(connectionId) as Row | undefined;
	return { auto: r?.auto === 1, lastCheckedAt: (r?.last_checked_at as string) ?? null, lastError: (r?.last_error as string) ?? null };
}

export function setAutoSnapshot(connectionId: string, auto: boolean) {
	sqlite()
		.prepare(
			`INSERT INTO schema_snapshot_settings (connection_id, auto) VALUES (?, ?)
			 ON CONFLICT(connection_id) DO UPDATE SET auto = excluded.auto`
		)
		.run(connectionId, auto ? 1 : 0);
}

export function autoSnapshotConnections(): string[] {
	return (sqlite().prepare('SELECT connection_id FROM schema_snapshot_settings WHERE auto = 1').all() as { connection_id: string }[]).map((r) => r.connection_id);
}

function recordCheck(connectionId: string, error: string | null) {
	sqlite()
		.prepare(
			`INSERT INTO schema_snapshot_settings (connection_id, auto, last_checked_at, last_error) VALUES (?, 0, ?, ?)
			 ON CONFLICT(connection_id) DO UPDATE SET last_checked_at = excluded.last_checked_at, last_error = excluded.last_error`
		)
		.run(connectionId, new Date().toISOString(), error);
}

export type CheckOutcome = { changed: false; hash: string } | { changed: true; hash: string; snapshot: StoredMeta };

/**
 * Captures the schema and stores an auto snapshot if its hash differs from the latest
 * snapshot's (or there is none yet). Nothing is written when the schema is unchanged.
 */
export async function checkForChanges(connectionId: string): Promise<CheckOutcome> {
	try {
		const data = await captureSchema(connectionId);
		const hash = schemaHash(data);
		const latest = latestSnapshot(connectionId);
		recordCheck(connectionId, null);
		if (latest?.hash === hash) return { changed: false, hash };
		const snapshot = saveSnapshot(connectionId, data, {
			label: latest ? 'Schema changed' : 'Baseline',
			note: latest ? `Detected by the scheduled check (previous: ${latest.label}, ${latest.createdAt.slice(0, 16).replace('T', ' ')} UTC)` : 'First automatic snapshot',
			auto: true,
			hash
		});
		return { changed: true, hash, snapshot };
	} catch (err) {
		recordCheck(connectionId, (err as Error).message ?? String(err));
		throw err;
	}
}

// --- comparing ------------------------------------------------------------------------

/** Live captures are reused briefly, so flipping between comparisons doesn't re-read the catalog. */
const liveCache = new Map<string, { at: number; data: SchemaSnapshotData }>();
const LIVE_TTL_MS = 15_000;

export async function liveSchema(connectionId: string, fresh = false): Promise<SchemaSnapshotData> {
	const hit = liveCache.get(connectionId);
	if (!fresh && hit && Date.now() - hit.at < LIVE_TTL_MS) return hit.data;
	const data = await captureSchema(connectionId);
	liveCache.set(connectionId, { at: Date.now(), data });
	return data;
}

export function parseSource(v: unknown): DiffSource {
	if (!v || typeof v !== 'object') throw new BadRequest('Each side needs a source');
	const s = v as Record<string, unknown>;
	if (typeof s.connectionId !== 'string') throw new BadRequest('"connectionId" is required');
	if (s.kind === 'live') return { kind: 'live', connectionId: s.connectionId };
	if (s.kind === 'snapshot' && typeof s.snapshotId === 'string') return { kind: 'snapshot', connectionId: s.connectionId, snapshotId: s.snapshotId };
	throw new BadRequest('"kind" must be live or snapshot');
}

export interface ResolvedSide {
	source: DiffSource;
	connectionName: string;
	engine: string;
	label: string;
	at: string;
	data: SchemaSnapshotData;
}

/** Loads one side of a comparison, checking the user can see its connection. */
export async function resolveSource(user: User, src: DiffSource): Promise<ResolvedSide> {
	const conn = getConnection(src.connectionId);
	if (!conn || !canSee(user, conn)) throw new NotFound('Connection not found');
	if (src.kind === 'live') {
		const data = await liveSchema(conn.id);
		return { source: src, connectionName: conn.name, engine: conn.engine, label: 'Live schema', at: new Date().toISOString(), data };
	}
	const meta = getSnapshotMeta(src.snapshotId);
	if (!meta || meta.connectionId !== conn.id) throw new NotFound('Snapshot not found');
	return { source: src, connectionName: conn.name, engine: meta.engine, label: meta.label, at: meta.createdAt, data: getSnapshotData(meta.id)! };
}

export function canDeleteSnapshot(user: User, meta: { createdById: string | null }): boolean {
	return user.role === 'admin' || (!!meta.createdById && meta.createdById === user.id);
}
