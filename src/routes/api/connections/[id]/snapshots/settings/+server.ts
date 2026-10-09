import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { NotFound } from '#lib/server/pg.ts';
import { audit } from '#lib/server/permissions.ts';
import { getConnection } from '#lib/server/store.ts';
import { getAutoSettings, setAutoSnapshot } from '#lib/server/schema-snapshots.ts';
import { snapshotsSupported } from '#lib/server/schema-capture.ts';
import type { RequestHandler } from './$types';

/** Turns the scheduled schema check on or off for this connection (admins). */
export const PUT: RequestHandler = handler(async ({ params, request, locals }) => {
	if (locals.user?.role !== 'admin') return json({ message: 'Admins only' }, { status: 403 });
	const conn = getConnection(params.id);
	if (!conn) throw new NotFound('Connection not found');
	if (!snapshotsSupported(conn.engine)) throw new BadRequest('Schema snapshots aren’t supported for this engine yet');
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	if (typeof body.auto !== 'boolean') throw new BadRequest('"auto" must be true or false');
	setAutoSnapshot(conn.id, body.auto);
	audit(locals, body.auto ? 'schema.auto.enable' : 'schema.auto.disable', { connection: conn });
	return json(getAutoSettings(conn.id));
});
