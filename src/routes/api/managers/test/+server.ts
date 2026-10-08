import { json } from '@sveltejs/kit';
import { testManager } from '#lib/server/discovery/managers.ts';
import { BadRequest, handler } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = handler(async ({ request }) => {
	const { url, apiKey, id } = await request.json();
	if (typeof url !== 'string' || !url.trim()) throw new BadRequest('"url" is required');
	return json(await testManager(url.trim(), typeof apiKey === 'string' ? apiKey.trim() : undefined, typeof id === 'string' ? id : undefined));
});
