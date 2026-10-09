import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { NotFound } from '#lib/server/pg.ts';
import { getSettings, saveSettings, setManagerKey } from '#lib/server/store.ts';
import { audit } from '#lib/server/permissions.ts';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = handler(({ params, locals }) => {
	const settings = getSettings();
	const managers = settings.managers ?? [];
	if (!managers.some((m) => m.id === params.id)) throw new NotFound('Manager not found (environment-configured managers can only be removed there)');
	saveSettings({ ...settings, managers: managers.filter((m) => m.id !== params.id) });
	setManagerKey(params.id, null);
	audit(locals, 'settings.integration', { detail: `removed Arcane ${managers.find((m) => m.id === params.id)?.url}` });
	return json({ ok: true });
});
