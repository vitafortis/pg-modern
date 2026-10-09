/**
 * CSV import: the uploaded file is parsed here again (the browser's parse is only a
 * preview), mapped onto the table's columns and inserted with batched,
 * parameterised INSERTs in a single transaction — all rows or none.
 */
import { CsvError, csvRecords } from '#lib/csv.ts';
import { batchSize, buildBatchInsert, buildCreateTable, buildDeleteAll, describeBatch, tableName, type Dialect, type OnConflict, type Stmt } from './sql.ts';
import type { TableMeta, Tx } from './db.ts';

export class ImportError extends Error {}

/** Upload cap; `PGM_IMPORT_MAX_MB` (default 50). */
export const MAX_IMPORT_BYTES = Math.max(1, Number(process.env.PGM_IMPORT_MAX_MB) || 50) * 1024 * 1024;

export interface ImportOptions {
	schema: string;
	table: string;
	delimiter: string;
	/** The first record holds column names (and is skipped). */
	header: boolean;
	/** For each CSV column, the table column it goes into, or null to ignore it. */
	mapping: (string | null)[];
	/** Empty fields become NULL instead of empty strings. */
	emptyAsNull: boolean;
	/** Delete every existing row first (in the same transaction). */
	truncate: boolean;
	/** The table name typed again to confirm `truncate`. */
	confirmTruncate?: string;
	onConflict: OnConflict;
	/** Create the table first, with these columns (named as in `mapping`). */
	create?: { columns: { name: string; type: string }[]; primaryKey?: string[] };
}

const CONFLICT: OnConflict[] = ['error', 'skip', 'update'];

/** Checks the shape of the options sent by the browser. */
export function parseImportOptions(raw: unknown): ImportOptions {
	if (!raw || typeof raw !== 'object') throw new ImportError('Expected import options');
	const o = raw as Record<string, unknown>;
	const str = (k: string) => {
		if (typeof o[k] !== 'string' || !(o[k] as string).trim()) throw new ImportError(`"${k}" is required`);
		return o[k] as string;
	};
	const delimiter = typeof o.delimiter === 'string' ? o.delimiter : ',';
	if (delimiter.length !== 1 || /["\r\n]/.test(delimiter)) throw new ImportError('The delimiter must be one character (not a quote or newline)');
	if (!Array.isArray(o.mapping) || !o.mapping.length) throw new ImportError('"mapping" is required');
	const mapping = o.mapping.map((m) => (typeof m === 'string' && m ? m : null));
	if (!mapping.some(Boolean)) throw new ImportError('Map at least one column');
	const onConflict = (o.onConflict ?? 'error') as OnConflict;
	if (!CONFLICT.includes(onConflict)) throw new ImportError('"onConflict" must be error, skip or update');
	let create: ImportOptions['create'];
	if (o.create) {
		const c = o.create as Record<string, unknown>;
		if (!Array.isArray(c.columns)) throw new ImportError('"create.columns" is required');
		create = {
			columns: c.columns.map((col) => ({ name: String((col as { name?: unknown }).name ?? ''), type: String((col as { type?: unknown }).type ?? '') })),
			primaryKey: Array.isArray(c.primaryKey) ? c.primaryKey.map(String).filter(Boolean) : undefined
		};
	}
	return {
		schema: str('schema'),
		table: str('table'),
		delimiter,
		header: o.header !== false,
		mapping,
		emptyAsNull: o.emptyAsNull !== false,
		truncate: o.truncate === true,
		confirmTruncate: typeof o.confirmTruncate === 'string' ? o.confirmTruncate : undefined,
		onConflict,
		create
	};
}

/** The CREATE TABLE for an import into a new table; its columns must be the mapped ones. */
export function createStatement(dialect: Dialect, opts: ImportOptions): Stmt | null {
	if (!opts.create) return null;
	const mapped = opts.mapping.filter((m): m is string => !!m);
	const names = opts.create.columns.map((c) => c.name.trim());
	if (mapped.length !== names.length || mapped.some((m, i) => m !== names[i])) throw new ImportError('The new table’s columns must match the mapped CSV columns');
	try {
		return buildCreateTable(dialect, { schema: opts.schema, table: opts.table, columns: opts.create.columns, primaryKey: opts.create.primaryKey });
	} catch (err) {
		throw new ImportError((err as Error).message);
	}
}

/** Target columns of an existing table, checked against its metadata. */
export function checkMapping(meta: TableMeta, opts: ImportOptions): void {
	if (!meta.writable) throw new ImportError(meta.reason ?? 'This relation can’t be imported into');
	const seen = new Set<string>();
	for (const m of opts.mapping) {
		if (!m) continue;
		const col = meta.columns.find((c) => c.name === m);
		if (!col) throw new ImportError(`The table has no column "${m}"`);
		if (!col.editable) throw new ImportError(`"${m}" can’t be written (${col.reason ?? 'read-only'})`);
		if (seen.has(m)) throw new ImportError(`"${m}" is mapped twice`);
		seen.add(m);
	}
	if (opts.onConflict === 'update' && meta.dialect !== 'mysql' && !meta.key.length) {
		throw new ImportError('Updating existing rows needs a primary key (or a unique key on NOT NULL columns)');
	}
}

export interface ImportFailure {
	/** 1-based data row (header excluded); for batch-level errors, the first row of the batch. */
	row: number;
	/** Line in the file where that row starts. */
	line: number;
	message: string;
}

export interface ImportOutcome {
	commit: boolean;
	rows: number;
	/** What the database reported as affected (MySQL counts an updated duplicate as 2). */
	affected: number;
	/** Rows removed by "empty the table first". */
	deleted: number;
	failed?: ImportFailure;
	/** Statements for history, as displayed. */
	statements: string[];
}

/** How a CSV field becomes a parameter for a column. */
export function fieldValue(dialect: Dialect, raw: string, opts: { emptyAsNull: boolean; boolean?: boolean }): unknown {
	if (raw === '' && opts.emptyAsNull) return null;
	if (opts.boolean && dialect !== 'postgres') {
		const v = raw.trim();
		if (/^(true|t|yes|y|on)$/i.test(v)) return 1;
		if (/^(false|f|no|n|off)$/i.test(v)) return 0;
	}
	return raw;
}

/**
 * Inserts the CSV rows. `columnsBoolean` names boolean target columns (MySQL stores
 * them as 1/0). Each batch runs under a savepoint; when one fails, its rows are
 * retried one by one to find the row to blame, then the whole import is rolled back.
 */
export async function importRows(
	tx: Tx,
	text: string,
	opts: ImportOptions,
	ctx: { key: string[]; booleanColumns: Set<string>; source?: string; preamble?: Stmt[]; isServerError: (err: unknown) => boolean; errorText: (err: unknown) => string }
): Promise<ImportOutcome> {
	const dialect = tx.dialect;
	const target = { schema: opts.schema, table: opts.table };
	const columns: string[] = [];
	const indexes: number[] = [];
	opts.mapping.forEach((m, i) => {
		if (m) {
			columns.push(m);
			indexes.push(i);
		}
	});
	const flags = columns.map((c) => ({ emptyAsNull: opts.emptyAsNull, boolean: ctx.booleanColumns.has(c) }));
	const statements = (ctx.preamble ?? []).map((s) => s.display);
	const out: ImportOutcome = { commit: false, rows: 0, affected: 0, deleted: 0, statements };
	const fail = (failed: ImportFailure): ImportOutcome => ({ ...out, commit: false, failed });

	for (const s of ctx.preamble ?? []) await tx.run(s.sql, s.params);
	if (opts.truncate) {
		const del = buildDeleteAll(dialect, target);
		out.deleted = (await tx.run(del.sql, del.params)).rowCount;
		statements.push(del.display);
	}

	const size = batchSize(columns.length);
	let batch: unknown[][] = [];
	let batchMeta: { row: number; line: number }[] = [];

	const flush = async (): Promise<ImportFailure | null> => {
		if (!batch.length) return null;
		const stmt = buildBatchInsert(dialect, { ...target, columns, rows: batch, onConflict: opts.onConflict, key: ctx.key });
		await tx.run('SAVEPOINT pgm_import');
		try {
			out.affected += (await tx.run(stmt.sql, stmt.params)).rowCount;
			await tx.run('RELEASE SAVEPOINT pgm_import');
		} catch (err) {
			if (!ctx.isServerError(err)) throw err;
			await tx.run('ROLLBACK TO SAVEPOINT pgm_import');
			// Find the row to blame: insert the batch's rows one at a time.
			for (let i = 0; i < batch.length; i++) {
				const single = buildBatchInsert(dialect, { ...target, columns, rows: [batch[i]], onConflict: opts.onConflict, key: ctx.key });
				try {
					await tx.run(single.sql, single.params);
				} catch (rowErr) {
					if (!ctx.isServerError(rowErr)) throw rowErr;
					return { ...batchMeta[i], message: ctx.errorText(rowErr) };
				}
			}
			// Rows only conflict together (e.g. the same key twice in one batch).
			return { ...batchMeta[0], message: `${ctx.errorText(err)} (rows ${batchMeta[0].row}–${batchMeta.at(-1)!.row})` };
		}
		batch = [];
		batchMeta = [];
		return null;
	};

	let first = true;
	try {
		for (const rec of csvRecords(text, opts.delimiter)) {
			if (first && opts.header) {
				first = false;
				if (rec.fields.length !== opts.mapping.length) throw new ImportError(`The header has ${rec.fields.length} columns but ${opts.mapping.length} were mapped`);
				continue;
			}
			first = false;
			out.rows++;
			if (rec.fields.length !== opts.mapping.length) {
				return fail({ row: out.rows, line: rec.line, message: `Expected ${opts.mapping.length} fields, found ${rec.fields.length}` });
			}
			batch.push(indexes.map((fi, ci) => fieldValue(dialect, rec.fields[fi], flags[ci])));
			batchMeta.push({ row: out.rows, line: rec.line });
			if (batch.length >= size) {
				const failed = await flush();
				if (failed) return fail(failed);
			}
		}
	} catch (err) {
		if (err instanceof CsvError) return fail({ row: out.rows + 1, line: err.line, message: err.message });
		throw err;
	}
	const failed = await flush();
	if (failed) return fail(failed);
	if (!out.rows) throw new ImportError('The file has no data rows');
	statements.push(describeBatch(dialect, { ...target, columns, onConflict: opts.onConflict, key: ctx.key, rowCount: out.rows, source: ctx.source }));
	return { ...out, commit: true };
}

export function dropTableSql(dialect: Dialect, schema: string, table: string): string {
	return `DROP TABLE ${tableName(dialect, { schema, table })}`;
}

