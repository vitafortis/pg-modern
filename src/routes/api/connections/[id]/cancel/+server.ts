import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { cancelRun } from '#lib/server/engine.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = handler(async ({ params, request }) => {
	const { runId } = await request.json();
	return json({ cancelled: await cancelRun(params.id, String(runId)) });
});
