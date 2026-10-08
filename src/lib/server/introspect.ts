import { readQuery, withClient, typeParsers } from './pg.ts';
import { quoteIdent } from './sql.ts';
import type { ColumnInfo, RelationSummary, SchemaTree } from '#lib/types.ts';

const SYSTEM_SCHEMA_FILTER = `n.nspname not in ('pg_catalog', 'information_schema')
	and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp\\_%'`;

const KIND: Record<string, RelationSummary['kind']> = {
	r: 'table',
	v: 'view',
	m: 'matview',
	f: 'foreign',
	p: 'partitioned'
};

export async function schemaTree(id: string, includeSystem = false): Promise<SchemaTree> {
	const filter = includeSystem ? 'true' : SYSTEM_SCHEMA_FILTER;
	const [schemas, relations, functions] = await Promise.all([
		readQuery<{ name: string }>(id, `select n.nspname as name from pg_namespace n where ${filter} order by 1`),
		readQuery<{ schema: string; name: string; kind: string; est_rows: string; size: string | null }>(
			id, `select n.nspname as schema, c.relname as name, c.relkind as kind,
				greatest(c.reltuples, 0)::bigint as est_rows,
				case when c.relkind in ('r', 'm', 'p') then pg_total_relation_size(c.oid) end as size
			 from pg_class c join pg_namespace n on n.oid = c.relnamespace
			 where c.relkind in ('r', 'v', 'm', 'f', 'p') and not c.relispartition and ${filter}
			 order by 1, 2`
		),
		readQuery<{ schema: string; count: number }>(
			id, `select n.nspname as schema, count(*)::int as count
			 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
			 where ${filter} group by 1`
		)
	]);

	const fnCount = new Map(functions.map((f) => [f.schema, f.count]));
	const bySchema = new Map<string, RelationSummary[]>(schemas.map((s) => [s.name, []]));
	for (const r of relations) {
		if (!bySchema.has(r.schema)) bySchema.set(r.schema, []);
		bySchema.get(r.schema)!.push({
			name: r.name,
			kind: KIND[r.kind] ?? 'table',
			estimatedRows: Number(r.est_rows),
			sizeBytes: r.size == null ? null : Number(r.size)
		});
	}
	return {
		schemas: [...bySchema.entries()].map(([name, rels]) => ({
			name,
			relations: rels,
			functions: fnCount.get(name) ?? 0
		}))
	};
}

export async function columns(id: string, schema: string, table: string): Promise<ColumnInfo[]> {
	const rows = await readQuery<{
		name: string;
		type: string;
		notnull: boolean;
		def: string | null;
		pk: boolean;
		comment: string | null;
	}>(
		id, `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull,
			pg_get_expr(d.adbin, d.adrelid) as def,
			coalesce(a.attnum = any(i.indkey), false) as pk,
			col_description(c.oid, a.attnum) as comment
		 from pg_attribute a
		 join pg_class c on c.oid = a.attrelid
		 join pg_namespace n on n.oid = c.relnamespace
		 left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
		 left join pg_index i on i.indrelid = c.oid and i.indisprimary
		 where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped
		 order by a.attnum`,
		[schema, table]
	);
	return rows.map((r) => ({
		name: r.name,
		type: r.type,
		nullable: !r.notnull,
		default: r.def,
		isPrimaryKey: r.pk,
		comment: r.comment
	}));
}

export type FilterOp = '=' | '!=' | '<' | '>' | '<=' | '>=' | 'contains' | 'starts' | 'null' | 'notnull';

export interface Filter {
	column: string;
	op: FilterOp;
	value?: string;
}

export interface BrowseParams {
	schema: string;
	table: string;
	limit: number;
	offset: number;
	sort?: string;
	dir?: 'asc' | 'desc';
	filters: Filter[];
	search?: string;
}

export async function browse(id: string, p: BrowseParams) {
	const cols = await columns(id, p.schema, p.table);
	if (!cols.length) throw new Error(`Relation ${p.schema}.${p.table} not found`);
	const known = new Set(cols.map((c) => c.name));

	const values: unknown[] = [];
	const where: string[] = [];
	for (const f of p.filters) {
		if (!known.has(f.column)) continue;
		const col = quoteIdent(f.column);
		switch (f.op) {
			case 'null':
				where.push(`${col} is null`);
				break;
			case 'notnull':
				where.push(`${col} is not null`);
				break;
			case 'contains':
				values.push(`%${f.value ?? ''}%`);
				where.push(`${col}::text ilike $${values.length}`);
				break;
			case 'starts':
				values.push(`${f.value ?? ''}%`);
				where.push(`${col}::text ilike $${values.length}`);
				break;
			default:
				if (!['=', '!=', '<', '>', '<=', '>='].includes(f.op)) continue;
				values.push(f.value ?? '');
				// Compare as text against the column's own type, letting Postgres cast the literal.
				where.push(`${col} ${f.op === '!=' ? '<>' : f.op} $${values.length}::text::${cols.find((c) => c.name === f.column)!.type}`);
		}
	}
	if (p.search?.trim()) {
		values.push(`%${p.search.trim()}%`);
		where.push(`(${cols.map((c) => `${quoteIdent(c.name)}::text ilike $${values.length}`).join(' or ')})`);
	}

	const from = `${quoteIdent(p.schema)}.${quoteIdent(p.table)}`;
	const whereSql = where.length ? `where ${where.join(' and ')}` : '';
	const pk = cols.filter((c) => c.isPrimaryKey).map((c) => quoteIdent(c.name));
	const order =
		p.sort && known.has(p.sort)
			? `order by ${quoteIdent(p.sort)} ${p.dir === 'desc' ? 'desc' : 'asc'} nulls last`
			: pk.length
				? `order by ${pk.join(', ')}`
				: '';

	return withClient(id, { readOnly: true }, async (client) => {
		const started = performance.now();
		const data = await client.query({
			text: `select * from ${from} ${whereSql} ${order} limit ${Math.floor(p.limit)} offset ${Math.floor(p.offset)}`,
			values,
			rowMode: 'array',
			types: typeParsers
		});
		const durationMs = Math.round(performance.now() - started);

		// Exact counts can be slow on big tables; fall back to the planner's estimate.
		let total: number | null = null;
		let totalIsEstimate = false;
		try {
			await client.query('SAVEPOINT count_sp');
			await client.query('SET LOCAL statement_timeout = 1500');
			const { rows } = await client.query({ text: `select count(*)::bigint as n from ${from} ${whereSql}`, values });
			total = Number(rows[0].n);
			await client.query('RELEASE SAVEPOINT count_sp');
		} catch {
			await client.query('ROLLBACK TO SAVEPOINT count_sp');
			if (!whereSql) {
				const { rows } = await client.query(
					`select greatest(reltuples, 0)::bigint as n from pg_class where oid = $1::regclass`,
					[from]
				);
				total = Number(rows[0]?.n ?? 0);
				totalIsEstimate = true;
			}
		}

		return {
			columns: cols,
			rows: data.rows,
			total,
			totalIsEstimate,
			durationMs
		};
	});
}

export async function structure(id: string, schema: string, table: string) {
	const [cols, meta, indexes, constraints, referencedBy, triggers] = await Promise.all([
		columns(id, schema, table),
		readQuery<{
			kind: string;
			est_rows: string;
			total: string | null;
			table_size: string | null;
			index_size: string | null;
			comment: string | null;
			owner: string;
			viewdef: string | null;
		}>(
			id, `select c.relkind as kind, greatest(c.reltuples, 0)::bigint as est_rows,
				case when c.relkind in ('r','m','p') then pg_total_relation_size(c.oid) end as total,
				case when c.relkind in ('r','m','p') then pg_table_size(c.oid) end as table_size,
				case when c.relkind in ('r','m','p') then pg_indexes_size(c.oid) end as index_size,
				obj_description(c.oid, 'pg_class') as comment,
				pg_get_userbyid(c.relowner) as owner,
				case when c.relkind in ('v','m') then pg_get_viewdef(c.oid, true) end as viewdef
			 from pg_class c join pg_namespace n on n.oid = c.relnamespace
			 where n.nspname = $1 and c.relname = $2`,
			[schema, table]
		),
		readQuery<{ name: string; def: string; primary: boolean; unique: boolean; size: string }>(
			id, `select ic.relname as name, pg_get_indexdef(i.indexrelid) as def, i.indisprimary as primary,
				i.indisunique as unique, pg_relation_size(i.indexrelid) as size
			 from pg_index i
			 join pg_class ic on ic.oid = i.indexrelid
			 join pg_class c on c.oid = i.indrelid
			 join pg_namespace n on n.oid = c.relnamespace
			 where n.nspname = $1 and c.relname = $2 order by i.indisprimary desc, ic.relname`,
			[schema, table]
		),
		readQuery<{ name: string; type: string; def: string }>(
			id, `select con.conname as name, con.contype as type, pg_get_constraintdef(con.oid, true) as def
			 from pg_constraint con
			 join pg_class c on c.oid = con.conrelid
			 join pg_namespace n on n.oid = c.relnamespace
			 where n.nspname = $1 and c.relname = $2 order by con.contype, con.conname`,
			[schema, table]
		),
		readQuery<{ name: string; from_schema: string; from_table: string; def: string }>(
			id, `select con.conname as name, fn.nspname as from_schema, fc.relname as from_table,
				pg_get_constraintdef(con.oid, true) as def
			 from pg_constraint con
			 join pg_class c on c.oid = con.confrelid
			 join pg_namespace n on n.oid = c.relnamespace
			 join pg_class fc on fc.oid = con.conrelid
			 join pg_namespace fn on fn.oid = fc.relnamespace
			 where con.contype = 'f' and n.nspname = $1 and c.relname = $2 order by 2, 3`,
			[schema, table]
		),
		readQuery<{ name: string; def: string; enabled: string }>(
			id, `select t.tgname as name, pg_get_triggerdef(t.oid, true) as def, t.tgenabled as enabled
			 from pg_trigger t
			 join pg_class c on c.oid = t.tgrelid
			 join pg_namespace n on n.oid = c.relnamespace
			 where not t.tgisinternal and n.nspname = $1 and c.relname = $2 order by 1`,
			[schema, table]
		)
	]);

	const m = meta[0];
	if (!m) throw new Error(`Relation ${schema}.${table} not found`);
	const CONSTRAINT: Record<string, string> = { p: 'primary key', f: 'foreign key', u: 'unique', c: 'check', x: 'exclusion', n: 'not null', t: 'trigger' };

	return {
		kind: KIND[m.kind] ?? 'table',
		estimatedRows: Number(m.est_rows),
		totalBytes: m.total == null ? null : Number(m.total),
		tableBytes: m.table_size == null ? null : Number(m.table_size),
		indexBytes: m.index_size == null ? null : Number(m.index_size),
		comment: m.comment,
		owner: m.owner,
		viewDefinition: m.viewdef,
		columns: cols,
		indexes: indexes.map((i) => ({ ...i, size: Number(i.size) })),
		constraints: constraints.map((c) => ({ ...c, type: CONSTRAINT[c.type] ?? c.type })),
		referencedBy,
		triggers: triggers.map((t) => ({ ...t, enabled: t.enabled !== 'D' }))
	};
}

export async function overview(id: string) {
	const [info, top, extensions, activity] = await Promise.all([
		readQuery<{
			version: string;
			db_size: string;
			started: string;
			current_user: string;
			superuser: boolean;
			can_create: boolean;
			max_connections: string;
			cache_hit: number | null;
			in_recovery: boolean;
		}>(
			id, `select version() as version,
				pg_database_size(current_database()) as db_size,
				pg_postmaster_start_time() as started,
				current_user as current_user,
				(select rolsuper from pg_roles where rolname = current_user) as superuser,
				has_database_privilege(current_database(), 'CREATE') as can_create,
				current_setting('max_connections') as max_connections,
				(select round(100.0 * sum(blks_hit) / nullif(sum(blks_hit) + sum(blks_read), 0), 2)::float8
					from pg_stat_database where datname = current_database()) as cache_hit,
				pg_is_in_recovery() as in_recovery`
		),
		readQuery<{ schema: string; name: string; size: string; est_rows: string }>(
			id, `select n.nspname as schema, c.relname as name, pg_total_relation_size(c.oid) as size,
				greatest(c.reltuples, 0)::bigint as est_rows
			 from pg_class c join pg_namespace n on n.oid = c.relnamespace
			 where c.relkind in ('r', 'm', 'p') and not c.relispartition and ${SYSTEM_SCHEMA_FILTER}
			 order by pg_total_relation_size(c.oid) desc limit 8`
		),
		readQuery<{ name: string; version: string }>(id, `select extname as name, extversion as version from pg_extension order by 1`),
		readQuery<{ state: string | null; count: number }>(
			id, `select state, count(*)::int as count from pg_stat_activity where datname = current_database() group by 1`
		)
	]);
	const i = info[0];
	return {
		version: i.version,
		serverVersion: /PostgreSQL ([\d.]+\w*)/.exec(i.version)?.[1] ?? i.version,
		databaseBytes: Number(i.db_size),
		startedAt: i.started,
		currentUser: i.current_user,
		superuser: i.superuser,
		canCreate: i.can_create,
		maxConnections: Number(i.max_connections),
		cacheHitRatio: i.cache_hit,
		inRecovery: i.in_recovery,
		largestTables: top.map((t) => ({ schema: t.schema, name: t.name, sizeBytes: Number(t.size), estimatedRows: Number(t.est_rows) })),
		extensions,
		activity: activity.map((a) => ({ state: a.state ?? 'background', count: a.count }))
	};
}

/** Compact schema description for editor autocompletion: { "schema.table": ["col", ...] }. */
export async function completionSchema(id: string) {
	const rows = await readQuery<{ schema: string; table: string; columns: string[] }>(
		id, `select n.nspname as schema, c.relname as table, json_agg(a.attname order by a.attnum) as columns
		 from pg_class c
		 join pg_namespace n on n.oid = c.relnamespace
		 join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
		 where c.relkind in ('r', 'v', 'm', 'f', 'p') and ${SYSTEM_SCHEMA_FILTER}
		 group by 1, 2 order by 1, 2 limit 2000`
	);
	return rows;
}
