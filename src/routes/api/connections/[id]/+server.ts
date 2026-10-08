import { json } from '@sveltejs/kit';
import { handler, parseConnectionInput } from '#lib/server/http.ts';
import { closePool, NotFound } from '#lib/server/pg.ts';
import { deleteConnection, getConnection, updateConnection } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = handler(({ params }) => {
	const conn = getConnection(params.id);
	if (!conn) throw new NotFound('Connection not found');
	return json(conn);
});

export const PUT: RequestHandler = handler(async ({ params, request }) => {
	const conn = updateConnection(params.id, parseConnectionInput(await request.json()));
	if (!conn) throw new NotFound('Connection not found');
	closePool(params.id);
	return json(conn);
});

export const DELETE: RequestHandler = handler(({ params }) => {
	closePool(params.id);
	if (!deleteConnection(params.id)) throw new NotFound('Connection not found');
	return json({ ok: true });
});
