import { json } from '@sveltejs/kit';
import { audit } from '#lib/server/permissions.ts';
import { clearHistory, getConnection, listHistory } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

/** Admins see everyone's queries on a connection; others only their own. */
const ownOnly = (user: App.Locals['user']) => (user?.role === 'admin' ? undefined : (user?.id ?? '-'));

export const GET: RequestHandler = ({ params, locals }) => json(listHistory(params.id, 100, ownOnly(locals.user)));

export const DELETE: RequestHandler = ({ params, locals }) => {
	clearHistory(params.id, ownOnly(locals.user));
	const conn = getConnection(params.id);
	if (conn && locals.user?.role === 'admin') audit(locals, 'history.clear', { connection: conn });
	return json({ ok: true });
};
