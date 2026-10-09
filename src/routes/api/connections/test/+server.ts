import { json } from '@sveltejs/kit';
import { handler, parseConnectionInput } from '#lib/server/http.ts';
import { testTarget } from '#lib/server/engine.ts';
import { getPassword } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

/** Tests unsaved settings. When editing, `id` lets the stored password stand in for a blank field. */
export const POST: RequestHandler = handler(async ({ request }) => {
	const body = await request.json();
	const input = parseConnectionInput(body);
	const password = input.password ?? (typeof body.id === 'string' ? getPassword(body.id) : undefined);
	return json(await testTarget({ ...input, password }));
});
