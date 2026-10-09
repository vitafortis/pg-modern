import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { NotFound } from '#lib/server/engine.ts';
import { audit } from '#lib/server/permissions.ts';
import { deleteChannel, getChannel, missingFields, resolveChannelInput, updateChannel } from '#lib/server/alerts/store.ts';
import { parseChannelInput } from '#lib/server/alerts/input.ts';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = handler(async ({ params, request, locals }) => {
	if (!getChannel(params.id)) throw new NotFound('Channel not found');
	const input = parseChannelInput(await request.json().catch(() => null));
	const { config, secrets } = resolveChannelInput(input, params.id);
	const missing = missingFields(input.kind, config, secrets);
	if (missing.length) throw new BadRequest(`Missing: ${missing.join(', ')}`);
	const channel = updateChannel(params.id, input)!;
	audit(locals, 'alerts.channel.update', { detail: `${channel.name}${channel.enabled ? '' : ' (disabled)'}` });
	return json(channel);
});

export const DELETE: RequestHandler = handler(({ params, locals }) => {
	const channel = getChannel(params.id);
	if (!channel || !deleteChannel(params.id)) throw new NotFound('Channel not found');
	audit(locals, 'alerts.channel.delete', { detail: channel.name });
	return json({ ok: true });
});
