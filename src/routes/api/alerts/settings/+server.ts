import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { saveAlertSettings } from '#lib/server/alerts/store.ts';
import { parseSettings } from '#lib/server/alerts/input.ts';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = handler(async ({ request, locals }) => {
	const settings = parseSettings(await request.json().catch(() => null));
	saveAlertSettings(settings);
	audit(locals, 'alerts.settings', {
		detail: `every ${settings.intervalSeconds}s, re-notify ${settings.renotifyHours ? `after ${settings.renotifyHours}h` : 'never'}`
	});
	return json(settings);
});
