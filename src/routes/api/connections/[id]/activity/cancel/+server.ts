import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { signalBackend } from '#lib/server/activity.ts';
import { NotFound, toQueryError } from '#lib/server/pg.ts';
import { accessFor, audit } from '#lib/server/permissions.ts';
import { getConnection } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

/** Cancels a backend's current query, or terminates the session; needs write access right now. */
export const POST: RequestHandler = handler(async ({ params, request, locals }) => {
	const conn = getConnection(params.id);
	if (!conn || !locals.user) throw new NotFound('Connection not found');
	if (accessFor(locals.user, conn).readOnly) {
		return json({ message: 'Unlock writes on this connection first to cancel or terminate sessions' }, { status: 403 });
	}
	const body = await request.json().catch(() => ({}));
	const pid = Number(body.pid);
	if (!Number.isInteger(pid) || pid <= 0) throw new BadRequest('"pid" must be a positive integer');
	const terminate = body.terminate === true;
	const action = terminate ? 'session.terminate' : 'session.cancel';

	let outcome;
	try {
		outcome = await signalBackend(conn.id, pid, terminate);
	} catch (err) {
		audit(locals, action, { connection: conn, detail: `pid ${pid} — failed: ${toQueryError(err).message}` });
		throw err;
	}
	if (outcome.status === 'self') throw new BadRequest('That is pg·modern’s own session for this request');
	if (outcome.status === 'missing') throw new NotFound(`No session with pid ${pid}`);

	const t = outcome.target;
	const who = [t.user, t.app, t.database && `db ${t.database}`, t.queryStart && `query started ${t.queryStart}`].filter(Boolean).join(', ');
	const query = t.query ? ` — ${t.query.replace(/\s+/g, ' ').trim().slice(0, 160)}` : '';
	audit(locals, action, { connection: conn, detail: `pid ${pid} (${who})${outcome.ok ? '' : ' — not signalled'}${query}` });
	return json({ ok: outcome.ok, pid, terminate });
});
