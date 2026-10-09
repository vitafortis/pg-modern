/**
 * What the row editor and CSV import need to know about a table (key, editable
 * columns, how values compare), and a write transaction per engine.
 */
import type pgTypes from 'pg';
import type { PoolConnection } from 'mysql2/promise';
import { readQuery as pgRead, typeParsers, withClient } from '../pg.ts';
import { readQuery as myRead, serializeValue, withConnection } from '../mysql/client.ts';
import { columns as myColumns } from '../mysql/introspect.ts';
import { getConnection } from '../store.ts';
import { NotFound } from '../pg.ts';
import type { CompareMode, Dialect, EditKind, TableMeta } from '#lib/rows.ts';

export type { EditColumn, EditKind, TableMeta } from '#lib/rows.ts';

export function dialectOf(id: string): Dialect {
	const conn = getConnection(id);
	if (!conn) throw new NotFound('Connection not found');
	return conn.engine as Dialect;
}

export async function tableMeta(id: string, schema: string, table: string): Promise<TableMeta> {
	const dialect = dialectOf(id);
	if (dialect === 'mysql') return mysqlMeta(id, schema, table);
	if (dialect === 'postgres') return pgMeta(id, schema, table);
	throw new Error(`Editing isn’t supported on ${dialect} yet`);
}

/** Picks the primary key, else the narrowest unique key whose columns are all NOT NULL. */
export function chooseKey(
	keys: { primary: boolean; columns: string[] }[],
	notNull: (col: string) => boolean
): { key: string[]; keyKind: TableMeta['keyKind'] } {
	const pk = keys.find((k) => k.primary && k.columns.length);
	if (pk) return { key: pk.columns, keyKind: 'primary' };
	const unique = keys
		.filter((k) => !k.primary && k.columns.length && k.columns.every(notNull))
		.sort((a, b) => a.columns.length - b.columns.length)[0];
	return unique ? { key: unique.columns, keyKind: 'unique' } : { key: [], keyKind: null };
}

// --- Postgres ---------------------------------------------------------------------

async function pgMeta(id: string, schema: string, table: string): Promise<TableMeta> {
	const rel = await pgRead<{ oid: number; kind: string }>(
		id,
		`select c.oid::int as oid, c.relkind as kind from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2`,
		[schema, table]
	);
	if (!rel.length) throw new NotFound(`Relation ${schema}.${table} not found`);
	const { oid, kind } = rel[0];
	const [cols, keys] = await Promise.all([
		pgRead<{
			name: string;
			type: string;
			notnull: boolean;
			def: string | null;
			generated: string;
			identity: string;
			typname: string;
			category: string;
			elemname: string | null;
			elemcategory: string | null;
			options: string[] | null;
		}>(
			id,
			`select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull,
				pg_get_expr(d.adbin, d.adrelid) as def, a.attgenerated as generated, a.attidentity as identity,
				bt.typname, bt.typcategory as category, et.typname as elemname, et.typcategory as elemcategory,
				case when bt.typtype = 'e' then (select json_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid = bt.oid) end as options
			 from pg_attribute a
			 join pg_type t on t.oid = a.atttypid
			 join pg_type bt on bt.oid = case when t.typtype = 'd' then t.typbasetype else t.oid end
			 left join pg_type et on bt.typcategory = 'A' and et.oid = bt.typelem
			 left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
			 where a.attrelid = $1::oid and a.attnum > 0 and not a.attisdropped
			 order by a.attnum`,
			[oid]
		),
		pgRead<{ primary: boolean; columns: string[] }>(
			id,
			`select i.indisprimary as primary,
				(select json_agg(a.attname order by k.ord) from unnest(i.indkey) with ordinality k(attnum, ord)
				 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) as columns
			 from pg_index i
			 where i.indrelid = $1::oid and i.indisunique and i.indimmediate and i.indisvalid
				and i.indpred is null and i.indexprs is null`,
			[oid]
		)
	]);
	const notNull = new Set(cols.filter((c) => c.notnull).map((c) => c.name));
	const { key, keyKind } = chooseKey(keys, (c) => notNull.has(c));
	const writable = kind === 'r' || kind === 'p';
	return {
		dialect: 'postgres',
		schema,
		table,
		writable,
		reason: writable ? undefined : 'Only tables can be edited, not views or foreign tables.',
		key,
		keyKind,
		columns: cols.map((c) => {
			let kind: EditKind = 'text';
			if (c.typname === 'json' || c.typname === 'jsonb') kind = 'json';
			else if (c.category === 'B') kind = 'boolean';
			else if (c.category === 'N' && c.typname !== 'money') kind = 'number';
			else if (c.category === 'D') kind = 'date';
			else if (c.options) kind = 'enum';
			const generated = c.generated === 's';
			const identity = c.identity === 'a';
			const name = c.elemname ?? c.typname;
			const category = c.elemcategory ?? c.category;
			const compare: CompareMode = c.typname === 'json' || c.typname === 'jsonb' ? 'json' : category === 'G' || name === 'xml' || name === 'json' ? 'none' : 'eq';
			return {
				name: c.name,
				type: c.type,
				nullable: !c.notnull,
				default: c.def,
				editable: !generated && !identity,
				reason: generated ? 'Generated column' : identity ? 'Identity column (GENERATED ALWAYS)' : undefined,
				kind,
				options: c.options ?? undefined,
				compare
			};
		})
	};
}

// --- MySQL / MariaDB -----------------------------------------------------------------

const MY_NUMBER = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|year|bit)\b/i;
const MY_BINARY = /^(tinyblob|blob|mediumblob|longblob|binary|varbinary|geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)\b/i;
const MY_DATE = /^(date|datetime|timestamp|time)\b/i;
const MY_INEXACT = /^(float|double|real)\b/i;

function mysqlEnumOptions(type: string): string[] | undefined {
	const m = /^enum\((.*)\)$/is.exec(type);
	if (!m) return undefined;
	const out: string[] = [];
	const re = /'((?:[^']|'')*)'/g;
	let x: RegExpExecArray | null;
	while ((x = re.exec(m[1]))) out.push(x[1].replace(/''/g, "'").replace(/\\\\/g, '\\'));
	return out;
}

async function mysqlMeta(id: string, schema: string, table: string): Promise<TableMeta> {
	const [rel, cols, extra, stats] = await Promise.all([
		myRead<{ type: string }>(id, 'SELECT TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [schema, table]),
		myColumns(id, schema, table),
		myRead<{ name: string; extra: string }>(id, 'SELECT COLUMN_NAME AS name, EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [schema, table]),
		myRead<{ name: string; non_unique: number; col: string | null; sub: number | null }>(
			id,
			`SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, COLUMN_NAME AS col, SUB_PART AS sub
			 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
			[schema, table]
		)
	]);
	if (!rel.length) throw new NotFound(`Table ${schema}.${table} not found`);
	const extraOf = new Map(extra.map((e) => [String(e.name), String(e.extra ?? '')]));
	const byIndex = new Map<string, { primary: boolean; columns: string[]; usable: boolean }>();
	for (const s of stats) {
		if (Number(s.non_unique) !== 0) continue;
		const name = String(s.name);
		const entry = byIndex.get(name) ?? { primary: name === 'PRIMARY', columns: [], usable: true };
		// Prefix and expression indexes don't identify a row by full column values.
		if (s.col == null || s.sub != null) entry.usable = false;
		else entry.columns.push(String(s.col));
		byIndex.set(name, entry);
	}
	const notNull = new Set(cols.filter((c) => !c.nullable).map((c) => c.name));
	const { key, keyKind } = chooseKey(
		[...byIndex.values()].filter((k) => k.usable),
		(c) => notNull.has(c)
	);
	const writable = String(rel[0].type) === 'BASE TABLE';
	return {
		dialect: 'mysql',
		schema,
		table,
		writable,
		reason: writable ? undefined : 'Only tables can be edited, not views.',
		key,
		keyKind,
		columns: cols.map((c) => {
			const type = c.type;
			const generated = /\b(VIRTUAL|STORED|PERSISTENT) GENERATED\b/i.test(extraOf.get(c.name) ?? '');
			const binary = MY_BINARY.test(type);
			const options = mysqlEnumOptions(type);
			let kind: EditKind = 'text';
			if (type === 'json') kind = 'json';
			else if (/^(tinyint\(1\)|bool|boolean)\b/i.test(type)) kind = 'boolean';
			else if (MY_NUMBER.test(type)) kind = 'number';
			else if (MY_DATE.test(type)) kind = 'date';
			else if (options) kind = 'enum';
			else if (binary) kind = 'binary';
			return {
				name: c.name,
				type,
				nullable: c.nullable,
				default: c.default,
				editable: !generated && !binary,
				reason: generated ? 'Generated column' : binary ? 'Binary and spatial values can’t be edited here' : undefined,
				kind,
				options,
				compare: type === 'json' || binary || MY_INEXACT.test(type) ? 'none' : 'eq'
			};
		})
	};
}

// --- transactions ---------------------------------------------------------------------

export interface Tx {
	dialect: Dialect;
	/** Runs one parameterised statement; rows come back as arrays, typed like the table browser's. */
	run(sql: string, params?: unknown[]): Promise<{ rowCount: number; rows: unknown[][] }>;
}

/**
 * Runs `fn` in one read/write transaction, committed only if it returns `commit: true`
 * (and rolled back if it throws). Callers must have checked write access first.
 */
export async function writeTransaction<T extends { commit: boolean }>(id: string, fn: (tx: Tx) => Promise<T>, opts: { timeoutMs?: number } = {}): Promise<T> {
	const dialect = dialectOf(id);
	if (dialect === 'postgres') {
		return withClient(id, { readOnly: false, timeoutMs: opts.timeoutMs }, async (client: pgTypes.PoolClient) => {
			const tx: Tx = {
				dialect,
				async run(sql, params = []) {
					const r = await client.query({ text: sql, values: params, rowMode: 'array', types: typeParsers } as pgTypes.QueryArrayConfig);
					return { rowCount: r.rowCount ?? 0, rows: (r.rows ?? []) as unknown[][] };
				}
			};
			await client.query('BEGIN');
			try {
				const result = await fn(tx);
				await client.query(result.commit ? 'COMMIT' : 'ROLLBACK');
				return result;
			} catch (err) {
				await client.query('ROLLBACK').catch(() => {});
				throw err;
			}
		});
	}
	if (dialect === 'mysql') {
		return withConnection(id, { readOnly: false, timeoutMs: opts.timeoutMs }, async (c: PoolConnection) => {
			const tx: Tx = {
				dialect,
				async run(sql, params = []) {
					const [res] = await c.query({ sql, values: params, rowsAsArray: true });
					if (Array.isArray(res)) return { rowCount: res.length, rows: (res as unknown[][]).map((r) => r.map(serializeValue)) };
					return { rowCount: (res as { affectedRows?: number }).affectedRows ?? 0, rows: [] };
				}
			};
			await c.query('START TRANSACTION');
			try {
				const result = await fn(tx);
				await c.query(result.commit ? 'COMMIT' : 'ROLLBACK');
				return result;
			} catch (err) {
				await c.query('ROLLBACK').catch(() => {});
				throw err;
			}
		});
	}
	throw new Error(`Writes aren’t supported on ${dialect} yet`);
}

/** Runs one statement outside a transaction (MySQL DDL commits implicitly anyway). */
export async function runOutsideTransaction(id: string, sql: string): Promise<void> {
	const dialect = dialectOf(id);
	if (dialect === 'mysql') await withConnection(id, { readOnly: false }, (c) => c.query(sql));
	else await withClient(id, { readOnly: false }, (c) => c.query(sql));
}
