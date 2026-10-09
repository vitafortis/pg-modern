import { json } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { listManagers } from '#lib/server/discovery/managers.ts';
import { BadRequest, handler } from '#lib/server/http.ts';
import { getSettings, saveSettings, setManagerKey } from '#lib/server/store.ts';
import { audit } from '#lib/server/permissions.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => json(listManagers());

export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const { name, url, apiKey } = await request.json();
	if (typeof url !== 'string' || !/^https?:\/\/.+/.test(url.trim())) throw new BadRequest('"url" must start with http:// or https://');
	if (typeof apiKey !== 'string' || !apiKey.trim()) throw new BadRequest('"apiKey" is required');
	const id = randomUUID();
	const settings = getSettings();
	const manager = { id, kind: 'arcane' as const, name: typeof name === 'string' && name.trim() ? name.trim() : 'Arcane', url: url.trim().replace(/\/+$/, '') };
	saveSettings({ ...settings, managers: [...(settings.managers ?? []), manager] });
	setManagerKey(id, apiKey.trim());
	audit(locals, 'settings.integration', { detail: `added Arcane ${manager.url}` });
	return json({ ...manager, hasKey: true }, { status: 201 });
});
