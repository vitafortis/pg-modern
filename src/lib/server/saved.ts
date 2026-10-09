import { BadRequest } from './http.ts';
import { canSee } from './permissions.ts';
import { getConnection, listSavedQueries, type SavedQueryInput } from './store.ts';
import type { SavedQuery, User } from '#lib/types.ts';

/**
 * Saved queries are just text: anyone signed in can keep their own and share them.
 * Shared ones are visible to everyone who can see their connection (or to everyone,
 * for connection-less ones). Only the owner or an admin can change or delete one.
 */
export function canEditSaved(user: User | null, q: SavedQuery): boolean {
	return !!user && (user.role === 'admin' || q.ownerId === user.id);
}

/** Whether the user can see a saved query at all. */
export function canSeeSaved(user: User | null, q: SavedQuery): boolean {
	if (!user) return false;
	if (q.ownerId !== user.id && !q.shared) return false;
	if (!q.connectionId) return true;
	const conn = getConnection(q.connectionId);
	return !!conn && canSee(user, conn);
}

export function decorate(user: User, q: SavedQuery): SavedQuery {
	return { ...q, mine: q.ownerId === user.id, canEdit: canEditSaved(user, q) };
}

/** Own and shared queries the user may see; with `connectionId`, those usable there. */
export function visibleSavedQueries(user: User, connectionId?: string): SavedQuery[] {
	return listSavedQueries(user.id, connectionId)
		.filter((q) => canSeeSaved(user, q))
		.map((q) => decorate(user, q));
}

export function parseSavedInput(user: User, body: unknown): SavedQueryInput {
	if (!body || typeof body !== 'object') throw new BadRequest('Expected a JSON object');
	const b = body as Record<string, unknown>;
	const name = typeof b.name === 'string' ? b.name.trim() : '';
	if (!name) throw new BadRequest('"name" is required');
	if (name.length > 120) throw new BadRequest('"name" is too long (120 characters at most)');
	const sql = typeof b.sql === 'string' ? b.sql.trim() : '';
	if (!sql) throw new BadRequest('"sql" is required');
	if (sql.length > 200_000) throw new BadRequest('"sql" is too long');
	const description = typeof b.description === 'string' && b.description.trim() ? b.description.trim().slice(0, 1000) : null;
	let connectionId: string | null = null;
	if (b.connectionId != null) {
		if (typeof b.connectionId !== 'string') throw new BadRequest('"connectionId" must be a string or null');
		const conn = getConnection(b.connectionId);
		if (!conn || !canSee(user, conn)) throw new BadRequest('Connection not found');
		connectionId = conn.id;
	}
	return { name, description, sql, connectionId, shared: b.shared === true };
}
