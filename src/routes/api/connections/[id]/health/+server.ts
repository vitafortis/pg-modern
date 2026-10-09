import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { health } from '#lib/server/engine.ts';
import type { RequestHandler } from './$types';

/** Runs the health checks (read-only catalog queries). Anyone who can see the connection may run them. */
export const GET: RequestHandler = handler(async ({ params }) => {
	const report = await health(params.id);
	if (!report) return json({ message: 'Health checks aren’t available for this engine' }, { status: 404 });
	return json(report);
});
