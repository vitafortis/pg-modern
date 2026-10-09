import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { jobStatuses } from '#lib/server/jobs.ts';
import { activeAlerts, alertSettings, listEvents } from '#lib/server/alerts/store.ts';
import { ALERT_JOB } from '#lib/server/alerts/job.ts';
import { SIZE_JOB } from '#lib/server/size-sampler.ts';
import type { RequestHandler } from './$types';

/** Admins: firing alerts, the event history (paged with `before`), settings and job status. */
export const GET: RequestHandler = handler(({ url }) => {
	const p = url.searchParams;
	const events = listEvents({ before: Number(p.get('before')) || undefined, limit: Number(p.get('limit')) || 100, connectionId: p.get('connection') || undefined });
	const jobs = jobStatuses().filter((j) => j.name === ALERT_JOB || j.name === SIZE_JOB);
	return json({ active: activeAlerts(), events, settings: alertSettings(), jobs });
});
