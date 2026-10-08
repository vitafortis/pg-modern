import { json } from '@sveltejs/kit';
import { redact, remember } from '#lib/server/discovery/cache.ts';
import { scanFiles } from '#lib/server/discovery/files.ts';
import { handler } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = handler(async ({ request }) => {
	const body = await request.json().catch(() => ({}));
	const extra = Array.isArray(body.paths) ? body.paths.filter((p: unknown) => typeof p === 'string') : [];
	const { result, candidates } = await scanFiles(extra);
	remember(candidates);
	return json({ ...result, files: result.files.map((f) => ({ ...f, candidates: redact(f.candidates) })) });
});
