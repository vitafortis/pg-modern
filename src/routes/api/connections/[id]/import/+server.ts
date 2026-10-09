import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { isServerError, NotFound, toQueryError } from '#lib/server/engine.ts';
import { audit, readOnlyFor } from '#lib/server/permissions.ts';
import { addHistory, getConnection } from '#lib/server/store.ts';
import { dialectOf, runOutsideTransaction, tableMeta, writeTransaction } from '#lib/server/rows/db.ts';
import { checkMapping, createStatement, dropTableSql, ImportError, importRows, MAX_IMPORT_BYTES, parseImportOptions } from '#lib/server/rows/import.ts';
import { bytes } from '#lib/client/format.ts';
import { buildDeleteAll } from '#lib/server/rows/sql.ts';
import type { RequestHandler } from './$types';

/**
 * CSV import (multipart: `file` and JSON `options`). All rows go in one transaction;
 * nothing is kept if any row fails.
 */
export const POST: RequestHandler = handler(async ({ params, request, locals }) => {
	const conn = getConnection(params.id);
	if (!conn) throw new NotFound('Connection not found');
	if (readOnlyFor(locals.user, params.id)) return json({ message: 'This connection is read-only for you. Unlock writes to import.' }, { status: 403 });
	const tooBig = () => json({ message: `The file is larger than the ${bytes(MAX_IMPORT_BYTES)} import limit (PGM_IMPORT_MAX_MB)` }, { status: 413 });
	if (Number(request.headers.get('content-length') ?? 0) > MAX_IMPORT_BYTES + 1024 * 1024) return tooBig();

	const form = await request.formData().catch(() => null);
	const file = form?.get('file');
	if (!form || !(file instanceof File)) throw new BadRequest('Upload a CSV file as "file"');
	if (file.size > MAX_IMPORT_BYTES) return tooBig();
	let opts;
	try {
		opts = parseImportOptions(JSON.parse(String(form.get('options') ?? 'null')));
	} catch (err) {
		throw new BadRequest(err instanceof ImportError ? err.message : '"options" must be JSON');
	}
	const dialect = dialectOf(params.id);
	if (opts.truncate && opts.create) throw new BadRequest('A new table has nothing to empty');
	// Emptying the table is destructive: the name has to be typed again, like a confirmation.
	if (opts.truncate && opts.confirmTruncate !== opts.table) {
		return json({ message: `Type the table name to confirm deleting every row of ${opts.schema}.${opts.table}`, confirm: [buildDeleteAll(dialect, opts).display] }, { status: 409 });
	}

	try {
		const text = await file.text();
		const create = createStatement(dialect, opts);
		let key: string[] = opts.create?.primaryKey ?? [];
		let booleanColumns = new Set<string>();
		let createdOutside = false;
		if (!create) {
			const meta = await tableMeta(params.id, opts.schema, opts.table);
			checkMapping(meta, opts);
			key = meta.key;
			booleanColumns = new Set(meta.columns.filter((c) => c.kind === 'boolean').map((c) => c.name));
		} else if (dialect === 'mysql') {
			// MySQL commits DDL implicitly, so the table is created first and dropped again if the import fails.
			await runOutsideTransaction(params.id, create.sql);
			createdOutside = true;
			booleanColumns = new Set(opts.create!.columns.filter((c) => /^(tinyint\(1\)|bool|boolean)$/i.test(c.type.trim())).map((c) => c.name));
		}
		if (opts.onConflict === 'update' && dialect !== 'mysql' && !key.length) throw new ImportError('Updating existing rows needs a primary key');

		const started = performance.now();
		let outcome;
		try {
			outcome = await writeTransaction(params.id, (tx) =>
				importRows(tx, text, opts, {
					key,
					booleanColumns,
					source: file.name || undefined,
					preamble: create && !createdOutside ? [create] : [],
					isServerError,
					errorText: (err) => toQueryError(err).message
				})
			);
		} finally {
			if (createdOutside && !outcome?.commit) await runOutsideTransaction(params.id, dropTableSql(dialect, opts.schema, opts.table)).catch(() => {});
		}
		const statements = createdOutside ? [create!.display, ...outcome.statements] : outcome.statements;
		addHistory({
			connectionId: params.id,
			sql: statements.map((s) => (s.includes('; --') ? s : `${s};`)).join('\n'),
			ok: outcome.commit,
			rowCount: outcome.commit ? outcome.rows : 0,
			durationMs: performance.now() - started,
			error: outcome.failed ? `Row ${outcome.failed.row} (line ${outcome.failed.line}): ${outcome.failed.message} (rolled back)` : null,
			userId: locals.user?.id ?? null,
			userEmail: locals.user?.email ?? null,
			readOnly: false
		});
		if (!outcome.commit) {
			const f = outcome.failed!;
			return json({ message: `Nothing was imported: row ${f.row} (line ${f.line}) failed. ${f.message}`, failed: f }, { status: 422 });
		}
		audit(locals, 'rows.import', {
			connection: conn,
			detail: `${opts.schema}.${opts.table}: ${outcome.rows} rows${file.name ? ` from ${file.name}` : ''}${create ? ', new table' : ''}${opts.truncate ? `, emptied first (${outcome.deleted} deleted)` : ''}${opts.onConflict !== 'error' ? `, ${opts.onConflict} on conflict` : ''}`
		});
		return json({ ok: true, rows: outcome.rows, affected: outcome.affected, deleted: outcome.deleted, created: !!create });
	} catch (err) {
		if (err instanceof ImportError) throw new BadRequest(err.message);
		throw err;
	}
});
