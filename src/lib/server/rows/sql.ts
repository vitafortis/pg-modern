/**
 * SQL builders for row edits and CSV imports. Pure (no database access) so they can
 * be unit-tested. Every value goes in as a bind parameter (`$n` on Postgres, `?` on
 * MySQL/MariaDB and SQLite); `display` is the same statement with the values inlined
 * as literals, only for showing the user what will run (never executed).
 */
import { quoteIdentFor } from '#lib/engine.ts';
import type { CompareMode, Dialect, OnConflict } from '#lib/rows.ts';

export type { CompareMode, Dialect, OnConflict };

export interface Stmt {
	sql: string;
	params: unknown[];
	display: string;
}

export interface TableRef {
	schema: string;
	table: string;
}

type Part = { text: string } | { param: unknown; cast?: string };

/** Collects SQL text and parameters, then renders both the executable and display forms. */
function builder(dialect: Dialect) {
	const parts: Part[] = [];
	const b = {
		text(s: string) {
			parts.push({ text: s });
			return b;
		},
		param(v: unknown, cast?: string) {
			parts.push({ param: v, cast });
			return b;
		},
		done(): Stmt {
			let sql = '';
			let display = '';
			const params: unknown[] = [];
			for (const p of parts) {
				if ('text' in p) {
					sql += p.text;
					display += p.text;
				} else {
					params.push(p.param);
					sql += placeholder(dialect, params.length) + (p.cast ? `::${p.cast}` : '');
					display += literal(dialect, p.param) + (p.cast ? `::${p.cast}` : '');
				}
			}
			return { sql, params, display };
		}
	};
	return b;
}

export function placeholder(dialect: Dialect, n: number): string {
	return dialect === 'postgres' ? `$${n}` : '?';
}

export function quoteIdent(dialect: Dialect, name: string): string {
	return quoteIdentFor(dialect === 'mysql' ? 'mysql' : 'postgres', name);
}

export function tableName(dialect: Dialect, t: TableRef): string {
	return `${quoteIdent(dialect, t.schema)}.${quoteIdent(dialect, t.table)}`;
}

/** A value as a SQL literal, for display only. */
export function literal(dialect: Dialect, v: unknown): string {
	if (v === null || v === undefined) return 'NULL';
	if (typeof v === 'boolean') return dialect === 'postgres' ? (v ? 'TRUE' : 'FALSE') : v ? '1' : '0';
	if (typeof v === 'number' || typeof v === 'bigint') return String(v);
	const s = typeof v === 'string' ? v : JSON.stringify(v);
	if (dialect === 'mysql') return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
	return `'${s.replace(/'/g, "''")}'`;
}

function nullSafeEq(dialect: Dialect): string {
	return dialect === 'postgres' ? ' IS NOT DISTINCT FROM ' : dialect === 'mysql' ? ' <=> ' : ' IS ';
}

function whereKey(b: ReturnType<typeof builder>, dialect: Dialect, key: Record<string, unknown>) {
	const cols = Object.keys(key);
	if (!cols.length) throw new Error('A key is required');
	cols.forEach((c, i) => {
		b.text(i ? ' AND ' : ' WHERE ').text(`${quoteIdent(dialect, c)} = `).param(key[c]);
	});
}

export interface UpdateSpec extends TableRef {
	/** Full primary (or unique) key of the row: column → current value. */
	key: Record<string, unknown>;
	/** Column → new value. */
	set: Record<string, unknown>;
	/** Column → value when the row was loaded, compared in the WHERE so concurrent changes are caught. */
	original?: Record<string, unknown>;
	/** How each original value may be compared (default `eq`). */
	compare?: Record<string, CompareMode>;
}

export function buildUpdate(dialect: Dialect, u: UpdateSpec): Stmt {
	const cols = Object.keys(u.set);
	if (!cols.length) throw new Error('Nothing to update');
	const b = builder(dialect).text(`UPDATE ${tableName(dialect, u)} SET `);
	cols.forEach((c, i) => {
		b.text(`${i ? ', ' : ''}${quoteIdent(dialect, c)} = `).param(u.set[c]);
	});
	whereKey(b, dialect, u.key);
	for (const [c, v] of Object.entries(u.original ?? {})) {
		const mode = u.compare?.[c] ?? 'eq';
		if (mode === 'none') continue;
		// Key columns are already matched on their current value above.
		if (c in u.key && u.key[c] === v) continue;
		if (mode === 'json' && dialect === 'postgres') b.text(` AND ${quoteIdent(dialect, c)}::jsonb${nullSafeEq(dialect)}`).param(v, 'jsonb');
		else b.text(` AND ${quoteIdent(dialect, c)}${nullSafeEq(dialect)}`).param(v);
	}
	return b.done();
}

export interface DeleteSpec extends TableRef {
	key: Record<string, unknown>;
}

export function buildDelete(dialect: Dialect, d: DeleteSpec): Stmt {
	const b = builder(dialect).text(`DELETE FROM ${tableName(dialect, d)}`);
	whereKey(b, dialect, d.key);
	return b.done();
}

export interface InsertSpec extends TableRef {
	/** Column → value; columns left out get their default. */
	values: Record<string, unknown>;
}

export function buildInsert(dialect: Dialect, ins: InsertSpec): Stmt {
	const cols = Object.keys(ins.values);
	const b = builder(dialect).text(`INSERT INTO ${tableName(dialect, ins)}`);
	if (!cols.length) return b.text(dialect === 'mysql' ? ' () VALUES ()' : ' DEFAULT VALUES').done();
	b.text(` (${cols.map((c) => quoteIdent(dialect, c)).join(', ')}) VALUES (`);
	cols.forEach((c, i) => {
		if (i) b.text(', ');
		b.param(ins.values[c]);
	});
	return b.text(')').done();
}

/** Reads columns of one row by key and locks it (to compare with what the user saw). */
export function buildSelectRow(dialect: Dialect, t: TableRef & { key: Record<string, unknown>; columns: string[] }): Stmt {
	const b = builder(dialect).text(`SELECT ${t.columns.map((c) => quoteIdent(dialect, c)).join(', ') || '1'} FROM ${tableName(dialect, t)}`);
	whereKey(b, dialect, t.key);
	// SQLite has no row locks; its write transaction already serializes writers.
	if (dialect !== 'sqlite') b.text(' FOR UPDATE');
	return b.done();
}

export interface BatchInsertSpec extends TableRef {
	columns: string[];
	rows: unknown[][];
	onConflict?: OnConflict;
	/** Key columns that identify a conflicting row (needed for `update` on Postgres/SQLite). */
	key?: string[];
}

/** Bind parameters per statement stay under the 65535 limit of the Postgres and MySQL protocols. */
export const MAX_PARAMS = 60_000;

/** Rows per INSERT for a column count: at most `preferred`, within the parameter limit. */
export function batchSize(columnCount: number, preferred = 500): number {
	return Math.max(1, Math.min(preferred, Math.floor(MAX_PARAMS / Math.max(1, columnCount))));
}

/** A multi-row INSERT; `display` is left empty (it's too big to show), see `describeBatch`. */
export function buildBatchInsert(dialect: Dialect, s: BatchInsertSpec): Omit<Stmt, 'display'> {
	if (!s.columns.length) throw new Error('No columns to import');
	if (!s.rows.length) throw new Error('No rows to import');
	const q = (c: string) => quoteIdent(dialect, c);
	const width = s.columns.length;
	const params: unknown[] = [];
	const tuples: string[] = [];
	for (const row of s.rows) {
		if (row.length !== width) throw new Error(`Expected ${width} values, got ${row.length}`);
		const ph: string[] = [];
		for (const v of row) {
			params.push(v);
			ph.push(placeholder(dialect, params.length));
		}
		tuples.push(`(${ph.join(', ')})`);
	}
	if (params.length > 65_535) throw new Error('Too many values in one statement');
	return { sql: `INSERT INTO ${tableName(dialect, s)} (${s.columns.map(q).join(', ')}) VALUES ${tuples.join(', ')}${conflictClause(dialect, s)}`, params };
}

export function conflictClause(dialect: Dialect, s: Pick<BatchInsertSpec, 'columns' | 'onConflict' | 'key'>): string {
	const mode = s.onConflict ?? 'error';
	if (mode === 'error') return '';
	const q = (c: string) => quoteIdent(dialect, c);
	const key = s.key ?? [];
	const others = s.columns.filter((c) => !key.includes(c));
	if (dialect === 'mysql') {
		// A no-op assignment skips duplicates without INSERT IGNORE's habit of hiding other errors.
		if (mode === 'skip' || !others.length) {
			const c = key[0] ?? s.columns[0];
			return ` ON DUPLICATE KEY UPDATE ${q(c)} = ${q(c)}`;
		}
		return ` ON DUPLICATE KEY UPDATE ${others.map((c) => `${q(c)} = VALUES(${q(c)})`).join(', ')}`;
	}
	if (mode === 'skip') return ' ON CONFLICT DO NOTHING';
	if (!key.length) throw new Error('Updating on conflict needs a primary key');
	if (!others.length) return ` ON CONFLICT (${key.map(q).join(', ')}) DO NOTHING`;
	return ` ON CONFLICT (${key.map(q).join(', ')}) DO UPDATE SET ${others.map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(', ')}`;
}

/** A readable summary of an import for history: the statement shape and the row count. */
export function describeBatch(dialect: Dialect, s: Omit<BatchInsertSpec, 'rows'> & { rowCount: number; source?: string }): string {
	const cols = s.columns.map((c) => quoteIdent(dialect, c)).join(', ');
	const tuple = `(${s.columns.map(() => '…').join(', ')})`;
	const from = s.source ? ` from ${s.source.replace(/[\r\n]/g, ' ')}` : '';
	return `INSERT INTO ${tableName(dialect, s)} (${cols}) VALUES ${tuple}${conflictClause(dialect, s)}; -- ${s.rowCount} row${s.rowCount === 1 ? '' : 's'}${from}`;
}

export function buildDeleteAll(dialect: Dialect, t: TableRef): Stmt {
	const sql = `DELETE FROM ${tableName(dialect, t)}`;
	return { sql, params: [], display: sql };
}

// --- CREATE TABLE -----------------------------------------------------------------

/**
 * Column types for a new table are typed by the user, so they're checked against a
 * conservative shape: words, an optional (n) or (p, s), an optional [] (Postgres).
 */
const TYPE_SHAPE = /^[a-z][a-z0-9_]*( [a-z][a-z0-9_]*){0,3}( ?\(\d{1,5}( ?, ?\d{1,5})?\))?( unsigned)?(\[\])?$/i;

export function validColumnType(type: string): boolean {
	return TYPE_SHAPE.test(type.trim());
}

export interface CreateTableSpec extends TableRef {
	columns: { name: string; type: string; nullable?: boolean }[];
	primaryKey?: string[];
}

export function buildCreateTable(dialect: Dialect, s: CreateTableSpec): Stmt {
	if (!s.columns.length) throw new Error('A table needs at least one column');
	const names = new Set<string>();
	const lines: string[] = [];
	for (const c of s.columns) {
		const name = c.name.trim();
		if (!name) throw new Error('Column names can’t be empty');
		if (names.has(name.toLowerCase())) throw new Error(`Duplicate column "${name}"`);
		names.add(name.toLowerCase());
		if (!validColumnType(c.type)) throw new Error(`"${c.type}" doesn’t look like a column type`);
		const notNull = c.nullable === false || s.primaryKey?.includes(name) ? ' NOT NULL' : '';
		lines.push(`  ${quoteIdent(dialect, name)} ${c.type.trim()}${notNull}`);
	}
	if (s.primaryKey?.length) {
		for (const k of s.primaryKey) if (!s.columns.some((c) => c.name.trim() === k)) throw new Error(`Primary key column "${k}" isn’t in the table`);
		lines.push(`  PRIMARY KEY (${s.primaryKey.map((k) => quoteIdent(dialect, k)).join(', ')})`);
	}
	const sql = `CREATE TABLE ${tableName(dialect, s)} (\n${lines.join(',\n')}\n)`;
	return { sql, params: [], display: sql };
}
