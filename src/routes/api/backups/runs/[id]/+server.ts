import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { NotFound } from '#lib/server/engine.ts';
import { audit } from '#lib/server/permissions.ts';
import { deleteRunFile } from '#lib/server/backups/runner.ts';
import { deleteRunRecord, getRun } from '#lib/server/backups/store.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = handler(({ params }) => {
	const run = getRun(params.id);
	if (!run) throw new NotFound('Run not found');
	return json(run);
});

/** Deletes the backup file from its destination and removes the run from the list. */
export const DELETE: RequestHandler = handler(async ({ params, locals }) => {
	const run = getRun(params.id);
	if (!run) throw new NotFound('Run not found');
	if (run.status === 'running') throw new BadRequest('This run is still going');
	try {
		await deleteRunFile(run);
	} catch (err) {
		throw new BadRequest(`Couldn't delete the file: ${(err as Error).message}`);
	}
	deleteRunRecord(run.id);
	audit(locals, 'backup.delete', {
		connection: run.connectionId ? { id: run.connectionId, name: run.connectionName } : undefined,
		detail: run.kind === 'backup' && run.fileName ? `${run.destinationName}: ${run.fileName}` : `${run.kind} record`
	});
	return json({ ok: true });
});
