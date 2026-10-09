import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { NotFound } from '#lib/server/pg.ts';
import { audit } from '#lib/server/permissions.ts';
import { canEditSaved, canSeeSaved, decorate, parseSavedInput } from '#lib/server/saved.ts';
import { deleteSavedQuery, getConnection, getSavedQuery, updateSavedQuery } from '#lib/server/store.ts';
import type { User } from '#lib/types.ts';
import type { RequestHandler } from './$types';

/** The saved query, if this user may change it (owner or admin). Others get 404 or 403. */
function editable(user: User, id: string) {
	const q = getSavedQuery(id);
	// Admins can manage anything shared, but someone's private queries stay invisible.
	if (!q || !(canSeeSaved(user, q) || (user.role === 'admin' && q.shared))) throw new NotFound('Saved query not found');
	if (!canEditSaved(user, q)) throw json({ message: 'Only its owner or an admin can change this query' }, { status: 403 });
	return q;
}

const connectionOf = (id: string | null) => (id ? getConnection(id) : undefined);

export const GET: RequestHandler = handler(({ params, locals }) => {
	const q = getSavedQuery(params.id);
	if (!q || !canSeeSaved(locals.user, q)) throw new NotFound('Saved query not found');
	return json(decorate(locals.user!, q));
});

export const PUT: RequestHandler = handler(async ({ params, request, locals }) => {
	const user = locals.user!;
	const before = editable(user, params.id);
	const input = parseSavedInput(user, await request.json().catch(() => null));
	const q = updateSavedQuery(before.id, input)!;
	if (before.shared || q.shared) {
		const change = before.shared && !q.shared ? ' (unshared)' : !before.shared && q.shared ? ' (shared)' : '';
		audit(locals, 'query.save', { connection: connectionOf(q.connectionId), detail: `${q.name}${change}` });
	}
	return json(decorate(user, q));
});

export const DELETE: RequestHandler = handler(({ params, locals }) => {
	const q = editable(locals.user!, params.id);
	deleteSavedQuery(q.id);
	if (q.shared) audit(locals, 'query.delete', { connection: connectionOf(q.connectionId), detail: q.name });
	return json({ ok: true });
});
