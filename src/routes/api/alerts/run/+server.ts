import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { activeAlerts } from '#lib/server/alerts/store.ts';
import { runChecks } from '#lib/server/alerts/job.ts';
import type { RequestHandler } from './$types';

/** Runs every check now (the "Check now" button), then returns the firing alerts. */
export const POST: RequestHandler = handler(async () => {
	await runChecks();
	return json({ active: activeAlerts() });
});
