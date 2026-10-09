import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.ts';
import { decrypt, encrypt } from './crypto.ts';
import type { AuditEvent, Connection, ConnectionInput, Grant, HistoryEntry, Role, Settings, User } from '#lib/types.ts';
import type { SavedQuery } from '#lib/types.ts';

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
	migrateSavedQueries(handle);
	migrateAlerts(handle);
	migrateSizeHistory(handle);
	migrateSchemaSnapshots(handle);
	migrateApiTokens(handle);
	migrateBackups(handle);
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

	const userCols = h.prepare(`SELECT name FROM pragma_table_info('users')`).all() as { name: string }[];
	if (!userCols.some((c) => c.name === 'needs_profile')) {
		h.exec('ALTER TABLE users ADD COLUMN needs_profile INTEGER NOT NULL DEFAULT 0');
	}
	// One-time backfill (tracked in kv, independent of when the column appeared): accounts
	// created before this flag existed, like an earlier upgrade's "admin", have no real
	// email yet, so ask them for one on their next sign-in.
	const backfilled = h.prepare(`SELECT 1 FROM kv WHERE key = 'migration:needs-profile'`).get();
	if (!backfilled) {
		h.exec(`UPDATE users SET needs_profile = 1 WHERE email NOT LIKE '%@%' AND oidc_sub IS NULL`);
		h.prepare(`INSERT INTO kv (key, value) VALUES ('migration:needs-profile', 'true')`).run();
	}

	if (!userCols.some((c) => c.name === 'connection_access')) {
		h.exec(`ALTER TABLE users ADD COLUMN connection_access TEXT NOT NULL DEFAULT 'all'`);
	}
	const connCols = h.prepare(`SELECT name FROM pragma_table_info('connections')`).all() as { name: string }[];
	if (!connCols.some((c) => c.name === 'engine')) {
		h.exec(`ALTER TABLE connections ADD COLUMN engine TEXT NOT NULL DEFAULT 'postgres'`);
	}
	if (!connCols.some((c) => c.name === 'flavor')) {
		// MariaDB vs MySQL, learned from the server's version string.
		h.exec(`ALTER TABLE connections ADD COLUMN flavor TEXT`);
	}
	const historyCols = h.prepare(`SELECT name FROM pragma_table_info('history')`).all() as { name: string }[];
	if (!historyCols.some((c) => c.name === 'user_id')) {
		h.exec(`
			ALTER TABLE history ADD COLUMN user_id TEXT;
			ALTER TABLE history ADD COLUMN user_email TEXT;
			ALTER TABLE history ADD COLUMN read_only INTEGER NOT NULL DEFAULT 1;
		`);
	}
	h.exec(`
		CREATE INDEX IF NOT EXISTS history_time ON history(id DESC);

		-- Per-connection access for users whose connection_access is 'selected',
		-- and write permission for any non-admin.
		CREATE TABLE IF NOT EXISTS grants (
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
			can_write INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (user_id, connection_id)
		);

		-- Temporary write access to a read-only connection.
		CREATE TABLE IF NOT EXISTS write_unlocks (
			user_id TEXT NOT NULL,
			connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
			expires_at INTEGER NOT NULL,
			reason TEXT,
			PRIMARY KEY (user_id, connection_id)
		);

		-- Who changed what. Connection/user names are copied so entries outlive them.
		CREATE TABLE IF NOT EXISTS audit (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			at TEXT NOT NULL,
			user_id TEXT,
			user_email TEXT,
			action TEXT NOT NULL,
			connection_id TEXT,
			connection_name TEXT,
			detail TEXT,
			ip TEXT
		);
		CREATE INDEX IF NOT EXISTS audit_time ON audit(id DESC);
	`);

	// v1 had a single admin password; it becomes the local user "admin", who is
	// asked for a real email and name on their next sign-in.
	const legacy = h.prepare(`SELECT value FROM kv WHERE key = 'admin_password'`).get() as Row | undefined;
	const hasUsers = (h.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n > 0;
	if (legacy && !hasUsers) {
		h.prepare(
			`INSERT INTO users (id, email, name, role, password_hash, needs_profile, created_at) VALUES (?, 'admin', 'Admin', 'admin', ?, 1, ?)`
		).run(randomUUID(), JSON.parse(legacy.value as string), new Date().toISOString());
	}
	if (legacy) h.prepare(`DELETE FROM kv WHERE key = 'admin_password'`).run();
}

type Row = Record<string, unknown>;

function toConnection(r: Row): Connection {
	return {
		id: r.id as string,
		engine: r.engine === 'mysql' ? 'mysql' : 'postgres',
		flavor: (r.flavor as Connection['flavor']) ?? null,
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

export function createConnection(input: ConnectionInput, flavor?: Connection['flavor']): Connection {
	const id = randomUUID();
	const now = new Date().toISOString();
	db().prepare(
		`INSERT INTO connections (id, name, host, port, database, user, secret, ssl_mode, read_only, color, source_kind, source_ref, created_at, updated_at, engine, flavor)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
		now,
		input.engine ?? 'postgres',
		flavor ?? null
	);
	return getConnection(id)!;
}

export function updateConnection(id: string, input: ConnectionInput): Connection | undefined {
	const existing = getConnection(id);
	if (!existing) return undefined;
	db().prepare(
		`UPDATE connections SET name = ?, host = ?, port = ?, database = ?, user = ?, ssl_mode = ?, read_only = ?, color = ?, updated_at = ?, engine = ?,
			flavor = CASE WHEN engine = ? THEN flavor END WHERE id = ?`
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
		input.engine ?? existing.engine,
		input.engine ?? existing.engine,
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

/** Records MariaDB vs MySQL once a server has told us; doesn't count as an edit (pools stay open). */
export function setFlavor(id: string, flavor: Connection['flavor']) {
	db().prepare('UPDATE connections SET flavor = ? WHERE id = ? AND flavor IS NOT ?').run(flavor, id, flavor);
}

export function touchConnection(id: string) {
	db().prepare('UPDATE connections SET last_connected_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

// --- settings ----------------------------------------------------------------

export function getKv<T>(key: string, fallback: T): T {
	const row = db().prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined;
	return row ? (JSON.parse(row.value as string) as T) : fallback;
}

export function setKv(key: string, value: unknown) {
	db().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
		key,
		JSON.stringify(value)
	);
}

export function getSettings(): Settings {
	return { managers: [], ...getKv<Settings>('settings', { scanPaths: [], dockerHosts: [] }) };
}

/** Manager API keys are encrypted like connection passwords, bound to the manager id. */
export function deleteKv(key: string) {
	db().prepare('DELETE FROM kv WHERE key = ?').run(key);
}

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
		needsProfile: r.needs_profile === 1,
		connectionAccess: (r.connection_access as User['connectionAccess']) ?? 'all',
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

export function updateUser(
	id: string,
	patch: {
		role?: Role;
		disabled?: boolean;
		name?: string | null;
		email?: string;
		passwordHash?: string | null;
		oidcSub?: string;
		needsProfile?: boolean;
		connectionAccess?: User['connectionAccess'];
	}
) {
	const sets: string[] = [];
	const values: (string | number | null)[] = [];
	if (patch.role !== undefined) sets.push('role = ?'), values.push(patch.role);
	if (patch.disabled !== undefined) sets.push('disabled = ?'), values.push(patch.disabled ? 1 : 0);
	if (patch.name !== undefined) sets.push('name = ?'), values.push(patch.name);
	if (patch.passwordHash !== undefined) sets.push('password_hash = ?'), values.push(patch.passwordHash);
	if (patch.oidcSub !== undefined) sets.push('oidc_sub = ?'), values.push(patch.oidcSub);
	if (patch.email !== undefined) sets.push('email = ?'), values.push(patch.email.trim());
	if (patch.needsProfile !== undefined) sets.push('needs_profile = ?'), values.push(patch.needsProfile ? 1 : 0);
	if (patch.connectionAccess !== undefined) sets.push('connection_access = ?'), values.push(patch.connectionAccess);
	if (!sets.length) return getUser(id);
	db().prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
	if (patch.disabled || patch.role) deleteUserSessions(id); // take effect immediately
	return getUser(id);
}

/** An upgraded install's "admin" account that hasn't been given a real email yet. */
export function legacyAdminPending(): boolean {
	return !!db().prepare(`SELECT 1 FROM users WHERE needs_profile = 1 AND email = 'admin' AND disabled = 0`).get();
}

export function touchUserLogin(id: string) {
	db().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

export function deleteUser(id: string): boolean {
	db().prepare('DELETE FROM write_unlocks WHERE user_id = ?').run(id);
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

export function addHistory(entry: Omit<HistoryEntry, 'id' | 'createdAt' | 'connectionName'>) {
	db().prepare(
		`INSERT INTO history (connection_id, sql, ok, row_count, duration_ms, error, created_at, user_id, user_email, read_only)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		entry.connectionId,
		entry.sql,
		entry.ok ? 1 : 0,
		entry.rowCount,
		Math.round(entry.durationMs),
		entry.error,
		new Date().toISOString(),
		entry.userId,
		entry.userEmail,
		entry.readOnly ? 1 : 0
	);
	// Keep the most recent 2000 entries per connection.
	db().prepare(
		`DELETE FROM history WHERE connection_id = ? AND id NOT IN (
			SELECT id FROM history WHERE connection_id = ? ORDER BY id DESC LIMIT 2000)`
	).run(entry.connectionId, entry.connectionId);
}

function toHistory(r: Row): HistoryEntry {
	return {
		id: r.id as number,
		connectionId: r.connection_id as string,
		connectionName: (r.connection_name as string) ?? undefined,
		sql: r.sql as string,
		ok: r.ok === 1,
		rowCount: (r.row_count as number) ?? null,
		durationMs: r.duration_ms as number,
		error: (r.error as string) ?? null,
		createdAt: r.created_at as string,
		userId: (r.user_id as string) ?? null,
		userEmail: (r.user_email as string) ?? null,
		readOnly: r.read_only !== 0
	};
}

/** A connection's history; `userId` limits it to that user's own queries. */
export function listHistory(connectionId: string, limit = 100, userId?: string): HistoryEntry[] {
	const rows = userId
		? db().prepare('SELECT * FROM history WHERE connection_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?').all(connectionId, userId, limit)
		: db().prepare('SELECT * FROM history WHERE connection_id = ? ORDER BY id DESC LIMIT ?').all(connectionId, limit);
	return (rows as Row[]).map(toHistory);
}

export function clearHistory(connectionId: string, userId?: string) {
	if (userId) db().prepare('DELETE FROM history WHERE connection_id = ? AND user_id = ?').run(connectionId, userId);
	else db().prepare('DELETE FROM history WHERE connection_id = ?').run(connectionId);
}

export interface AuditFilter {
	userId?: string;
	connectionId?: string;
	/** Only statements that ran with write access. */
	writes?: boolean;
	errors?: boolean;
	q?: string;
	before?: number;
	limit?: number;
}

/** Queries across every connection, newest first, for the audit log. */
export function searchHistory(f: AuditFilter): HistoryEntry[] {
	const where: string[] = [];
	const values: (string | number)[] = [];
	if (f.userId) where.push('h.user_id = ?'), values.push(f.userId);
	if (f.connectionId) where.push('h.connection_id = ?'), values.push(f.connectionId);
	if (f.writes) where.push('h.read_only = 0');
	if (f.errors) where.push('h.ok = 0');
	if (f.q) where.push('h.sql LIKE ?'), values.push(`%${f.q}%`);
	if (f.before) where.push('h.id < ?'), values.push(f.before);
	const rows = db()
		.prepare(
			`SELECT h.*, c.name AS connection_name FROM history h LEFT JOIN connections c ON c.id = h.connection_id
			 ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY h.id DESC LIMIT ?`
		)
		.all(...values, Math.min(f.limit ?? 100, 500)) as Row[];
	return rows.map(toHistory);
}

// --- audit -------------------------------------------------------------------

export function addAudit(e: Omit<AuditEvent, 'id' | 'at'>) {
	db().prepare(
		'INSERT INTO audit (at, user_id, user_email, action, connection_id, connection_name, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
	).run(new Date().toISOString(), e.userId, e.userEmail, e.action, e.connectionId, e.connectionName, e.detail, e.ip);
	db().prepare('DELETE FROM audit WHERE id <= (SELECT max(id) - 20000 FROM audit)').run();
}

export function searchAudit(f: AuditFilter & { action?: string }): AuditEvent[] {
	const where: string[] = [];
	const values: (string | number)[] = [];
	if (f.userId) where.push('user_id = ?'), values.push(f.userId);
	if (f.connectionId) where.push('connection_id = ?'), values.push(f.connectionId);
	if (f.action) where.push('action LIKE ?'), values.push(`${f.action}%`);
	if (f.q) where.push('(detail LIKE ? OR connection_name LIKE ? OR user_email LIKE ?)'), values.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
	if (f.before) where.push('id < ?'), values.push(f.before);
	const rows = db()
		.prepare(`SELECT * FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
		.all(...values, Math.min(f.limit ?? 100, 500)) as Row[];
	return rows.map((r) => ({
		id: r.id as number,
		at: r.at as string,
		userId: (r.user_id as string) ?? null,
		userEmail: (r.user_email as string) ?? null,
		action: r.action as string,
		connectionId: (r.connection_id as string) ?? null,
		connectionName: (r.connection_name as string) ?? null,
		detail: (r.detail as string) ?? null,
		ip: (r.ip as string) ?? null
	}));
}

// --- access ------------------------------------------------------------------

export function listGrants(userId: string): Grant[] {
	return (db().prepare('SELECT connection_id, can_write FROM grants WHERE user_id = ?').all(userId) as Row[]).map((r) => ({
		connectionId: r.connection_id as string,
		canWrite: r.can_write === 1
	}));
}

export function getGrant(userId: string, connectionId: string): Grant | undefined {
	const r = db().prepare('SELECT can_write FROM grants WHERE user_id = ? AND connection_id = ?').get(userId, connectionId) as Row | undefined;
	return r && { connectionId, canWrite: r.can_write === 1 };
}

export function setGrants(userId: string, grants: Grant[]) {
	const h = db();
	h.exec('BEGIN');
	try {
		h.prepare('DELETE FROM grants WHERE user_id = ?').run(userId);
		const ins = h.prepare('INSERT INTO grants (user_id, connection_id, can_write) VALUES (?, ?, ?)');
		for (const g of grants) if (getConnection(g.connectionId)) ins.run(userId, g.connectionId, g.canWrite ? 1 : 0);
		h.exec('COMMIT');
	} catch (err) {
		h.exec('ROLLBACK');
		throw err;
	}
}

export function setUnlock(userId: string, connectionId: string, expiresAt: number, reason: string | null) {
	db().prepare(
		`INSERT INTO write_unlocks (user_id, connection_id, expires_at, reason) VALUES (?, ?, ?, ?)
		 ON CONFLICT(user_id, connection_id) DO UPDATE SET expires_at = excluded.expires_at, reason = excluded.reason`
	).run(userId, connectionId, expiresAt, reason);
}

export function clearUnlock(userId: string, connectionId: string) {
	db().prepare('DELETE FROM write_unlocks WHERE user_id = ? AND connection_id = ?').run(userId, connectionId);
}

/** When the user's temporary write access ends, if it's active. */
export function unlockedUntil(userId: string, connectionId: string): number | null {
	db().prepare('DELETE FROM write_unlocks WHERE expires_at < ?').run(Date.now());
	const r = db().prepare('SELECT expires_at FROM write_unlocks WHERE user_id = ? AND connection_id = ?').get(userId, connectionId) as Row | undefined;
	return r ? (r.expires_at as number) : null;
}

// --- backup ------------------------------------------------------------------

/** The raw handle, for backup/restore, which reads and writes whole tables in one transaction. */
export function sqlite(): DatabaseSync {
	return db();
}

// --- saved queries -----------------------------------------------------------

function migrateSavedQueries(h: DatabaseSync) {
	h.exec(`
		-- Named queries. A NULL connection_id means "usable on any connection".
		CREATE TABLE IF NOT EXISTS saved_queries (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			description TEXT,
			sql TEXT NOT NULL,
			connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
			owner_id TEXT NOT NULL,
			owner_email TEXT NOT NULL,
			shared INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS saved_queries_conn ON saved_queries(connection_id);
		CREATE INDEX IF NOT EXISTS saved_queries_owner ON saved_queries(owner_id);
	`);
}

function toSavedQuery(r: Row): SavedQuery {
	return {
		id: r.id as string,
		name: r.name as string,
		description: (r.description as string) ?? null,
		sql: r.sql as string,
		connectionId: (r.connection_id as string) ?? null,
		ownerId: r.owner_id as string,
		ownerEmail: r.owner_email as string,
		shared: r.shared === 1,
		createdAt: r.created_at as string,
		updatedAt: r.updated_at as string
	};
}

/**
 * The user's own queries plus everyone's shared ones. With `connectionId`, only those
 * for that connection or for any connection; otherwise all of them (callers filter
 * by which connections the user can see).
 */
export function listSavedQueries(userId: string, connectionId?: string): SavedQuery[] {
	const rows = connectionId
		? db()
				.prepare(
					`SELECT * FROM saved_queries WHERE (owner_id = ? OR shared = 1) AND (connection_id IS NULL OR connection_id = ?)
					 ORDER BY name COLLATE NOCASE`
				)
				.all(userId, connectionId)
		: db().prepare('SELECT * FROM saved_queries WHERE owner_id = ? OR shared = 1 ORDER BY name COLLATE NOCASE').all(userId);
	return (rows as Row[]).map(toSavedQuery);
}

export function getSavedQuery(id: string): SavedQuery | undefined {
	const row = db().prepare('SELECT * FROM saved_queries WHERE id = ?').get(id) as Row | undefined;
	return row && toSavedQuery(row);
}

export interface SavedQueryInput {
	name: string;
	description: string | null;
	sql: string;
	connectionId: string | null;
	shared: boolean;
}

export function createSavedQuery(owner: { id: string; email: string }, input: SavedQueryInput): SavedQuery {
	const id = randomUUID();
	const now = new Date().toISOString();
	db()
		.prepare(
			`INSERT INTO saved_queries (id, name, description, sql, connection_id, owner_id, owner_email, shared, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(id, input.name, input.description, input.sql, input.connectionId, owner.id, owner.email, input.shared ? 1 : 0, now, now);
	return getSavedQuery(id)!;
}

export function updateSavedQuery(id: string, input: SavedQueryInput): SavedQuery | undefined {
	db()
		.prepare('UPDATE saved_queries SET name = ?, description = ?, sql = ?, connection_id = ?, shared = ?, updated_at = ? WHERE id = ?')
		.run(input.name, input.description, input.sql, input.connectionId, input.shared ? 1 : 0, new Date().toISOString(), id);
	return getSavedQuery(id);
}

export function deleteSavedQuery(id: string): boolean {
	return Number(db().prepare('DELETE FROM saved_queries WHERE id = ?').run(id).changes) > 0;
}

// --- alerts and size history (functions live in alerts/store.ts, size-history.ts) ---

function migrateAlerts(h: DatabaseSync) {
	h.exec(`
		-- Where notifications go. Secret fields (tokens, webhook URLs) are encrypted in \`secret\`.
		CREATE TABLE IF NOT EXISTS alert_channels (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			kind TEXT NOT NULL,
			config TEXT NOT NULL DEFAULT '{}',
			secret TEXT,
			enabled INTEGER NOT NULL DEFAULT 1,
			last_sent_at TEXT,
			last_error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		-- A NULL connection_id applies to every connection without its own rule of that kind.
		CREATE TABLE IF NOT EXISTS alert_rules (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
			enabled INTEGER NOT NULL DEFAULT 1,
			params TEXT NOT NULL DEFAULT '{}',
			notify_resolved INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		-- Per (rule, connection) state machine: ok → pending → firing → ok.
		CREATE TABLE IF NOT EXISTS alert_state (
			rule_id TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
			connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
			status TEXT NOT NULL,
			streak INTEGER NOT NULL DEFAULT 0,
			since INTEGER,
			last_notified_at INTEGER,
			message TEXT,
			value REAL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (rule_id, connection_id)
		);

		-- Fired / resolved history. Names are copied so entries outlive rules and connections.
		CREATE TABLE IF NOT EXISTS alert_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			at TEXT NOT NULL,
			rule_id TEXT,
			rule_kind TEXT NOT NULL,
			connection_id TEXT,
			connection_name TEXT,
			event TEXT NOT NULL,
			severity TEXT NOT NULL,
			message TEXT NOT NULL,
			delivered INTEGER NOT NULL DEFAULT 0,
			error TEXT
		);
		CREATE INDEX IF NOT EXISTS alert_events_time ON alert_events(id DESC);
	`);
}

function migrateSizeHistory(h: DatabaseSync) {
	h.exec(`
		-- Database size per connection: hourly samples (kept 14 days), daily rollups (kept a year).
		-- \`at\` is the start of the hour or UTC day, in epoch ms.
		CREATE TABLE IF NOT EXISTS size_samples (
			connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
			resolution TEXT NOT NULL,
			at INTEGER NOT NULL,
			bytes INTEGER NOT NULL,
			PRIMARY KEY (connection_id, resolution, at)
		);

		-- The largest tables at each sample.
		CREATE TABLE IF NOT EXISTS table_size_samples (
			connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
			resolution TEXT NOT NULL,
			at INTEGER NOT NULL,
			schema_name TEXT NOT NULL,
			table_name TEXT NOT NULL,
			bytes INTEGER NOT NULL,
			PRIMARY KEY (connection_id, resolution, at, schema_name, table_name)
		);
	`);
}

// --- schema snapshots (rows are read and written in schema-snapshots.ts) --------------

function migrateSchemaSnapshots(h: DatabaseSync) {
	h.exec(`
		-- Normalized schema captures (gzip JSON), manual or taken when the schema changed.
		CREATE TABLE IF NOT EXISTS schema_snapshots (
			id TEXT PRIMARY KEY,
			connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
			engine TEXT NOT NULL,
			label TEXT NOT NULL,
			note TEXT,
			auto INTEGER NOT NULL DEFAULT 0,
			hash TEXT NOT NULL,
			size_bytes INTEGER NOT NULL,
			stats TEXT NOT NULL,
			data BLOB NOT NULL,
			created_by TEXT,
			created_by_email TEXT,
			created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS schema_snapshots_conn ON schema_snapshots(connection_id, created_at DESC);

		-- Per-connection auto-snapshot switch and the scheduled check's last outcome.
		CREATE TABLE IF NOT EXISTS schema_snapshot_settings (
			connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
			auto INTEGER NOT NULL DEFAULT 0,
			last_checked_at TEXT,
			last_error TEXT
		);
	`);
}

// --- API tokens (rows are read and written in api-tokens.ts) -------------------------

function migrateApiTokens(h: DatabaseSync) {
	h.exec(`
		-- Read-only tokens for dashboards. Only a SHA-256 of the token is kept.
		CREATE TABLE IF NOT EXISTS api_tokens (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			token_hash TEXT NOT NULL UNIQUE,
			prefix TEXT NOT NULL,
			scope TEXT NOT NULL DEFAULT 'status',
			include_addresses INTEGER NOT NULL DEFAULT 0,
			expires_at TEXT,
			created_by TEXT,
			created_by_email TEXT,
			created_at TEXT NOT NULL,
			last_used_at TEXT,
			last_used_ip TEXT,
			revoked_at TEXT
		);
	`);
}

// --- database backups --------------------------------------------------------
// Tables only; the functions live in server/backups/store.ts (via sqlite()).

function migrateBackups(h: DatabaseSync) {
	h.exec(`
		-- Where scheduled dumps go. Secrets (passwords, keys) are sealed in "secret".
		CREATE TABLE IF NOT EXISTS backup_destinations (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			kind TEXT NOT NULL,
			config TEXT NOT NULL,
			secret TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		-- A NULL connection_id means "every connection".
		CREATE TABLE IF NOT EXISTS backup_schedules (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
			destination_id TEXT NOT NULL REFERENCES backup_destinations(id),
			frequency TEXT NOT NULL,
			minute INTEGER NOT NULL DEFAULT 0,
			hour INTEGER NOT NULL DEFAULT 3,
			weekday INTEGER NOT NULL DEFAULT 0,
			keep_last INTEGER,
			keep_days INTEGER,
			compress INTEGER NOT NULL DEFAULT 1,
			enabled INTEGER NOT NULL DEFAULT 1,
			last_run_at TEXT,
			next_run_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		-- Backups and restores. Names are copied so runs outlive their connection/destination.
		CREATE TABLE IF NOT EXISTS backup_runs (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL DEFAULT 'backup',
			status TEXT NOT NULL,
			trigger TEXT NOT NULL,
			schedule_id TEXT,
			schedule_name TEXT,
			connection_id TEXT,
			connection_name TEXT NOT NULL,
			engine TEXT NOT NULL,
			databases TEXT NOT NULL DEFAULT '[]',
			all_databases INTEGER NOT NULL DEFAULT 0,
			destination_id TEXT,
			destination_name TEXT NOT NULL,
			file_name TEXT,
			format TEXT,
			size_bytes INTEGER,
			started_at TEXT NOT NULL,
			finished_at TEXT,
			duration_ms INTEGER,
			error TEXT,
			warnings TEXT,
			source_run_id TEXT,
			deleted_at TEXT,
			created_by TEXT
		);
		CREATE INDEX IF NOT EXISTS backup_runs_time ON backup_runs(started_at DESC);
		CREATE INDEX IF NOT EXISTS backup_runs_conn ON backup_runs(connection_id, started_at DESC);
	`);
	// Nothing survives a restart mid-dump.
	h.prepare(`UPDATE backup_runs SET status = 'failed', error = 'Interrupted by a restart', finished_at = ? WHERE status = 'running'`).run(
		new Date().toISOString()
	);
}
