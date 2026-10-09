import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { NotFound } from '#lib/server/pg.ts';
import { audit, canSee } from '#lib/server/permissions.ts';
import { decorate, parseSavedInput, visibleSavedQueries } from '#lib/server/saved.ts';
import { createSavedQuery, getConnection } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

/** Own and shared saved queries; `?connection=<id>` limits them to that connection (and connection-less ones). */
export const GET: RequestHandler = handler(({ url, locals }) => {
	const user = locals.user!;
	const connectionId = url.searchParams.get('connection');
	if (connectionId) {
		const conn = getConnection(connectionId);
		if (!conn || !canSee(user, conn)) throw new NotFound('Connection not found');
	}
	return json(visibleSavedQueries(user, connectionId ?? undefined));
});

export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const user = locals.user!;
	const input = parseSavedInput(user, await request.json().catch(() => null));
	const q = createSavedQuery(user, input);
	if (q.shared) {
		const conn = q.connectionId ? getConnection(q.connectionId) : undefined;
		audit(locals, 'query.save', { connection: conn, detail: `${q.name} (shared)` });
	}
	return json(decorate(user, q), { status: 201 });
});
