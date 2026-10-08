import { json } from '@sveltejs/kit';
import { redact, remember } from '#lib/server/discovery/cache.ts';
import { scanManagers } from '#lib/server/discovery/managers.ts';
import { handler } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = handler(async () => {
	const { scans, candidates } = await scanManagers();
	remember(candidates);
	return json(
		scans.map((s) => ({
			...s,
			environments: s.environments.map((e) => ({ ...e, projects: e.projects.map((p) => ({ ...p, candidates: redact(p.candidates) })) }))
		}))
	);
});
