import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { missingFields, resolveChannelInput } from '#lib/server/alerts/store.ts';
import { parseChannelInput } from '#lib/server/alerts/input.ts';
import { deliver } from '#lib/server/alerts/notify.ts';
import { notificationFor } from '#lib/server/alerts/job.ts';
import type { RequestHandler } from './$types';

/**
 * Sends a test notification with the form's values; blank secret fields fall back to
 * the stored channel's (`id`), so a saved channel can be tested without retyping them.
 */
export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const input = parseChannelInput(body);
	const id = typeof body?.id === 'string' ? body.id : undefined;
	const { config, secrets } = resolveChannelInput(input, id);
	const missing = missingFields(input.kind, config, secrets);
	if (missing.length) throw new BadRequest(`Missing: ${missing.join(', ')}`);
	const n = notificationFor(null, null, 'test', `Test notification from pg·modern, sent by ${locals.user?.email ?? 'an admin'}. Alerts arrive like this.`);
	audit(locals, 'alerts.channel.test', { detail: input.name });
	try {
		await deliver(input.kind, config, secrets, n);
		return json({ ok: true });
	} catch (err) {
		return json({ ok: false, error: (err as Error).message });
	}
});
