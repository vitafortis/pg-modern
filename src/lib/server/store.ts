import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.ts';
import { decrypt, encrypt } from './crypto.ts';
import type { Connection, ConnectionInput, HistoryEntry, Role, Settings, User } from '#lib/types.ts';

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

		CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL UNIQUE COLLATE NOCASE,
			name TEXT,
			role TEXT NOT NULL DEFAULT 'viewer',
			password_hash TEXT,
			oidc_sub TEXT UNIQUE,
			disabled INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			last_login_at TEXT
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
	migrate(handle);
	return handle;
}

function migrate(h: DatabaseSync) {
	// v1 sessions weren't tied to a user; drop them (everyone signs in again once).
	const cols = h.prepare(`SELECT name FROM pragma_table_info('sessions')`).all() as { name: string }[];
	if (cols.length && !cols.some((c) => c.name === 'user_id')) h.exec('DROP TABLE sessions');
	h.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			token_hash TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			expires_at INTEGER NOT NULL
		);
	`);

	// v1 had a single admin password; it becomes the local user "admin".
	const legacy = h.prepare(`SELECT value FROM kv WHERE key = 'admin_password'`).get() as Row | undefined;
	const hasUsers = (h.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n > 0;
	if (legacy && !hasUsers) {
		h.prepare(
			`INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, 'admin', 'Admin', 'admin', ?, ?)`
		).run(randomUUID(), JSON.parse(legacy.value as string), new Date().toISOString());
	}
	if (legacy) h.prepare(`DELETE FROM kv WHERE key = 'admin_password'`).run();
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
	return { managers: [], ...getKv<Settings>('settings', { scanPaths: [], dockerHosts: [] }) };
}

/** Manager API keys are encrypted like connection passwords, bound to the manager id. */
export function setManagerKey(id: string, apiKey: string | null) {
	if (apiKey) setKv(`manager-key:${id}`, encrypt(apiKey, `manager:${id}`));
	else db().prepare('DELETE FROM kv WHERE key = ?').run(`manager-key:${id}`);
}

export function getManagerKey(id: string): string | undefined {
	const sealed = getKv<string | undefined>(`manager-key:${id}`, undefined);
	return sealed ? decrypt(sealed, `manager:${id}`) : undefined;
}

export function saveSettings(settings: Settings) {
	setKv('settings', settings);
}

// --- users -------------------------------------------------------------------

function toUser(r: Row): User {
	return {
		id: r.id as string,
		email: r.email as string,
		name: (r.name as string) ?? null,
		role: r.role as Role,
		hasPassword: r.password_hash != null,
		sso: r.oidc_sub != null,
		disabled: r.disabled === 1,
		createdAt: r.created_at as string,
		lastLoginAt: (r.last_login_at as string) ?? null
	};
}

export function countUsers(): number {
	return (db().prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
}

export function countAdmins(): number {
	return (db().prepare(`SELECT count(*) AS n FROM users WHERE role = 'admin' AND disabled = 0`).get() as { n: number }).n;
}

export function listUsers(): User[] {
	return (db().prepare('SELECT * FROM users ORDER BY email').all() as Row[]).map(toUser);
}

export function getUser(id: string): User | undefined {
	const row = db().prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
	return row && toUser(row);
}

export function findUserByEmail(email: string): User | undefined {
	const row = db().prepare('SELECT * FROM users WHERE email = ?').get(email.trim()) as Row | undefined;
	return row && toUser(row);
}

export function findUserBySub(sub: string): User | undefined {
	const row = db().prepare('SELECT * FROM users WHERE oidc_sub = ?').get(sub) as Row | undefined;
	return row && toUser(row);
}

export function getPasswordHash(userId: string): string | undefined {
	const row = db().prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as Row | undefined;
	return (row?.password_hash as string) ?? undefined;
}

export function createUser(input: { email: string; name?: string | null; role: Role; passwordHash?: string; oidcSub?: string }): User {
	const id = randomUUID();
	db()
		.prepare('INSERT INTO users (id, email, name, role, password_hash, oidc_sub, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
		.run(id, input.email.trim(), input.name ?? null, input.role, input.passwordHash ?? null, input.oidcSub ?? null, new Date().toISOString());
	return getUser(id)!;
}

export function updateUser(id: string, patch: { role?: Role; disabled?: boolean; name?: string | null; passwordHash?: string | null; oidcSub?: string }) {
	const sets: string[] = [];
	const values: (string | number | null)[] = [];
	if (patch.role !== undefined) sets.push('role = ?'), values.push(patch.role);
	if (patch.disabled !== undefined) sets.push('disabled = ?'), values.push(patch.disabled ? 1 : 0);
	if (patch.name !== undefined) sets.push('name = ?'), values.push(patch.name);
	if (patch.passwordHash !== undefined) sets.push('password_hash = ?'), values.push(patch.passwordHash);
	if (patch.oidcSub !== undefined) sets.push('oidc_sub = ?'), values.push(patch.oidcSub);
	if (!sets.length) return getUser(id);
	db().prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
	if (patch.disabled || patch.role) deleteUserSessions(id); // take effect immediately
	return getUser(id);
}

export function touchUserLogin(id: string) {
	db().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

export function deleteUser(id: string): boolean {
	return Number(db().prepare('DELETE FROM users WHERE id = ?').run(id).changes) > 0;
}

// --- sessions ----------------------------------------------------------------

export function createSession(tokenHash: string, userId: string, ttlMs: number) {
	db().prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
	db().prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash, userId, Date.now() + ttlMs);
}

/** The signed-in user for a session token, if the session is live and the user enabled. */
export function sessionUser(tokenHash: string): User | undefined {
	const row = db()
		.prepare(
			`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
			 WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`
		)
		.get(tokenHash, Date.now()) as Row | undefined;
	return row && toUser(row);
}

export function deleteSession(tokenHash: string) {
	db().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

export function deleteUserSessions(userId: string) {
	db().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
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
