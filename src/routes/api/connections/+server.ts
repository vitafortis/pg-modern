import { json } from '@sveltejs/kit';
import { handler, parseConnectionInput } from '#lib/server/http.ts';
import { createConnection } from '#lib/server/store.ts';
import { audit, visibleConnections, withAccess } from '#lib/server/permissions.ts';
import { connectionAddress } from '#lib/engine.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => json(visibleConnections(locals.user));

export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const input = parseConnectionInput(await request.json());
	const conn = createConnection({ ...input, source: { kind: 'manual' } });
	audit(locals, 'connection.create', { connection: conn, detail: connectionAddress(conn) });
	return json(withAccess(locals.user, conn), { status: 201 });
});
