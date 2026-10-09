import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { checkSchedule, parseScheduleInput } from '#lib/server/backups/input.ts';
import { createSchedule } from '#lib/server/backups/store.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const input = parseScheduleInput(await request.json());
	const detail = checkSchedule(input);
	const created = createSchedule(input);
	audit(locals, 'backup.schedule.create', { detail });
	return json(created, { status: 201 });
});
