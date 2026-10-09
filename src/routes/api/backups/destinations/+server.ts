import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { parseDestinationInput } from '#lib/server/backups/input.ts';
import { describeDestination } from '#lib/server/backups/destinations.ts';
import { createDestination } from '#lib/server/backups/store.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const { name, dest, secrets } = parseDestinationInput(await request.json());
	const created = createDestination(name, dest, secrets);
	audit(locals, 'backup.destination.create', { detail: `${name} — ${describeDestination(created)}` });
	return json(created, { status: 201 });
});
