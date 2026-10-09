/**
 * Captures a connection's schema into the engine-agnostic snapshot model
 * (#lib/schema/model.ts). Each engine has its own catalog queries; adding an engine
 * means adding a `captureX` and a case in `captureSchema`.
 */
import { createHash } from 'node:crypto';
import * as pg from './pg.ts';
import * as my from './mysql/client.ts';
import { SYSTEM_DATABASES } from './mysql/introspect.ts';
import { getConnection } from './store.ts';
import { BadRequest } from './http.ts';
import { canonicalJson, hashableSchema, normalizeSchema, type SchemaSnapshotData, type SnapshotTable } from '#lib/schema/model.ts';

export const SNAPSHOT_ENGINES = ['postgres', 'mysql'];

export function snapshotsSupported(engine: string): boolean {
	return SNAPSHOT_ENGINES.includes(engine);
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Stable hash of a normalized snapshot (routine bodies count through their hashes). */
export function schemaHash(s: SchemaSnapshotData): string {
	return sha(canonicalJson(hashableSchema(normalizeSchema(s))));
}

export async function captureSchema(id: string): Promise<SchemaSnapshotData> {
	const conn = getConnection(id);
	if (!conn) throw new pg.NotFound('Connection not found');
	const engine: string = conn.engine;
	if (engine === 'postgres') return normalizeSchema(await capturePostgres(id));
	if (engine === 'mysql') return normalizeSchema(await captureMysql(id));
	throw new BadRequest(`Schema snapshots aren't supported for ${engine} connections yet`);
}

// --- Postgres -------------------------------------------------------------------------

const PG_SYSTEM = `n.nspname not in ('pg_catalog', 'information_schema')
	and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp\\_%'`;

/** Objects that belong to an extension are the extension's business, not the schema's. */
const notExtensionOwned = (classId: string, oid: string) =>
	`not exists (select 1 from pg_depend d where d.classid = '${classId}'::regclass and d.objid = ${oid} and d.deptype = 'e')`;

const PG_KIND: Record<string, SnapshotTable['kind']> = { r: 'table', p: 'partitioned', f: 'foreign' };
const PG_CONSTRAINT: Record<string, 'foreign key' | 'unique' | 'check' | 'exclusion'> = { f: 'foreign key', u: 'unique', c: 'check', x: 'exclusion' };
const PG_ROUTINE: Record<string, 'function' | 'procedure' | 'aggregate' | 'window'> = { f: 'function', p: 'procedure', a: 'aggregate', w: 'window' };

async function capturePostgres(id: string): Promise<SchemaSnapshotData> {
	const q = <T extends Record<string, unknown>>(sql: string) => pg.readQuery<T>(id, sql, [], 60_000);
	const [schemas, rels, cols, cons, idx, routines, triggers, types, extensions] = await Promise.all([
		q<{ name: string }>(`select n.nspname as name from pg_namespace n where ${PG_SYSTEM} and ${notExtensionOwned('pg_namespace', 'n.oid')}`),
		q<{ oid: number; schema: string; name: string; kind: string; comment: string | null; viewdef: string | null }>(
			`select c.oid::int as oid, n.nspname as schema, c.relname as name, c.relkind as kind,
				obj_description(c.oid, 'pg_class') as comment,
				case when c.relkind in ('v', 'm') then pg_get_viewdef(c.oid, true) end as viewdef
			 from pg_class c join pg_namespace n on n.oid = c.relnamespace
			 where c.relkind in ('r', 'p', 'f', 'v', 'm') and not c.relispartition and ${PG_SYSTEM}
				and ${notExtensionOwned('pg_class', 'c.oid')}`
		),
		q<{ rel: number; name: string; type: string; notnull: boolean; def: string | null; identity: string; generated: string }>(
			`select a.attrelid::int as rel, a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull,
				pg_get_expr(d.adbin, d.adrelid) as def, a.attidentity as identity, a.attgenerated as generated
			 from pg_attribute a
			 join pg_class c on c.oid = a.attrelid
			 join pg_namespace n on n.oid = c.relnamespace
			 left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
			 where a.attnum > 0 and not a.attisdropped and c.relkind in ('r', 'p', 'f') and not c.relispartition and ${PG_SYSTEM}
			 order by a.attrelid, a.attnum`
		),
		q<{ rel: number; name: string; type: string; def: string; cols: string[] }>(
			`select con.conrelid::int as rel, con.conname as name, con.contype as type, pg_get_constraintdef(con.oid, true) as def,
				to_jsonb(array(select a.attname::text from unnest(con.conkey) with ordinality k(num, ord)
					join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.num order by k.ord)) as cols
			 from pg_constraint con
			 join pg_class c on c.oid = con.conrelid
			 join pg_namespace n on n.oid = c.relnamespace
			 where con.contype in ('p', 'f', 'u', 'c', 'x') and not c.relispartition and ${PG_SYSTEM}`
		),
		q<{ rel: number; name: string; def: string; unique: boolean }>(
			`select i.indrelid::int as rel, ic.relname as name, pg_get_indexdef(i.indexrelid) as def, i.indisunique as unique
			 from pg_index i
			 join pg_class ic on ic.oid = i.indexrelid
			 join pg_class c on c.oid = i.indrelid
			 join pg_namespace n on n.oid = c.relnamespace
			 where c.relkind in ('r', 'p', 'm') and not c.relispartition and ${PG_SYSTEM}
				and not exists (select 1 from pg_constraint con where con.conindid = i.indexrelid and con.conrelid = i.indrelid)`
		),
		q<{ schema: string; name: string; kind: string; args: string; returns: string | null; language: string; def: string | null; src: string | null }>(
			`select n.nspname as schema, p.proname as name, p.prokind as kind,
				pg_get_function_identity_arguments(p.oid) as args,
				case when p.prokind in ('f', 'w') then pg_get_function_result(p.oid) end as returns,
				l.lanname as language,
				case when p.prokind in ('f', 'p', 'w') then pg_get_functiondef(p.oid) end as def,
				p.prosrc as src
			 from pg_proc p
			 join pg_namespace n on n.oid = p.pronamespace
			 join pg_language l on l.oid = p.prolang
			 where ${PG_SYSTEM} and ${notExtensionOwned('pg_proc', 'p.oid')}`
		),
		q<{ schema: string; table: string; name: string; def: string }>(
			`select n.nspname as schema, c.relname as table, t.tgname as name, pg_get_triggerdef(t.oid, true) as def
			 from pg_trigger t
			 join pg_class c on c.oid = t.tgrelid
			 join pg_namespace n on n.oid = c.relnamespace
			 where not t.tgisinternal and not c.relispartition and ${PG_SYSTEM} and ${notExtensionOwned('pg_class', 'c.oid')}`
		),
		q<{ schema: string; name: string; kind: string; def: string }>(
			`select n.nspname as schema, t.typname as name, t.typtype as kind,
				case t.typtype
					when 'e' then (select string_agg(quote_literal(e.enumlabel), ', ' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid)
					when 'd' then format_type(t.typbasetype, t.typtypmod)
						|| case when t.typnotnull then ' NOT NULL' else '' end
						|| coalesce(' DEFAULT ' || t.typdefault, '')
						|| coalesce((select ' ' || string_agg(pg_get_constraintdef(con.oid, true), ' ' order by con.conname) from pg_constraint con where con.contypid = t.oid), '')
					when 'c' then (select string_agg(quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod), ', ' order by a.attnum)
						from pg_attribute a where a.attrelid = t.typrelid and a.attnum > 0 and not a.attisdropped)
					else format_type(t.oid, null)
				end as def
			 from pg_type t
			 join pg_namespace n on n.oid = t.typnamespace
			 where ${PG_SYSTEM} and t.typtype in ('e', 'd', 'c', 'r', 'm')
				and (t.typtype <> 'c' or (select c.relkind from pg_class c where c.oid = t.typrelid) = 'c')
				and ${notExtensionOwned('pg_type', 't.oid')}`
		),
		q<{ name: string; version: string }>(`select extname as name, extversion as version from pg_extension`)
	]);

	const colsByRel = new Map<number, typeof cols>();
	for (const c of cols) (colsByRel.get(c.rel) ?? colsByRel.set(c.rel, []).get(c.rel)!).push(c);
	const consByRel = new Map<number, typeof cons>();
	for (const c of cons) (consByRel.get(c.rel) ?? consByRel.set(c.rel, []).get(c.rel)!).push(c);
	const idxByRel = new Map<number, typeof idx>();
	for (const i of idx) (idxByRel.get(i.rel) ?? idxByRel.set(i.rel, []).get(i.rel)!).push(i);

	const tables: SnapshotTable[] = [];
	const views: SchemaSnapshotData['views'] = [];
	for (const r of rels) {
		if (r.kind === 'v' || r.kind === 'm') {
			views.push({ schema: r.schema, name: r.name, materialized: r.kind === 'm', definition: r.viewdef ?? '' });
			continue;
		}
		const relCons = consByRel.get(r.oid) ?? [];
		const pk = relCons.find((c) => c.type === 'p');
		tables.push({
			schema: r.schema,
			name: r.name,
			kind: PG_KIND[r.kind] ?? 'table',
			columns: (colsByRel.get(r.oid) ?? []).map((c) => ({
				name: c.name,
				type: c.type,
				nullable: !c.notnull,
				default: c.generated ? null : c.def,
				extra:
					c.identity === 'a' ? 'GENERATED ALWAYS AS IDENTITY'
					: c.identity === 'd' ? 'GENERATED BY DEFAULT AS IDENTITY'
					: c.generated === 's' ? `GENERATED ALWAYS AS (${c.def}) STORED`
					: null
			})),
			primaryKey: pk ? { name: pk.name, columns: pk.cols } : null,
			constraints: relCons.filter((c) => c.type !== 'p').map((c) => ({ name: c.name, type: PG_CONSTRAINT[c.type] ?? 'check', definition: c.def })),
			indexes: (idxByRel.get(r.oid) ?? []).map((i) => ({ name: i.name, definition: i.def, unique: i.unique })),
			comment: r.comment
		});
	}

	return {
		format: 1,
		engine: 'postgres',
		schemas: schemas.map((s) => s.name),
		tables,
		views,
		routines: routines.map((r) => {
			const body = r.def ?? r.src ?? '';
			return {
				schema: r.schema,
				name: r.name,
				kind: PG_ROUTINE[r.kind] ?? 'function',
				args: r.args,
				returns: r.returns,
				language: r.language,
				bodyHash: sha(body.replace(/\r\n?/g, '\n').trim()),
				body
			};
		}),
		triggers: triggers.map((t) => ({ schema: t.schema, table: t.table, name: t.name, definition: t.def })),
		types: types.map((t) => ({
			schema: t.schema,
			name: t.name,
			kind: t.kind === 'e' ? 'enum' : t.kind === 'd' ? 'domain' : t.kind === 'c' ? 'composite' : 'other',
			definition: t.def ?? ''
		})),
		extensions
	};
}

// --- MySQL / MariaDB --------------------------------------------------------------------

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? null : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

async function captureMysql(id: string): Promise<SchemaSnapshotData> {
	const sys = SYSTEM_DATABASES.map((d) => `'${d}'`).join(', ');
	const q = (sql: string) => my.readQuery<Row>(id, sql, [], 60_000);
	const optional = (sql: string) => q(sql).catch(() => [] as Row[]);
	const [schemas, tables, cols, stats, fks, checks, views, routines, params, triggers] = await Promise.all([
		q(`SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN (${sys})`),
		q(`SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_COMMENT AS comment
		   FROM information_schema.TABLES WHERE TABLE_SCHEMA NOT IN (${sys})`),
		q(`SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS \`table\`, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
		     COLUMN_DEFAULT AS def, EXTRA AS extra, ORDINAL_POSITION AS pos
		   FROM information_schema.COLUMNS WHERE TABLE_SCHEMA NOT IN (${sys}) ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`),
		q(`SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS \`table\`, INDEX_NAME AS name, NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq,
		     COLUMN_NAME AS col, SUB_PART AS sub_part, INDEX_TYPE AS index_type
		   FROM information_schema.STATISTICS WHERE TABLE_SCHEMA NOT IN (${sys}) ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`),
		q(`SELECT k.TABLE_SCHEMA AS \`schema\`, k.TABLE_NAME AS \`table\`, k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col,
		     k.REFERENCED_TABLE_SCHEMA AS ref_schema, k.REFERENCED_TABLE_NAME AS ref_table, k.REFERENCED_COLUMN_NAME AS ref_col,
		     r.UPDATE_RULE AS on_update, r.DELETE_RULE AS on_delete
		   FROM information_schema.KEY_COLUMN_USAGE k
		   JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
		   WHERE k.TABLE_SCHEMA NOT IN (${sys}) AND k.REFERENCED_TABLE_NAME IS NOT NULL
		   ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`),
		// CHECK constraints: MySQL 8.0.16+ and MariaDB 10.2+.
		optional(`SELECT t.TABLE_SCHEMA AS \`schema\`, t.TABLE_NAME AS \`table\`, t.CONSTRAINT_NAME AS name, c.CHECK_CLAUSE AS clause
		   FROM information_schema.TABLE_CONSTRAINTS t
		   JOIN information_schema.CHECK_CONSTRAINTS c ON c.CONSTRAINT_SCHEMA = t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME = t.CONSTRAINT_NAME
		   WHERE t.CONSTRAINT_TYPE = 'CHECK' AND t.TABLE_SCHEMA NOT IN (${sys})`),
		q(`SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name, VIEW_DEFINITION AS def FROM information_schema.VIEWS WHERE TABLE_SCHEMA NOT IN (${sys})`),
		q(`SELECT ROUTINE_SCHEMA AS \`schema\`, ROUTINE_NAME AS name, ROUTINE_TYPE AS type, DTD_IDENTIFIER AS returns,
		     ROUTINE_BODY AS lang, ROUTINE_DEFINITION AS def, IS_DETERMINISTIC AS deterministic, SQL_DATA_ACCESS AS access
		   FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA NOT IN (${sys})`),
		optional(`SELECT SPECIFIC_SCHEMA AS \`schema\`, SPECIFIC_NAME AS name, PARAMETER_MODE AS mode, PARAMETER_NAME AS pname, DTD_IDENTIFIER AS type,
		     ORDINAL_POSITION AS pos
		   FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA NOT IN (${sys}) AND ORDINAL_POSITION > 0 ORDER BY SPECIFIC_SCHEMA, SPECIFIC_NAME, ORDINAL_POSITION`),
		q(`SELECT TRIGGER_SCHEMA AS \`schema\`, EVENT_OBJECT_TABLE AS \`table\`, TRIGGER_NAME AS name, ACTION_TIMING AS timing,
		     EVENT_MANIPULATION AS event, ACTION_STATEMENT AS stmt
		   FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA NOT IN (${sys})`)
	]);

	const tkey = (s: unknown, t: unknown) => `${str(s)}.${str(t)}`;
	const group = <T>(rows: Row[], key: (r: Row) => string, map: (r: Row) => T) => {
		const out = new Map<string, T[]>();
		for (const r of rows) (out.get(key(r)) ?? out.set(key(r), []).get(key(r))!).push(map(r));
		return out;
	};
	const quote = my.quoteIdent;

	const colsBy = group(cols, (r) => tkey(r.schema, r.table), (r) => ({
		name: str(r.name)!,
		type: str(r.type)!,
		nullable: str(r.nullable) === 'YES',
		// MariaDB reports a NULL default as the string 'NULL'.
		default: str(r.def) === 'NULL' ? null : str(r.def),
		extra: str(r.extra) || null
	}));

	// Indexes: one row per column; fold them into definitions.
	const indexBy = new Map<string, Map<string, { unique: boolean; type: string; cols: string[] }>>();
	for (const r of stats) {
		const k = tkey(r.schema, r.table);
		const byName = indexBy.get(k) ?? indexBy.set(k, new Map()).get(k)!;
		const name = str(r.name)!;
		const entry = byName.get(name) ?? byName.set(name, { unique: Number(r.non_unique) === 0, type: str(r.index_type) ?? 'BTREE', cols: [] }).get(name)!;
		const col = r.col == null ? '(expression)' : quote(str(r.col)!);
		entry.cols.push(r.sub_part != null ? `${col}(${r.sub_part})` : col);
	}

	const fkBy = new Map<string, Map<string, { cols: string[]; refSchema: string; refTable: string; refCols: string[]; onUpdate: string; onDelete: string }>>();
	for (const r of fks) {
		const k = tkey(r.schema, r.table);
		const byName = fkBy.get(k) ?? fkBy.set(k, new Map()).get(k)!;
		const name = str(r.name)!;
		const fk =
			byName.get(name) ??
			byName.set(name, { cols: [], refSchema: str(r.ref_schema)!, refTable: str(r.ref_table)!, refCols: [], onUpdate: str(r.on_update) ?? '', onDelete: str(r.on_delete) ?? '' }).get(name)!;
		fk.cols.push(quote(str(r.col)!));
		fk.refCols.push(quote(str(r.ref_col)!));
	}
	const checksBy = group(checks, (r) => tkey(r.schema, r.table), (r) => ({ name: str(r.name)!, type: 'check' as const, definition: `CHECK (${str(r.clause)})` }));

	const outTables: SnapshotTable[] = [];
	for (const t of tables) {
		if (str(t.type) === 'VIEW') continue;
		const k = tkey(t.schema, t.name);
		const idx = indexBy.get(k) ?? new Map<string, { unique: boolean; type: string; cols: string[] }>();
		const primary = idx.get('PRIMARY');
		const fkMap = fkBy.get(k) ?? new Map<string, never>();
		const tableChecks = checksBy.get(k) ?? [];
		outTables.push({
			schema: str(t.schema)!,
			name: str(t.name)!,
			kind: 'table',
			columns: colsBy.get(k) ?? [],
			primaryKey: primary ? { name: 'PRIMARY', columns: primary.cols.map((c) => c.replace(/^`|`$/g, '').replace(/``/g, '`')) } : null,
			constraints: [
				...[...fkMap].map(([name, f]) => ({
					name,
					type: 'foreign key' as const,
					definition: `FOREIGN KEY (${f.cols.join(', ')}) REFERENCES ${quote(f.refSchema)}.${quote(f.refTable)} (${f.refCols.join(', ')}) ON UPDATE ${f.onUpdate} ON DELETE ${f.onDelete}`
				})),
				...tableChecks
			],
			// Foreign keys' backing indexes (same name) are listed too: they outlive a dropped key.
			indexes: [...idx]
				.filter(([name]) => name !== 'PRIMARY')
				.map(([name, i]) => ({
					name,
					unique: i.unique,
					definition: `${i.unique ? 'UNIQUE ' : i.type === 'FULLTEXT' ? 'FULLTEXT ' : i.type === 'SPATIAL' ? 'SPATIAL ' : ''}INDEX ${quote(name)} (${i.cols.join(', ')})${i.type !== 'BTREE' && i.type !== 'FULLTEXT' && i.type !== 'SPATIAL' ? ` USING ${i.type}` : ''}`
				})),
			comment: str(t.comment) || null,
			options: str(t.engine) ? `ENGINE=${str(t.engine)}` : null
		});
	}

	const paramsBy = group(params, (r) => tkey(r.schema, r.name), (r) => [str(r.mode), str(r.pname), str(r.type)].filter(Boolean).join(' '));

	return {
		format: 1,
		engine: 'mysql',
		schemas: schemas.map((s) => str(s.name)!),
		tables: outTables,
		views: views.map((v) => ({ schema: str(v.schema)!, name: str(v.name)!, materialized: false, definition: str(v.def) ?? '' })),
		routines: routines.map((r) => {
			const body = str(r.def) ?? '';
			const kind = str(r.type) === 'PROCEDURE' ? ('procedure' as const) : ('function' as const);
			return {
				schema: str(r.schema)!,
				name: str(r.name)!,
				kind,
				args: (paramsBy.get(tkey(r.schema, r.name)) ?? []).join(', '),
				returns: kind === 'function' ? str(r.returns) : null,
				language: str(r.lang),
				bodyHash: sha(`${str(r.deterministic)}|${str(r.access)}|${body.replace(/\r\n?/g, '\n').trim()}`),
				body
			};
		}),
		triggers: triggers.map((t) => ({
			schema: str(t.schema)!,
			table: str(t.table)!,
			name: str(t.name)!,
			definition: `${str(t.timing)} ${str(t.event)} ON ${quote(str(t.table)!)} FOR EACH ROW ${str(t.stmt)}`
		})),
		types: [],
		extensions: []
	};
}
