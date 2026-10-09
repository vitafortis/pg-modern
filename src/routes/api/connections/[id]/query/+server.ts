import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { runScript } from '#lib/server/pg.ts';
import { readOnlyFor } from '#lib/server/permissions.ts';
import { isDestructive, splitStatements } from '#lib/server/sql.ts';
import { addHistory } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = handler(async ({ params, request, locals }) => {
	const { sql, runId, confirmed } = await request.json();
	if (typeof sql !== 'string' || !sql.trim()) throw new BadRequest('"sql" is required');
	const readOnly = readOnlyFor(locals.user, params.id);

	// With write access, statements that drop or wipe data need an explicit second step.
	if (!readOnly && confirmed !== true) {
		const destructive = splitStatements(sql).filter(isDestructive);
		if (destructive.length) {
			return json({ message: 'Confirm destructive statements', confirm: destructive }, { status: 409 });
		}
	}

	const started = performance.now();
	const outcome = await runScript(params.id, sql, { runId: typeof runId === 'string' ? runId : undefined, readOnly });
	const last = outcome.results.at(-1);
	addHistory({
		connectionId: params.id,
		sql: sql.trim(),
		ok: !outcome.error,
		rowCount: last?.rowCount ?? last?.rows.length ?? null,
		durationMs: performance.now() - started,
		error: outcome.error?.message ?? null,
		userId: locals.user?.id ?? null,
		userEmail: locals.user?.email ?? null,
		readOnly
	});
	return json(outcome);
});
