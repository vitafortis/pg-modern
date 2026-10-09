import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { NotFound } from '#lib/server/engine.ts';
import { audit } from '#lib/server/permissions.ts';
import { parseDestinationInput } from '#lib/server/backups/input.ts';
import { describeDestination } from '#lib/server/backups/destinations.ts';
import { deleteDestination, getDestination, schedulesUsingDestination, updateDestination } from '#lib/server/backups/store.ts';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = handler(async ({ params, request, locals }) => {
	const { name, dest, secrets } = parseDestinationInput(await request.json());
	const updated = updateDestination(params.id, name, dest, secrets);
	if (!updated) throw new NotFound('Destination not found');
	const changedSecrets = Object.values(secrets).some((v) => v !== undefined);
	audit(locals, 'backup.destination.update', { detail: `${name} — ${describeDestination(updated)}${changedSecrets ? ', credentials changed' : ''}` });
	return json(updated);
});

export const DELETE: RequestHandler = handler(({ params, locals }) => {
	const dest = getDestination(params.id);
	if (!dest) throw new NotFound('Destination not found');
	const used = schedulesUsingDestination(dest.id);
	if (used) throw new BadRequest(`${used} schedule${used === 1 ? ' uses' : 's use'} this destination; change or delete ${used === 1 ? 'it' : 'them'} first`);
	deleteDestination(dest.id);
	audit(locals, 'backup.destination.delete', { detail: `${dest.name} — ${describeDestination(dest)} (files are left in place)` });
	return json({ ok: true });
});
