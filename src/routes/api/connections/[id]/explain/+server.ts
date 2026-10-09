import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { explainProblem, explainStatement, modifiesData, toQueryError } from '#lib/server/pg.ts';
import { readOnlyFor } from '#lib/server/permissions.ts';
import { addHistory } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

const isServerError = (err: unknown) =>
	!!err && typeof err === 'object' && 'severity' in err && typeof (err as { code?: unknown }).code === 'string';

/**
 * EXPLAIN (FORMAT JSON) for one statement, always inside a transaction that is rolled
 * back. Read-only unless the user has write access and asks to ANALYZE a write.
 */
export const POST: RequestHandler = handler(async ({ params, request, locals }) => {
	const body = await request.json().catch(() => ({}));
	const sql = typeof body.sql === 'string' ? body.sql.trim() : '';
	if (!sql) throw new BadRequest('"sql" is required');
	const analyze = body.analyze === true;
	const problem = explainProblem(sql);
	if (problem) throw new BadRequest(problem);

	const readOnly = readOnlyFor(locals.user, params.id);
	const started = performance.now();
	const record = (ok: boolean, error: string | null, ranReadOnly: boolean) =>
		addHistory({
			connectionId: params.id,
			sql,
			ok,
			rowCount: null,
			durationMs: performance.now() - started,
			error,
			userId: locals.user?.id ?? null,
			userEmail: locals.user?.email ?? null,
			readOnly: ranReadOnly
		});

	try {
		const outcome = await explainStatement(params.id, sql, {
			analyze,
			readOnly,
			runId: typeof body.runId === 'string' ? body.runId : undefined
		});
		record(true, null, outcome.readOnly);
		return json(outcome);
	} catch (err) {
		if (!isServerError(err)) throw err;
		// Syntax errors, missing tables, read-only violations: the user's to fix.
		const e = toQueryError(err);
		record(false, e.message, readOnly || !(analyze && modifiesData(sql)));
		return json(e, { status: 400 });
	}
});
