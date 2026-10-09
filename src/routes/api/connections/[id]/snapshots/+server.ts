import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { NotFound } from '#lib/server/pg.ts';
import { audit } from '#lib/server/permissions.ts';
import { getConnection } from '#lib/server/store.ts';
import { getAutoSettings, liveSchema, listSnapshots, publicMeta, saveSnapshot } from '#lib/server/schema-snapshots.ts';
import { snapshotsSupported } from '#lib/server/schema-capture.ts';
import type { RequestHandler } from './$types';

/** The connection's snapshot history (newest first) and its auto-snapshot setting. */
export const GET: RequestHandler = handler(({ params, locals }) => {
	const conn = getConnection(params.id);
	if (!conn) throw new NotFound('Connection not found');
	return json({
		supported: snapshotsSupported(conn.engine),
		settings: getAutoSettings(conn.id),
		snapshots: listSnapshots(conn.id).map((m) => publicMeta(locals.user!, m))
	});
});

/** "Snapshot schema": anyone who can see the connection (access is checked in hooks). */
export const POST: RequestHandler = handler(async ({ params, request, locals }) => {
	const conn = getConnection(params.id);
	if (!conn) throw new NotFound('Connection not found');
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const label = typeof body.label === 'string' ? body.label.trim().slice(0, 120) : '';
	if (!label) throw new BadRequest('"label" is required');
	const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 2000) : null;
	const data = await liveSchema(conn.id, true);
	const meta = saveSnapshot(conn.id, data, { label, note, user: locals.user });
	audit(locals, 'schema.snapshot', { connection: conn, detail: label });
	return json(publicMeta(locals.user!, meta), { status: 201 });
});
