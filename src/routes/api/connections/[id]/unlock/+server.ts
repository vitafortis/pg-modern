import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { closePool, NotFound } from '#lib/server/pg.ts';
import { accessFor, audit } from '#lib/server/permissions.ts';
import { clearUnlock, getConnection, setUnlock } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

/** Temporary write access to a read-only connection: 5–60 minutes, logged with a reason. */
export const POST: RequestHandler = handler(async ({ params, request, locals }) => {
	const conn = getConnection(params.id);
	if (!conn || !locals.user) throw new NotFound('Connection not found');
	if (accessFor(locals.user, conn).write !== 'unlock') throw new BadRequest('You can’t unlock writes on this connection');
	const body = await request.json().catch(() => ({}));
	const minutes = Math.min(60, Math.max(5, Math.round(Number(body.minutes) || 15)));
	const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 300) : null;
	setUnlock(locals.user.id, conn.id, Date.now() + minutes * 60_000, reason);
	audit(locals, 'write.unlock', { connection: conn, detail: `${minutes} min${reason ? ` — ${reason}` : ''}` });
	return json(accessFor(locals.user, conn));
});

export const DELETE: RequestHandler = handler(({ params, locals }) => {
	const conn = getConnection(params.id);
	if (!conn || !locals.user) throw new NotFound('Connection not found');
	clearUnlock(locals.user.id, conn.id);
	// Drop the writable sessions too, so nothing keeps write access after relocking.
	if (conn.readOnly) closePool(conn.id);
	audit(locals, 'write.relock', { connection: conn });
	return json(accessFor(locals.user, conn));
});
