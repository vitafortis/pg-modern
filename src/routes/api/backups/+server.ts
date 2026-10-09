import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { toolStatus } from '#lib/server/backups/tools.ts';
import { describeDestination } from '#lib/server/backups/destinations.ts';
import { listDestinations, listRuns, listSchedules } from '#lib/server/backups/store.ts';
import type { RequestHandler } from './$types';

/** Everything the Backups page shows: client tools, destinations, schedules and recent runs (admins only). */
export const GET: RequestHandler = handler(async ({ url }) => {
	return json({
		tools: await toolStatus(url.searchParams.has('fresh')),
		timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		destinations: listDestinations().map((d) => ({ ...d, where: describeDestination(d) })),
		schedules: listSchedules(),
		runs: listRuns({ limit: 300 })
	});
});
