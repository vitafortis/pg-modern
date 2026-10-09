import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { NotFound } from '#lib/server/pg.ts';
import { audit } from '#lib/server/permissions.ts';
import { getConnection } from '#lib/server/store.ts';
import { canDeleteSnapshot, deleteSnapshot, getSnapshotData, getSnapshotMeta, publicMeta } from '#lib/server/schema-snapshots.ts';
import type { RequestHandler } from './$types';

function find(connectionId: string, id: string) {
	const meta = getSnapshotMeta(id);
	if (!meta || meta.connectionId !== connectionId) throw new NotFound('Snapshot not found');
	return meta;
}

/** One snapshot with its full normalized schema (e.g. to download as JSON). */
export const GET: RequestHandler = handler(({ params, locals }) => {
	const meta = find(params.id, params.sid);
	return json({ ...publicMeta(locals.user!, meta), schema: getSnapshotData(meta.id) });
});

/** The snapshot's author or an admin. */
export const DELETE: RequestHandler = handler(({ params, locals }) => {
	const meta = find(params.id, params.sid);
	if (!canDeleteSnapshot(locals.user!, meta)) return json({ message: 'Only its author or an admin can delete this snapshot' }, { status: 403 });
	deleteSnapshot(meta.id);
	audit(locals, 'schema.snapshot.delete', { connection: getConnection(params.id), detail: meta.label });
	return json({ ok: true });
});
