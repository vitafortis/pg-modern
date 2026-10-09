import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { NotFound } from '#lib/server/engine.ts';
import { accessFor, audit } from '#lib/server/permissions.ts';
import { getConnection } from '#lib/server/store.ts';
import { restoreConfirmation, restoreProblem, startRestore } from '#lib/server/backups/runner.ts';
import { getRun } from '#lib/server/backups/store.ts';
import type { RequestHandler } from './$types';

/**
 * Restores a backup into its own or another connection of the same engine (admins only).
 * The target must accept the admin's writes right now — a read/write connection or one
 * they've unlocked — and the database name must be typed to confirm.
 */
export const POST: RequestHandler = handler(async ({ params, request, locals }) => {
	const run = getRun(params.id);
	if (!run) throw new NotFound('Run not found');
	const body = await request.json().catch(() => ({}));
	const targetId = typeof body.targetConnectionId === 'string' && body.targetConnectionId ? body.targetConnectionId : run.connectionId;
	const target = targetId ? getConnection(targetId) : undefined;
	if (!target || !locals.user) throw new BadRequest('Choose a connection to restore into');
	const problem = restoreProblem(run, target);
	if (problem) throw new BadRequest(problem);
	if (accessFor(locals.user, target).readOnly) {
		throw new BadRequest(`${target.name} is read-only. Unlock writes on it first (open the connection and choose Unlock), then restore.`);
	}
	const expected = restoreConfirmation(run, target);
	if (typeof body.confirm !== 'string' || body.confirm.trim() !== expected) {
		throw new BadRequest(`Type "${expected}" to confirm`);
	}
	const { run: restore } = startRestore({ run, target, createdBy: locals.user.email });
	audit(locals, 'backup.restore', {
		connection: target,
		detail: `from ${run.connectionName} backup of ${new Date(run.startedAt).toISOString()} (${run.destinationName}: ${run.fileName})`
	});
	return json(restore, { status: 202 });
});
