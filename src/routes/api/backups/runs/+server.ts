import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { getConnection } from '#lib/server/store.ts';
import { startBackup, supportsBackup } from '#lib/server/backups/runner.ts';
import { getDestination, listRuns } from '#lib/server/backups/store.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = handler(({ url }) => {
	return json(listRuns({ connectionId: url.searchParams.get('connection') ?? undefined, limit: Number(url.searchParams.get('limit')) || 200 }));
});

/** An ad hoc backup of one connection to a destination; starts in the background. */
export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const body = await request.json().catch(() => ({}));
	const conn = typeof body.connectionId === 'string' ? getConnection(body.connectionId) : undefined;
	if (!conn) throw new BadRequest('Choose a connection');
	if (!supportsBackup(conn)) throw new BadRequest(`Backups aren't supported for ${conn.engine} connections`);
	const dest = typeof body.destinationId === 'string' ? getDestination(body.destinationId) : undefined;
	if (!dest) throw new BadRequest('Choose a destination');
	const { run } = startBackup({ connectionId: conn.id, destinationId: dest.id, compress: body.compress !== false, createdBy: locals.user?.email ?? null });
	audit(locals, 'backup.run', { connection: conn, detail: `→ ${dest.name}: ${run.fileName}` });
	return json(run, { status: 202 });
});
