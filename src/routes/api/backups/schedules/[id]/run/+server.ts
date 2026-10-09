import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { NotFound } from '#lib/server/engine.ts';
import { audit } from '#lib/server/permissions.ts';
import { runSchedule } from '#lib/server/backups/runner.ts';
import { getSchedule } from '#lib/server/backups/store.ts';
import type { RequestHandler } from './$types';

/** "Run now": starts the schedule's backups in the background (doesn't move its next run). */
export const POST: RequestHandler = handler(({ params, locals }) => {
	const s = getSchedule(params.id);
	if (!s) throw new NotFound('Schedule not found');
	const runs = runSchedule(s, locals.user?.email ?? null);
	if (!runs.length) throw new BadRequest('This schedule has no connections to back up');
	audit(locals, 'backup.run', { detail: `${s.name}: ${runs.map((r) => r.connectionName).join(', ')} → ${runs[0].destinationName}` });
	return json(runs, { status: 202 });
});
