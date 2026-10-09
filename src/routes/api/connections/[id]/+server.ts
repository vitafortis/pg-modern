import { json } from '@sveltejs/kit';
import { handler, parseConnectionInput } from '#lib/server/http.ts';
import { closePool, NotFound } from '#lib/server/pg.ts';
import { deleteConnection, getConnection, updateConnection } from '#lib/server/store.ts';
import { audit, withAccess } from '#lib/server/permissions.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = handler(({ params, locals }) => {
	const conn = getConnection(params.id);
	if (!conn) throw new NotFound('Connection not found');
	return json(withAccess(locals.user, conn));
});

export const PUT: RequestHandler = handler(async ({ params, request, locals }) => {
	const before = getConnection(params.id);
	const input = parseConnectionInput(await request.json());
	const conn = updateConnection(params.id, input);
	if (!conn || !before) throw new NotFound('Connection not found');
	closePool(params.id);
	const changes = [
		before.readOnly !== conn.readOnly && (conn.readOnly ? 'now read-only' : 'now read/write'),
		(before.host !== conn.host || before.port !== conn.port) && `address ${conn.host}:${conn.port}`,
		input.password !== undefined && 'password changed'
	].filter(Boolean);
	audit(locals, 'connection.update', { connection: conn, detail: changes.join(', ') || undefined });
	return json(withAccess(locals.user, conn));
});

export const DELETE: RequestHandler = handler(({ params, locals }) => {
	closePool(params.id);
	const conn = getConnection(params.id);
	if (!conn || !deleteConnection(params.id)) throw new NotFound('Connection not found');
	audit(locals, 'connection.delete', { connection: conn, detail: `${conn.user}@${conn.host}:${conn.port}/${conn.database}` });
	return json({ ok: true });
});
