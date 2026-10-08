import { json } from '@sveltejs/kit';
import { handler, parseConnectionInput } from '#lib/server/http.ts';
import { createConnection, listConnections } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => json(listConnections());

export const POST: RequestHandler = handler(async ({ request }) => {
	const input = parseConnectionInput(await request.json());
	return json(createConnection({ ...input, source: { kind: 'manual' } }), { status: 201 });
});
