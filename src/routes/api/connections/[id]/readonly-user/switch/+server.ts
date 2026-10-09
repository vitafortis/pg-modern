import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { closePool, NotFound, testTarget } from '#lib/server/engine.ts';
import { audit, withAccess } from '#lib/server/permissions.ts';
import { getConnection, updateConnection } from '#lib/server/store.ts';
import { forgetPrivileges } from '#lib/server/readonly-user-db.ts';
import type { RequestHandler } from './$types';

/**
 * Points a saved connection at another user (the generated read-only one), after
 * checking the new credentials actually connect. The password is stored encrypted
 * like any other connection password.
 */
export const POST: RequestHandler = handler(async ({ params, request, locals }) => {
	if (locals.user?.role !== 'admin') return json({ message: 'Admins only' }, { status: 403 });
	const conn = getConnection(params.id);
	if (!conn) throw new NotFound('Connection not found');
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const user = typeof body.user === 'string' ? body.user.trim() : '';
	const password = typeof body.password === 'string' ? body.password : '';
	if (!user) throw new BadRequest('"user" is required');
	if (!password) throw new BadRequest('"password" is required');

	const test = await testTarget({ ...conn, user, password });
	if (!test.ok) {
		audit(locals, 'connection.switch-user', { connection: conn, detail: `${conn.user} → ${user} — test failed: ${test.error.message}` });
		return json({ ...test.error, message: `Couldn’t connect as ${user}: ${test.error.message}` }, { status: 400 });
	}
	const updated = updateConnection(conn.id, {
		engine: conn.engine,
		name: conn.name,
		host: conn.host,
		port: conn.port,
		database: conn.database,
		user,
		password,
		sslMode: conn.sslMode,
		readOnly: conn.readOnly,
		color: conn.color
	});
	if (!updated) throw new NotFound('Connection not found');
	closePool(conn.id);
	forgetPrivileges(conn.id);
	audit(locals, 'connection.switch-user', { connection: updated, detail: `${conn.user} → ${user}, password changed` });
	return json(withAccess(locals.user, updated));
});
