import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { NotFound } from '#lib/server/engine.ts';
import { refreshSnapshot } from '#lib/server/sqlite/archive.ts';
import { getConnection } from '#lib/server/store.ts';
import { audit, withAccess } from '#lib/server/permissions.ts';
import type { RequestHandler } from './$types';

/**
 * Copies a SQLite snapshot connection's database out of its container again. Anyone
 * who can see the connection may refresh it: it only re-reads the same file.
 */
export const POST: RequestHandler = handler(async ({ params, locals }) => {
	const conn = getConnection(params.id);
	if (!conn) throw new NotFound('Connection not found');
	if (!conn.snapshot) throw new BadRequest('This connection isn’t a SQLite snapshot');
	try {
		const snapshot = await refreshSnapshot(conn.id);
		audit(locals, 'sqlite.snapshot', {
			connection: conn,
			detail: `${snapshot.container}:${snapshot.containerPath} (${snapshot.bytes ?? 0} bytes${snapshot.wal ? ', with -wal' : ''})`
		});
	} catch (err) {
		audit(locals, 'sqlite.snapshot', { connection: conn, detail: `failed: ${(err as Error).message}` });
		return json({ message: (err as Error).message, connection: withAccess(locals.user, getConnection(conn.id)!) }, { status: 502 });
	}
	return json(withAccess(locals.user, getConnection(conn.id)!));
});
