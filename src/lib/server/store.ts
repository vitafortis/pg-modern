import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.ts';
import { decrypt, encrypt } from './crypto.ts';
import type { Connection, ConnectionInput, HistoryEntry, Settings } from '#lib/types.ts';

let handle: DatabaseSync | undefined;

/** Opens the store on first use, so importing this module (e.g. during build) has no side effects. */
function db(): DatabaseSync {
	if (handle) return handle;
	mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
	const dbPath = join(config.dataDir, 'pg-modern.db');
	handle = new DatabaseSync(dbPath);
	try {
		chmodSync(dbPath, 0o600);
	} catch {
		// Best effort — some mounted volumes don't support chmod.
	}
	handle.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA foreign_keys = ON;

		CREATE TABLE IF NOT EXISTS connections (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			host TEXT NOT NULL,
			port INTEGER NOT NULL,
			database TEXT NOT NULL,
			user TEXT NOT NULL,
			secret TEXT,
			ssl_mode TEXT NOT NULL DEFAULT 'prefer',
			read_only INTEGER NOT NULL DEFAULT 1,
			color TEXT NOT NULL DEFAULT 'violet',
			source_kind TEXT NOT NULL DEFAULT 'manual',
			source_ref TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			last_connected_at TEXT
		);

		CREATE TABLE IF NOT EXISTS sessions (
			token_hash TEXT PRIMARY KEY,
			expires_at INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS kv (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
			sql TEXT NOT NULL,
			ok INTEGER NOT NULL,
			row_count INTEGER,
			duration_ms INTEGER NOT NULL,
			error TEXT,
			created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS history_conn ON history(connection_id, id DESC);
	`);
	return handle;
}

type Row = Record<string, unknown>;

function toConnection(r: Row): Connection {
	return {
		id: r.id as string,
		name: r.name as string,
		host: r.host as string,
		port: r.port as number,
		database: r.database as string,
		user: r.user as string,
		hasPassword: r.secret != null,
		sslMode: r.ssl_mode as Connection['sslMode'],
		readOnly: r.read_only === 1,
		color: r.color as string,
		source: { kind: r.source_kind as Connection['source']['kind'], ref: (r.source_ref as string) ?? undefined },
		createdAt: r.created_at as string,
		updatedAt: r.updated_at as string,
		lastConnectedAt: (r.last_connected_at as string) ?? null
	};
}

// --- connections -----------------------------------------------------------

export function listConnections(): Connection[] {
	return (db().prepare('SELECT * FROM connections ORDER BY name COLLATE NOCASE').all() as Row[]).map(toConnection);
}

export function getConnection(id: string): Connection | undefined {
	const row = db().prepare('SELECT * FROM connections WHERE id = ?').get(id) as Row | undefined;
	return row && toConnection(row);
}

export function getPassword(id: string): string | undefined {
	const row = db().prepare('SELECT secret FROM connections WHERE id = ?').get(id) as Row | undefined;
	if (!row?.secret) return undefined;
	return JSON.parse(decrypt(row.secret as string, `connection:${id}`)).password;
}

function sealPassword(id: string, password: string | undefined): string | null {
	return password ? encrypt(JSON.stringify({ password }), `connection:${id}`) : null;
}

export function createConnection(input: ConnectionInput): Connection {
	const id = randomUUID();
	const now = new Date().toISOString();
	db().prepare(
		`INSERT INTO connections (id, name, host, port, database, user, secret, ssl_mode, read_only, color, source_kind, source_ref, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		id,
		input.name,
		input.host,
		input.port,
		input.database,
		input.user,
		sealPassword(id, input.password),
		input.sslMode,
		input.readOnly ? 1 : 0,
		input.color ?? 'violet',
		input.source?.kind ?? 'manual',
		input.source?.ref ?? null,
		now,
		now
	);
	return getConnection(id)!;
}

export function updateConnection(id: string, input: ConnectionInput): Connection | undefined {
	const existing = getConnection(id);
	if (!existing) return undefined;
	db().prepare(
		`UPDATE connections SET name = ?, host = ?, port = ?, database = ?, user = ?, ssl_mode = ?, read_only = ?, color = ?, updated_at = ? WHERE id = ?`
	).run(
		input.name,
		input.host,
		input.port,
		input.database,
		input.user,
		input.sslMode,
		input.readOnly ? 1 : 0,
		input.color ?? existing.color,
		new Date().toISOString(),
		id
	);
	if (input.password !== undefined) {
		db().prepare('UPDATE connections SET secret = ? WHERE id = ?').run(sealPassword(id, input.password), id);
	}
	return getConnection(id);
}

export function deleteConnection(id: string): boolean {
	return Number(db().prepare('DELETE FROM connections WHERE id = ?').run(id).changes) > 0;
}

export function touchConnection(id: string) {
	db().prepare('UPDATE connections SET last_connected_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

// --- settings ----------------------------------------------------------------

function getKv<T>(key: string, fallback: T): T {
	const row = db().prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined;
	return row ? (JSON.parse(row.value as string) as T) : fallback;
}

function setKv(key: string, value: unknown) {
	db().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
		key,
		JSON.stringify(value)
	);
}

export function getSettings(): Settings {
	return getKv<Settings>('settings', { scanPaths: [], dockerHosts: [] });
}

export function saveSettings(settings: Settings) {
	setKv('settings', settings);
}

export function getAdminPasswordHash(): string | undefined {
	return getKv<string | undefined>('admin_password', undefined);
}

export function setAdminPasswordHash(hash: string) {
	setKv('admin_password', hash);
}

// --- sessions ----------------------------------------------------------------

export function createSession(tokenHash: string, ttlMs: number) {
	db().prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
	db().prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)').run(tokenHash, Date.now() + ttlMs);
}

export function sessionValid(tokenHash: string): boolean {
	const row = db().prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(tokenHash) as Row | undefined;
	return !!row && (row.expires_at as number) > Date.now();
}

export function deleteSession(tokenHash: string) {
	db().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

export function deleteAllSessions() {
	db().prepare('DELETE FROM sessions').run();
}

// --- history -----------------------------------------------------------------

export function addHistory(entry: Omit<HistoryEntry, 'id' | 'createdAt'>) {
	db().prepare(
		'INSERT INTO history (connection_id, sql, ok, row_count, duration_ms, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
	).run(
		entry.connectionId,
		entry.sql,
		entry.ok ? 1 : 0,
		entry.rowCount,
		Math.round(entry.durationMs),
		entry.error,
		new Date().toISOString()
	);
	// Keep the most recent 500 entries per connection.
	db().prepare(
		`DELETE FROM history WHERE connection_id = ? AND id NOT IN (
			SELECT id FROM history WHERE connection_id = ? ORDER BY id DESC LIMIT 500)`
	).run(entry.connectionId, entry.connectionId);
}

export function listHistory(connectionId: string, limit = 100): HistoryEntry[] {
	return (
		db()
			.prepare('SELECT * FROM history WHERE connection_id = ? ORDER BY id DESC LIMIT ?')
			.all(connectionId, limit) as Row[]
	).map((r) => ({
		id: r.id as number,
		connectionId: r.connection_id as string,
		sql: r.sql as string,
		ok: r.ok === 1,
		rowCount: (r.row_count as number) ?? null,
		durationMs: r.duration_ms as number,
		error: (r.error as string) ?? null,
		createdAt: r.created_at as string
	}));
}

export function clearHistory(connectionId: string) {
	db().prepare('DELETE FROM history WHERE connection_id = ?').run(connectionId);
}
