import { json } from '@sveltejs/kit';
import { redact, remember } from '#lib/server/discovery/cache.ts';
import { discoverDocker } from '#lib/server/discovery/docker.ts';
import { handler } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = handler(async () => {
	const { groups, candidates } = await discoverDocker();
	remember(candidates);
	return json(
		groups.map((g) => ({ ...g, containers: g.containers.map((c) => ({ ...c, candidates: redact(c.candidates) })) }))
	);
});
