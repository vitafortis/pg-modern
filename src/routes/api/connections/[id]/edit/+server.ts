import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { isServerError, NotFound, toQueryError } from '#lib/server/engine.ts';
import { audit, readOnlyFor } from '#lib/server/permissions.ts';
import { addHistory, getConnection } from '#lib/server/store.ts';
import { tableMeta, writeTransaction } from '#lib/server/rows/db.ts';
import { applyPlanned, ChangeError, planChanges } from '#lib/server/rows/edit.ts';
import { MAX_IMPORT_BYTES } from '#lib/server/rows/import.ts';
import type { RequestHandler } from './$types';

const READ_ONLY = 'This connection is read-only for you. Unlock writes to edit rows.';

/** What can be edited in a table: its key, columns and whether this user may write now. */
export const GET: RequestHandler = handler(async ({ params, url, locals }) => {
	const schema = url.searchParams.get('schema');
	const table = url.searchParams.get('table');
	if (!schema || !table) throw new BadRequest('"schema" and "table" are required');
	const meta = await tableMeta(params.id, schema, table);
	return json({ ...meta, readOnly: readOnlyFor(locals.user, params.id), importMaxBytes: MAX_IMPORT_BYTES });
});

/**
 * Applies staged row changes in one transaction. With `dryRun`, only returns the
 * statements that would run (for review).
 */
export const POST: RequestHandler = handler(async ({ params, request, locals }) => {
	const conn = getConnection(params.id);
	if (!conn) throw new NotFound('Connection not found');
	const body = await request.json().catch(() => null);
	if (!body || typeof body.schema !== 'string' || typeof body.table !== 'string') throw new BadRequest('"schema" and "table" are required');
	const dryRun = body.dryRun === true;
	// Reviewing is harmless, but nobody without write access gets this far with Apply.
	if (!dryRun && readOnlyFor(locals.user, params.id)) return json({ message: READ_ONLY }, { status: 403 });

	const meta = await tableMeta(params.id, body.schema, body.table);
	let planned;
	try {
		planned = planChanges(meta, body.changes);
	} catch (err) {
		if (err instanceof ChangeError) throw new BadRequest(err.message);
		throw err;
	}
	const statements = planned.map((p) => p.stmt.display);
	if (dryRun) return json({ statements });

	const started = performance.now();
	const outcome = await writeTransaction(params.id, (tx) =>
		applyPlanned(tx, meta, planned, isServerError, (err) => toQueryError(err).message)
	);
	const { updated, inserted, deleted } = outcome.counts;
	addHistory({
		connectionId: params.id,
		sql: statements.map((s) => `${s};`).join('\n'),
		ok: outcome.commit,
		rowCount: outcome.commit ? updated + inserted + deleted : 0,
		durationMs: performance.now() - started,
		error: outcome.failed ? `Change ${outcome.failed.index + 1}: ${outcome.failed.reason} (rolled back)` : null,
		userId: locals.user?.id ?? null,
		userEmail: locals.user?.email ?? null,
		readOnly: false
	});
	if (!outcome.commit) {
		const f = outcome.failed!;
		return json(
			{ message: `Nothing was saved: change ${f.index + 1} failed. ${f.reason}`, failed: f, statements },
			{ status: f.conflict ? 409 : 422 }
		);
	}
	audit(locals, 'rows.edit', {
		connection: conn,
		detail: `${meta.schema}.${meta.table}: ${updated} updated, ${inserted} inserted, ${deleted} deleted`
	});
	return json({ ok: true, counts: outcome.counts, statements });
});
