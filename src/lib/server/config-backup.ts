import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decrypt, encrypt } from './crypto.ts';
import { BackupError } from './backup.ts';
import { deleteKv, getKv, getManagerKey, getPassword, setKv, sqlite } from './store.ts';
import type { Role, Settings, SslMode } from '#lib/types.ts';

/**
 * What goes into a backup and how it merges back in. history, audit, sessions and
 * write unlocks are deliberately left out: they're logs and transient state.
 */

export interface BackupInclude {
	connections: boolean;
	users: boolean;
	settings: boolean;
}

export interface BackupConnection {
	id: string;
	name: string;
	host: string;
	port: number;
	database: string;
	user: string;
	password: string | null;
	sslMode: SslMode;
	readOnly: boolean;
	color: string;
	source: { kind: string; ref: string | null };
	createdAt: string;
}

export interface BackupUser {
	id: string;
	email: string;
	name: string | null;
	role: Role;
	/** scrypt hash — already one-way. */
	passwordHash: string | null;
	oidcSub: string | null;
	disabled: boolean;
	needsProfile: boolean;
	connectionAccess: string;
	createdAt: string;
}

export interface BackupSettings {
	settings: Settings | null;
	sso: Record<string, unknown> | null;
	ssoClientSecret: string | null;
	localLoginDisabled: boolean | null;
	/** Arcane API keys by manager id, decrypted. */
	managerKeys: Record<string, string>;
}

export interface BackupPayload {
	include: BackupInclude;
	connections?: BackupConnection[];
	users?: BackupUser[];
	grants?: { userId: string; connectionId: string; canWrite: boolean }[];
	settings?: BackupSettings;
	/** Rows of the saved_queries table, when this install has one (column names as stored). */
	savedQueries?: Record<string, unknown>[];
}

type Row = Record<string, unknown>;

const SSL_MODES: SslMode[] = ['disable', 'prefer', 'require', 'verify-full'];
const MANAGER_KEY_PREFIX = 'manager-key:';

let cachedVersion: string | undefined;
export function appVersion(): string {
	if (cachedVersion) return cachedVersion;
	try {
		cachedVersion = String(JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version ?? 'unknown');
	} catch {
		cachedVersion = 'unknown';
	}
	return cachedVersion;
}

function tableColumns(table: string): string[] {
	return (sqlite().prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((c) => c.name);
}

function managerKeyIds(): string[] {
	return (sqlite().prepare(`SELECT key FROM kv WHERE key LIKE 'manager-key:%'`).all() as { key: string }[]).map((r) =>
		r.key.slice(MANAGER_KEY_PREFIX.length)
	);
}

// --- export ------------------------------------------------------------------

export function snapshot(include: BackupInclude): BackupPayload {
	const h = sqlite();
	const payload: BackupPayload = { include };
	if (include.connections) {
		payload.connections = (h.prepare('SELECT * FROM connections ORDER BY name COLLATE NOCASE').all() as Row[]).map((r) => ({
			id: r.id as string,
			name: r.name as string,
			host: r.host as string,
			port: r.port as number,
			database: r.database as string,
			user: r.user as string,
			password: getPassword(r.id as string) ?? null,
			sslMode: r.ssl_mode as SslMode,
			readOnly: r.read_only === 1,
			color: r.color as string,
			source: { kind: r.source_kind as string, ref: (r.source_ref as string) ?? null },
			createdAt: r.created_at as string
		}));
		if (tableColumns('saved_queries').length) payload.savedQueries = h.prepare('SELECT * FROM saved_queries').all() as Row[];
	}
	if (include.users) {
		payload.users = (h.prepare('SELECT * FROM users ORDER BY email').all() as Row[]).map((r) => ({
			id: r.id as string,
			email: r.email as string,
			name: (r.name as string) ?? null,
			role: r.role as Role,
			passwordHash: (r.password_hash as string) ?? null,
			oidcSub: (r.oidc_sub as string) ?? null,
			disabled: r.disabled === 1,
			needsProfile: r.needs_profile === 1,
			connectionAccess: (r.connection_access as string) ?? 'all',
			createdAt: r.created_at as string
		}));
		payload.grants = (h.prepare('SELECT * FROM grants').all() as Row[]).map((r) => ({
			userId: r.user_id as string,
			connectionId: r.connection_id as string,
			canWrite: r.can_write === 1
		}));
	}
	if (include.settings) {
		const sso = getKv<Record<string, unknown> | null>('sso', null);
		const managerKeys: Record<string, string> = {};
		for (const id of managerKeyIds()) {
			const key = getManagerKey(id);
			if (key) managerKeys[id] = key;
		}
		payload.settings = {
			settings: getKv<Settings | null>('settings', null),
			sso,
			ssoClientSecret: storedSsoSecret(),
			localLoginDisabled: getKv<boolean | null>('local-login-disabled', null),
			managerKeys
		};
	}
	return payload;
}

/** The UI-managed SSO client secret (env-var SSO isn't stored, so it isn't backed up). */
function storedSsoSecret(): string | null {
	const sealed = getKv<string | null>('sso-secret', null);
	return sealed ? decrypt(sealed, 'sso') : null;
}

export function summarizeInclude(p: BackupPayload): string {
	const parts: string[] = [];
	if (p.connections) parts.push(`${p.connections.length} connections`);
	if (p.savedQueries) parts.push(`${p.savedQueries.length} saved queries`);
	if (p.users) parts.push(`${p.users.length} users`, `${p.grants?.length ?? 0} grants`);
	if (p.settings) parts.push(`settings (${Object.keys(p.settings.managerKeys).length} manager keys${p.settings.sso ? ', SSO' : ''})`);
	return parts.join(', ') || 'nothing';
}

// --- validation ----------------------------------------------------------------

function str(v: unknown, what: string): string {
	if (typeof v !== 'string' || !v) throw new BackupError(`Damaged backup: bad ${what}`);
	return v;
}

/** Checks the decrypted payload's shape before anything touches the store. */
export function validatePayload(raw: unknown): BackupPayload {
	if (!raw || typeof raw !== 'object') throw new BackupError('Damaged backup: no payload');
	const p = raw as BackupPayload;
	const inc = p.include ?? { connections: !!p.connections, users: !!p.users, settings: !!p.settings };
	if (p.connections !== undefined) {
		if (!Array.isArray(p.connections)) throw new BackupError('Damaged backup: connections');
		for (const c of p.connections) {
			str(c.id, 'connection id');
			str(c.name, 'connection name');
			str(c.host, 'connection host');
			str(c.database, 'connection database');
			str(c.user, 'connection user');
			if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) throw new BackupError(`Damaged backup: port of ${c.name}`);
			if (!SSL_MODES.includes(c.sslMode)) throw new BackupError(`Damaged backup: sslMode of ${c.name}`);
			if (c.password !== null && typeof c.password !== 'string') throw new BackupError(`Damaged backup: password of ${c.name}`);
		}
	}
	if (p.users !== undefined) {
		if (!Array.isArray(p.users)) throw new BackupError('Damaged backup: users');
		for (const u of p.users) {
			str(u.id, 'user id');
			str(u.email, 'user email');
			if (u.role !== 'admin' && u.role !== 'viewer') throw new BackupError(`Damaged backup: role of ${u.email}`);
			if (u.connectionAccess !== 'all' && u.connectionAccess !== 'selected') u.connectionAccess = 'all';
		}
	}
	if (p.grants !== undefined && !Array.isArray(p.grants)) throw new BackupError('Damaged backup: grants');
	if (p.savedQueries !== undefined && !Array.isArray(p.savedQueries)) throw new BackupError('Damaged backup: saved queries');
	if (p.settings !== undefined && (typeof p.settings !== 'object' || !p.settings)) throw new BackupError('Damaged backup: settings');
	return { ...p, include: { connections: !!inc.connections, users: !!inc.users, settings: !!inc.settings } };
}

// --- preview -------------------------------------------------------------------

export type ChangeStatus = 'new' | 'update' | 'self' | 'same' | 'remove';

export interface RestorePreview {
	createdAt: string;
	appVersion: string;
	contains: BackupInclude;
	connections: { id: string; name: string; target: string; hasPassword: boolean; status: 'new' | 'update' }[];
	users: { email: string; name: string | null; role: Role; status: 'new' | 'update' | 'self' }[];
	grants: number;
	savedQueries: { total: number; new: number; update: number; supported: boolean } | null;
	settings: { label: string; detail: string; status: ChangeStatus }[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function same(a: unknown, b: unknown) {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function previewRestore(p: BackupPayload, actorId: string | null, meta: { createdAt: string; appVersion: string }): RestorePreview {
	const h = sqlite();
	const connExists = h.prepare('SELECT 1 FROM connections WHERE id = ?');
	const userByEmail = h.prepare('SELECT id FROM users WHERE email = ?');
	const preview: RestorePreview = {
		...meta,
		contains: p.include,
		connections: (p.connections ?? []).map((c) => ({
			id: c.id,
			name: c.name,
			target: `${c.user}@${c.host}:${c.port}/${c.database}`,
			hasPassword: !!c.password,
			status: connExists.get(c.id) ? 'update' : 'new'
		})),
		users: (p.users ?? []).map((u) => {
			const existing = userByEmail.get(u.email) as { id: string } | undefined;
			return { email: u.email, name: u.name, role: u.role, status: !existing ? 'new' : existing.id === actorId ? 'self' : 'update' };
		}),
		grants: p.grants?.length ?? 0,
		savedQueries: null,
		settings: []
	};
	if (p.savedQueries) {
		const cols = tableColumns('saved_queries');
		const exists = cols.includes('id') ? h.prepare('SELECT 1 FROM saved_queries WHERE id = ?') : undefined;
		const update = exists ? p.savedQueries.filter((q) => exists.get(String(q.id))).length : 0;
		preview.savedQueries = { total: p.savedQueries.length, update, new: p.savedQueries.length - update, supported: cols.length > 0 };
	}
	if (p.settings) {
		const s = p.settings;
		const status = (incoming: unknown, current: unknown): ChangeStatus =>
			same(incoming, current) ? 'same' : incoming == null ? 'remove' : current == null ? 'new' : 'update';
		const cur = getKv<Settings | null>('settings', null);
		preview.settings.push({
			label: 'Discovery',
			detail: `${plural(s.settings?.dockerHosts?.length ?? 0, 'Docker host')}, ${plural(s.settings?.scanPaths?.length ?? 0, 'scan folder')}`,
			status: status(
				s.settings && { dockerHosts: s.settings.dockerHosts, scanPaths: s.settings.scanPaths },
				cur && { dockerHosts: cur.dockerHosts, scanPaths: cur.scanPaths }
			)
		});
		const incomingManagers = s.settings?.managers?.length ? s.settings.managers : null;
		const managers = status(incomingManagers, cur?.managers?.length ? cur.managers : null);
		const keysSame = same(Object.keys(s.managerKeys ?? {}).sort(), managerKeyIds().sort());
		preview.settings.push({
			label: 'Arcane managers',
			detail: incomingManagers ? `${incomingManagers.map((m) => m.name).join(', ')} · ${plural(Object.keys(s.managerKeys ?? {}).length, 'API key')}` : 'none',
			// Key values can't be compared without decrypting; treat a matching set as unchanged.
			status: managers === 'same' && !keysSame ? 'update' : managers
		});
		const sso = s.sso as { name?: string; issuer?: string } | null;
		preview.settings.push({
			label: 'Single sign-on',
			detail: sso ? `${sso.name ?? 'SSO'} · ${sso.issuer ?? ''}${s.ssoClientSecret ? ' · with client secret' : ''}` : 'not configured',
			status: status(s.sso, getKv('sso', null))
		});
		preview.settings.push({
			label: 'Password sign-in',
			detail: s.localLoginDisabled ? 'disabled (SSO only)' : 'enabled',
			status: same(!!s.localLoginDisabled, getKv<boolean>('local-login-disabled', false)) ? 'same' : 'update'
		});
	}
	return preview;
}

// --- apply ---------------------------------------------------------------------

export interface RestoreChoice {
	connections: boolean;
	users: boolean;
	settings: boolean;
}

export interface RestoreResult {
	connections: { added: number; updated: number };
	users: { added: number; updated: number; skipped: number };
	grants: number;
	savedQueries: { restored: number; skipped: number };
	settings: boolean;
	/** Connections whose pools should be closed. */
	changedConnectionIds: string[];
}

/**
 * Merges a backup into this install in one transaction: connections by id (passwords
 * re-sealed with this install's master key), users by email. The signed-in admin's own
 * account is never touched, and the restore fails rather than leave no enabled admin.
 */
export function applyRestore(p: BackupPayload, choice: RestoreChoice, actorId: string | null): RestoreResult {
	const h = sqlite();
	const result: RestoreResult = {
		connections: { added: 0, updated: 0 },
		users: { added: 0, updated: 0, skipped: 0 },
		grants: 0,
		savedQueries: { restored: 0, skipped: 0 },
		settings: false,
		changedConnectionIds: []
	};
	const now = new Date().toISOString();
	h.exec('BEGIN IMMEDIATE');
	try {
		const restoredConnections = new Set<string>();
		if (choice.connections && p.connections) {
			const exists = h.prepare('SELECT 1 FROM connections WHERE id = ?');
			const update = h.prepare(
				`UPDATE connections SET name = ?, host = ?, port = ?, database = ?, user = ?, secret = ?, ssl_mode = ?, read_only = ?, color = ?,
				 source_kind = ?, source_ref = ?, updated_at = ? WHERE id = ?`
			);
			const insert = h.prepare(
				`INSERT INTO connections (id, name, host, port, database, user, secret, ssl_mode, read_only, color, source_kind, source_ref, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			);
			for (const c of p.connections) {
				const secret = c.password ? encrypt(JSON.stringify({ password: c.password }), `connection:${c.id}`) : null;
				const fields = [c.name, c.host, c.port, c.database, c.user, secret, c.sslMode, c.readOnly ? 1 : 0, c.color || 'violet', c.source?.kind || 'manual', c.source?.ref ?? null] as const;
				if (exists.get(c.id)) {
					update.run(...fields, now, c.id);
					result.connections.updated++;
				} else {
					insert.run(c.id, ...fields, c.createdAt || now, now);
					result.connections.added++;
				}
				restoredConnections.add(c.id);
			}
			result.changedConnectionIds = [...restoredConnections];
		}

		// Backup user id → local user id (users are matched by email).
		const userMap = new Map<string, string>();
		const byEmail = h.prepare('SELECT * FROM users WHERE email = ?');
		for (const u of p.users ?? []) {
			const local = byEmail.get(u.email) as Row | undefined;
			if (local) userMap.set(u.id, local.id as string);
		}

		const restoredUsers = new Set<string>();
		if (choice.users && p.users) {
			const idTaken = h.prepare('SELECT 1 FROM users WHERE id = ?');
			const subOwner = h.prepare('SELECT id FROM users WHERE oidc_sub = ?');
			const update = h.prepare(
				`UPDATE users SET name = ?, role = ?, password_hash = ?, oidc_sub = ?, disabled = ?, needs_profile = ?, connection_access = ? WHERE id = ?`
			);
			const insert = h.prepare(
				`INSERT INTO users (id, email, name, role, password_hash, oidc_sub, disabled, needs_profile, connection_access, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			);
			const dropSessions = h.prepare('DELETE FROM sessions WHERE user_id = ?');
			for (const u of p.users) {
				const local = byEmail.get(u.email) as Row | undefined;
				if (local && local.id === actorId) {
					// Your own account stays exactly as it is.
					result.users.skipped++;
					continue;
				}
				const id = local ? (local.id as string) : idTaken.get(u.id) ? randomUUID() : u.id;
				const owner = u.oidcSub ? (subOwner.get(u.oidcSub) as { id: string } | undefined) : undefined;
				const sub = owner && owner.id !== id ? null : (u.oidcSub ?? null);
				const fields = [u.name ?? null, u.role, u.passwordHash ?? null, sub, u.disabled ? 1 : 0, u.needsProfile ? 1 : 0, u.connectionAccess] as const;
				if (local) {
					const changed =
						local.role !== u.role || local.password_hash !== (u.passwordHash ?? null) || (local.disabled === 1) !== !!u.disabled;
					update.run(...fields, id);
					if (changed) dropSessions.run(id);
					result.users.updated++;
				} else {
					insert.run(id, u.email.trim(), ...fields, u.createdAt || now);
					result.users.added++;
				}
				userMap.set(u.id, id);
				restoredUsers.add(id);
			}
			const admins = (h.prepare(`SELECT count(*) AS n FROM users WHERE role = 'admin' AND disabled = 0`).get() as { n: number }).n;
			if (admins === 0) throw new BackupError('Restoring these users would leave no enabled admin');
		}

		// Grants: a restored user's grants are replaced; restored connections get the grants
		// the backup had for users that exist here.
		if ((restoredUsers.size || restoredConnections.size) && p.grants) {
			const connExists = h.prepare('SELECT 1 FROM connections WHERE id = ?');
			const clear = h.prepare('DELETE FROM grants WHERE user_id = ?');
			const put = h.prepare('INSERT OR REPLACE INTO grants (user_id, connection_id, can_write) VALUES (?, ?, ?)');
			for (const id of restoredUsers) clear.run(id);
			for (const g of p.grants) {
				const userId = userMap.get(g.userId);
				if (!userId || userId === actorId) continue;
				if (!restoredUsers.has(userId) && !restoredConnections.has(g.connectionId)) continue;
				if (!connExists.get(g.connectionId)) continue;
				put.run(userId, g.connectionId, g.canWrite ? 1 : 0);
				result.grants++;
			}
		}

		if (choice.connections && p.savedQueries?.length) {
			const cols = tableColumns('saved_queries');
			if (cols.length) {
				for (const q of p.savedQueries) {
					const row: Row = { ...q };
					if (typeof row.owner_id === 'string' && userMap.has(row.owner_id)) row.owner_id = userMap.get(row.owner_id);
					const keys = cols.filter((k) => k in row);
					if (!keys.length) continue;
					try {
						h.prepare(`INSERT OR REPLACE INTO saved_queries (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(
							...keys.map((k) => sqlValue(row[k]))
						);
						result.savedQueries.restored++;
					} catch {
						// e.g. its connection or owner isn't on this install
						result.savedQueries.skipped++;
					}
				}
			} else {
				result.savedQueries.skipped = p.savedQueries.length;
			}
		}

		if (choice.settings && p.settings) {
			const s = p.settings;
			if (s.settings) setKv('settings', s.settings);
			else deleteKv('settings');
			if (s.sso) setKv('sso', s.sso);
			else deleteKv('sso');
			if (s.ssoClientSecret) setKv('sso-secret', encrypt(s.ssoClientSecret, 'sso'));
			else deleteKv('sso-secret');
			if (s.localLoginDisabled != null) setKv('local-login-disabled', !!s.localLoginDisabled);
			else deleteKv('local-login-disabled');
			h.prepare(`DELETE FROM kv WHERE key LIKE 'manager-key:%'`).run();
			for (const [id, key] of Object.entries(s.managerKeys ?? {})) {
				if (typeof key === 'string' && key) setKv(`${MANAGER_KEY_PREFIX}${id}`, encrypt(key, `manager:${id}`));
			}
			result.settings = true;
		}
		h.exec('COMMIT');
	} catch (err) {
		h.exec('ROLLBACK');
		throw err;
	}
	return result;
}

function sqlValue(v: unknown): string | number | null {
	if (v == null) return null;
	if (typeof v === 'number' || typeof v === 'string') return v;
	if (typeof v === 'boolean') return v ? 1 : 0;
	if (typeof v === 'bigint') return Number(v);
	return JSON.stringify(v);
}

export function summarizeResult(r: RestoreResult): string {
	const parts: string[] = [];
	if (r.connections.added || r.connections.updated) parts.push(`connections +${r.connections.added} ~${r.connections.updated}`);
	if (r.users.added || r.users.updated || r.users.skipped) parts.push(`users +${r.users.added} ~${r.users.updated} (kept ${r.users.skipped})`);
	if (r.grants) parts.push(`${r.grants} grants`);
	if (r.savedQueries.restored || r.savedQueries.skipped) parts.push(`saved queries ${r.savedQueries.restored} (skipped ${r.savedQueries.skipped})`);
	if (r.settings) parts.push('settings replaced');
	return parts.join('; ') || 'nothing changed';
}
