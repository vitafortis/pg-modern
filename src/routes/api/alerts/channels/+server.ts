import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { createChannel, listChannels, missingFields, resolveChannelInput, seedDefaultRulesOnce } from '#lib/server/alerts/store.ts';
import { parseChannelInput } from '#lib/server/alerts/input.ts';
import { CHANNELS } from '#lib/alerts.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = handler(() => json(listChannels()));

/** Adds a channel. The first channel also adds the default alert rules. */
export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const input = parseChannelInput(await request.json().catch(() => null));
	const { config, secrets } = resolveChannelInput(input);
	const missing = missingFields(input.kind, config, secrets);
	if (missing.length) throw new BadRequest(`Missing: ${missing.join(', ')}`);
	const channel = createChannel(input);
	const seeded = seedDefaultRulesOnce();
	audit(locals, 'alerts.channel.create', {
		detail: `${channel.name} (${CHANNELS[channel.kind].label})${seeded.length ? `; added ${seeded.length} default rules` : ''}`
	});
	return json({ channel, seededRules: seeded.length }, { status: 201 });
});
