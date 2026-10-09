import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { NotFound } from '#lib/server/pg.ts';
import { audit } from '#lib/server/permissions.ts';
import { getConnection } from '#lib/server/store.ts';
import { checkForChanges, getAutoSettings, publicMeta } from '#lib/server/schema-snapshots.ts';
import type { RequestHandler } from './$types';

/** Runs the scheduled change check for this connection now (admins). */
export const POST: RequestHandler = handler(async ({ params, locals }) => {
	if (locals.user?.role !== 'admin') return json({ message: 'Admins only' }, { status: 403 });
	const conn = getConnection(params.id);
	if (!conn) throw new NotFound('Connection not found');
	const r = await checkForChanges(conn.id);
	if (r.changed) audit(locals, 'schema.snapshot', { connection: conn, detail: `${r.snapshot.label} (auto check)` });
	return json({ changed: r.changed, hash: r.hash, snapshot: r.changed ? publicMeta(locals.user, r.snapshot) : null, settings: getAutoSettings(conn.id) });
});
