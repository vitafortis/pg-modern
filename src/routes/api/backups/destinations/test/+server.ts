import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { parseDestinationInput } from '#lib/server/backups/input.ts';
import { describeDestination, testDestination } from '#lib/server/backups/destinations.ts';
import { getDestinationSecrets, mergeSecrets } from '#lib/server/backups/store.ts';
import type { RequestHandler } from './$types';

/**
 * Writes, reads back and deletes a small file. With `id`, secrets left blank in the
 * form fall back to the stored ones, so a saved destination tests without retyping them.
 */
export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const body = await request.json();
	const { name, dest, secrets } = parseDestinationInput(body);
	const stored = typeof body.id === 'string' ? getDestinationSecrets(body.id) : {};
	try {
		const r = await testDestination(dest, mergeSecrets(stored, secrets));
		audit(locals, 'backup.destination.test', { detail: `${name} — ${describeDestination(dest)}: ok` });
		return json({ ok: true, ...r });
	} catch (err) {
		audit(locals, 'backup.destination.test', { detail: `${name} — ${describeDestination(dest)}: ${(err as Error).message}` });
		return json({ ok: false, error: (err as Error).message });
	}
});
