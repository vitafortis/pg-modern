import { addAudit, getConnection, getGrant, listConnections, unlockedUntil } from './store.ts';
import type { Connection, ConnectionAccess, User } from '#lib/types.ts';

/**
 * Who can see and write to which connection:
 * - admins see everything; writable connections accept their writes, read-only ones
 *   can be unlocked for a while
 * - viewers see every connection or only granted ones (`connectionAccess`), always
 *   read-only unless a grant allows them to unlock writes temporarily
 */
export function canSee(user: User | null, conn: Connection): boolean {
	if (!user) return false;
	if (user.role === 'admin' || user.connectionAccess === 'all') return true;
	return !!getGrant(user.id, conn.id);
}

/** Connections the user can see, each annotated with their access. */
export function visibleConnections(user: User | null): Connection[] {
	if (!user) return [];
	return listConnections()
		.filter((c) => canSee(user, c))
		.map((c) => ({ ...c, access: accessFor(user, c) }));
}

export function withAccess(user: User | null, conn: Connection): Connection {
	return user ? { ...conn, access: accessFor(user, conn) } : conn;
}

export function accessFor(user: User, conn: Connection): ConnectionAccess {
	let write: ConnectionAccess['write'];
	if (user.role === 'admin') write = conn.readOnly ? 'unlock' : 'always';
	else write = getGrant(user.id, conn.id)?.canWrite ? 'unlock' : 'never';
	const until = write === 'unlock' ? unlockedUntil(user.id, conn.id) : null;
	return { write, unlockedUntil: until, readOnly: !(write === 'always' || until !== null) };
}

/** Effective read-only mode for a user's queries on a connection id. */
export function readOnlyFor(user: User | null, id: string): boolean {
	const conn = getConnection(id);
	if (!user || !conn) return true;
	return accessFor(user, conn).readOnly;
}

/** Records who did what; connection names are copied so entries outlive them. */
export function audit(
	locals: { user: User | null; ip?: string },
	action: string,
	opts: { connection?: Pick<Connection, 'id' | 'name'>; detail?: string; /** Acting user, when not yet signed in (logins). */ as?: Pick<User, 'id' | 'email'> } = {}
) {
	try {
		addAudit({
			userId: (opts.as ?? locals.user)?.id ?? null,
			userEmail: (opts.as ?? locals.user)?.email ?? null,
			action,
			connectionId: opts.connection?.id ?? null,
			connectionName: opts.connection?.name ?? null,
			detail: opts.detail ?? null,
			ip: locals.ip ?? null
		});
	} catch (err) {
		console.error('[pg-modern] audit write failed', err);
	}
}
