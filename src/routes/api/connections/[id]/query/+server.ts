import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { runScript } from '#lib/server/pg.ts';
import { addHistory } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = handler(async ({ params, request, locals }) => {
	const { sql, runId } = await request.json();
	if (typeof sql !== 'string' || !sql.trim()) throw new BadRequest('"sql" is required');
	const started = performance.now();
	const outcome = await runScript(params.id, sql, {
		runId: typeof runId === 'string' ? runId : undefined,
		forceReadOnly: locals.user?.role !== 'admin'
	});
	const last = outcome.results.at(-1);
	addHistory({
		connectionId: params.id,
		sql: sql.trim(),
		ok: !outcome.error,
		rowCount: last?.rowCount ?? last?.rows.length ?? null,
		durationMs: performance.now() - started,
		error: outcome.error?.message ?? null
	});
	return json(outcome);
});
