import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { NotFound } from '#lib/server/engine.ts';
import { audit } from '#lib/server/permissions.ts';
import { checkSchedule, parseScheduleInput } from '#lib/server/backups/input.ts';
import { deleteSchedule, getSchedule, updateSchedule } from '#lib/server/backups/store.ts';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = handler(async ({ params, request, locals }) => {
	if (!getSchedule(params.id)) throw new NotFound('Schedule not found');
	const input = parseScheduleInput(await request.json());
	const detail = checkSchedule(input);
	const updated = updateSchedule(params.id, input);
	audit(locals, 'backup.schedule.update', { detail });
	return json(updated);
});

export const DELETE: RequestHandler = handler(({ params, locals }) => {
	const s = getSchedule(params.id);
	if (!s) throw new NotFound('Schedule not found');
	deleteSchedule(s.id);
	audit(locals, 'backup.schedule.delete', { detail: `${s.name} (existing backups are kept)` });
	return json({ ok: true });
});
