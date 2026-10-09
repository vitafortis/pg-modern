/**
 * MySQL / MariaDB introspection through information_schema. Databases play the role
 * of Postgres schemas; the shapes returned match introspect.ts.
 */
import type mysql from 'mysql2/promise';
import { getConnection } from '../store.ts';
import { NotFound } from '../pg.ts';
import { quoteIdent, readQuery, serializeValue, serverInfo, withConnection } from './client.ts';
import type { ColumnInfo, DiagramColumn, RelationSummary, SchemaDiagram, SchemaTree } from '#lib/types.ts';
import type { BrowseParams } from '../introspect.ts';

export const SYSTEM_DATABASES = ['information_schema', 'mysql', 'performance_schema', 'sys'];
const SYSTEM_IN = SYSTEM_DATABASES.map((d) => `'${d}'`).join(', ');

const kindOf = (tableType: string): RelationSummary['kind'] => (/VIEW/i.test(tableType) && !/SYSTEM VERSIONED/i.test(tableType) ? 'view' : 'table');
const num = (v: unknown) => (v == null ? null : Number(v));

export async function schemaTree(id: string, includeSystem = false): Promise<SchemaTree> {
	const filter = (col: string) => (includeSystem ? '1 = 1' : `${col} NOT IN (${SYSTEM_IN})`);
	const [schemas, relations, routines] = await Promise.all([
		readQuery<{ name: string }>(id, `SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE ${filter('SCHEMA_NAME')} ORDER BY 1`),
		readQuery<{ schema: string; name: string; type: string; est_rows: string | null; size: string | null }>(
			id,
			`SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS est_rows,
				DATA_LENGTH + INDEX_LENGTH AS size
			 FROM information_schema.TABLES WHERE ${filter('TABLE_SCHEMA')} ORDER BY 1, 2`
		),
		readQuery<{ schema: string; count: string }>(
			id,
			`SELECT ROUTINE_SCHEMA AS \`schema\`, COUNT(*) AS count FROM information_schema.ROUTINES WHERE ${filter('ROUTINE_SCHEMA')} GROUP BY 1`
		)
	]);
	const fnCount = new Map(routines.map((r) => [r.schema, Number(r.count)]));
	const bySchema = new Map<string, RelationSummary[]>(schemas.map((s) => [s.name, []]));
	for (const r of relations) {
		if (!bySchema.has(r.schema)) bySchema.set(r.schema, []);
		const kind = kindOf(r.type);
		bySchema.get(r.schema)!.push({
			name: r.name,
			kind,
			estimatedRows: Number(r.est_rows ?? 0),
			sizeBytes: kind === 'view' ? null : num(r.size)
		});
	}
	return { schemas: [...bySchema].map(([name, relations]) => ({ name, relations, functions: fnCount.get(name) ?? 0 })) };
}

export async function columns(id: string, schema: string, table: string): Promise<ColumnInfo[]> {
	const rows = await readQuery<{ name: string; type: string; nullable: string; def: string | null; key: string; extra: string; comment: string }>(
		id,
		`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def,
			COLUMN_KEY AS \`key\`, EXTRA AS extra, COLUMN_COMMENT AS comment
		 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
		[schema, table]
	);
	// MariaDB's JSON is LONGTEXT with a json_valid() check; show it as json like MySQL does.
	const jsonCols = new Set<string>();
	if (rows.some((r) => /^longtext/i.test(String(r.type)))) {
		const checks = await readQuery<{ clause: string }>(
			id,
			`SELECT cc.CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS cc
			 JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
			 WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK'`,
			[schema, table]
		).catch(() => []);
		for (const c of checks) {
			const m = /^json_valid\(`((?:[^`]|``)+)`\)$/i.exec(String(c.clause).trim());
			if (m) jsonCols.add(m[1].replace(/``/g, '`'));
		}
	}
	return rows.map((r) => {
		const nullable = r.nullable === 'YES';
		// MariaDB reports "no default" on nullable columns as the literal NULL.
		const def = r.def == null || (nullable && String(r.def) === 'NULL') ? null : String(r.def);
		return {
			name: r.name,
			type: jsonCols.has(r.name) ? 'json' : String(r.type),
			nullable,
			default: def ?? (/auto_increment/i.test(r.extra) ? 'auto_increment' : null),
			isPrimaryKey: r.key === 'PRI',
			comment: r.comment || null
		};
	});
}

/** Row count with a short time limit; MySQL and MariaDB spell the limit differently. */
function countSql(flavor: string, from: string, whereSql: string): string {
	return flavor === 'mariadb'
		? `SET STATEMENT max_statement_time = 1.5 FOR SELECT COUNT(*) AS n FROM ${from} ${whereSql}`
		: `SELECT /*+ MAX_EXECUTION_TIME(1500) */ COUNT(*) AS n FROM ${from} ${whereSql}`;
}

export async function browse(id: string, p: BrowseParams) {
	const cols = await columns(id, p.schema, p.table);
	if (!cols.length) throw new Error(`Table ${p.schema}.${p.table} not found`);
	const known = new Set(cols.map((c) => c.name));

	const values: unknown[] = [];
	const where: string[] = [];
	for (const f of p.filters) {
		if (!known.has(f.column)) continue;
		const col = quoteIdent(f.column);
		switch (f.op) {
			case 'null':
				where.push(`${col} IS NULL`);
				break;
			case 'notnull':
				where.push(`${col} IS NOT NULL`);
				break;
			case 'contains':
				values.push(`%${f.value ?? ''}%`);
				where.push(`CAST(${col} AS CHAR) LIKE ?`);
				break;
			case 'starts':
				values.push(`${f.value ?? ''}%`);
				where.push(`CAST(${col} AS CHAR) LIKE ?`);
				break;
			default:
				if (!['=', '!=', '<', '>', '<=', '>='].includes(f.op)) continue;
				values.push(f.value ?? '');
				// MySQL converts the string literal to the column's type for the comparison.
				where.push(`${col} ${f.op === '!=' ? '<>' : f.op} ?`);
		}
	}
	if (p.search?.trim()) {
		const term = `%${p.search.trim()}%`;
		where.push(`(${cols.map((c) => (values.push(term), `CAST(${quoteIdent(c.name)} AS CHAR) LIKE ?`)).join(' OR ')})`);
	}

	const from = `${quoteIdent(p.schema)}.${quoteIdent(p.table)}`;
	const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
	const pk = cols.filter((c) => c.isPrimaryKey).map((c) => quoteIdent(c.name));
	const order =
		p.sort && known.has(p.sort)
			? `ORDER BY ${quoteIdent(p.sort)} IS NULL, ${quoteIdent(p.sort)} ${p.dir === 'desc' ? 'DESC' : 'ASC'}`
			: pk.length
				? `ORDER BY ${pk.join(', ')}`
				: '';

	return withConnection(id, { readOnly: true }, async (c, lease) => {
		const started = performance.now();
		const [rows] = await c.query({
			sql: `SELECT * FROM ${from} ${whereSql} ${order} LIMIT ${Math.floor(p.limit)} OFFSET ${Math.floor(p.offset)}`,
			values,
			rowsAsArray: true
		});
		const durationMs = Math.round(performance.now() - started);

		// Exact counts can be slow on big InnoDB tables; fall back to the statistics estimate.
		let total: number | null = null;
		let totalIsEstimate = false;
		try {
			const [res] = await c.query<mysql.RowDataPacket[]>({ sql: countSql(lease.entry.flavor, from, whereSql), values });
			total = Number(res[0].n);
		} catch {
			if (!whereSql) {
				const [res] = await c.query<mysql.RowDataPacket[]>(
					'SELECT TABLE_ROWS AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
					[p.schema, p.table]
				);
				total = Number(res[0]?.n ?? 0);
				totalIsEstimate = true;
			}
		}
		return {
			columns: cols,
			rows: (rows as unknown[][]).map((r) => r.map(serializeValue)),
			total,
			totalIsEstimate,
			durationMs
		};
	});
}

type Row = Record<string, unknown>;

export async function structure(id: string, schema: string, table: string) {
	const args = [schema, table];
	const [cols, meta, stats, constraints, keyColumns, refs, referencedBy, checks, triggers, indexSizes] = await Promise.all([
		columns(id, schema, table),
		readQuery<Row>(
			id,
			`SELECT t.TABLE_TYPE AS type, t.ENGINE AS engine, t.TABLE_ROWS AS est_rows, t.DATA_LENGTH AS data, t.INDEX_LENGTH AS idx,
				t.TABLE_COMMENT AS comment, t.TABLE_COLLATION AS collation, v.VIEW_DEFINITION AS viewdef, v.DEFINER AS definer
			 FROM information_schema.TABLES t
			 LEFT JOIN information_schema.VIEWS v ON v.TABLE_SCHEMA = t.TABLE_SCHEMA AND v.TABLE_NAME = t.TABLE_NAME
			 WHERE t.TABLE_SCHEMA = ? AND t.TABLE_NAME = ?`,
			args
		),
		readQuery<Row>(
			id,
			`SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq, COLUMN_NAME AS col, SUB_PART AS sub, INDEX_TYPE AS type
			 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`,
			args
		),
		readQuery<Row>(
			id,
			`SELECT CONSTRAINT_NAME AS name, CONSTRAINT_TYPE AS type FROM information_schema.TABLE_CONSTRAINTS
			 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY CONSTRAINT_TYPE, CONSTRAINT_NAME`,
			args
		),
		readQuery<Row>(
			id,
			`SELECT CONSTRAINT_NAME AS name, COLUMN_NAME AS col, REFERENCED_TABLE_SCHEMA AS ref_schema, REFERENCED_TABLE_NAME AS ref_table,
				REFERENCED_COLUMN_NAME AS ref_col
			 FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
			args
		),
		readQuery<Row>(
			id,
			`SELECT CONSTRAINT_NAME AS name, UPDATE_RULE AS on_update, DELETE_RULE AS on_delete FROM information_schema.REFERENTIAL_CONSTRAINTS
			 WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ?`,
			args
		),
		readQuery<Row>(
			id,
			`SELECT k.CONSTRAINT_NAME AS name, k.TABLE_SCHEMA AS from_schema, k.TABLE_NAME AS from_table, k.COLUMN_NAME AS col, k.REFERENCED_COLUMN_NAME AS ref_col
			 FROM information_schema.KEY_COLUMN_USAGE k
			 WHERE k.REFERENCED_TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME = ? ORDER BY 2, 3, 1, k.ORDINAL_POSITION`,
			args
		),
		// CHECK constraints: MySQL 8.0.16+ and MariaDB 10.2+; older servers simply have none.
		readQuery<Row>(
			id,
			`SELECT cc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS cc
			 JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
			 WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK'`,
			args
		).catch(() => [] as Row[]),
		readQuery<Row>(
			id,
			`SELECT TRIGGER_NAME AS name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event, ACTION_STATEMENT AS stmt
			 FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY 1`,
			args
		),
		// Per-index sizes need SELECT on mysql.innodb_index_stats; without it they show as unknown.
		readQuery<Row>(
			id,
			`SELECT index_name AS name, stat_value * @@innodb_page_size AS bytes FROM mysql.innodb_index_stats
			 WHERE database_name = ? AND table_name = ? AND stat_name = 'size'`,
			args
		).catch(() => [] as Row[])
	]);

	const m = meta[0];
	if (!m) throw new Error(`Table ${schema}.${table} not found`);
	const kind = kindOf(String(m.type));
	const sizeOf = new Map(indexSizes.map((r) => [String(r.name), Number(r.bytes)]));
	const q = quoteIdent;

	const byIndex = new Map<string, { unique: boolean; type: string; cols: string[] }>();
	for (const s of stats) {
		const name = String(s.name);
		const entry = byIndex.get(name) ?? { unique: Number(s.non_unique) === 0, type: String(s.type ?? 'BTREE'), cols: [] };
		entry.cols.push(s.col == null ? '(expression)' : `${q(String(s.col))}${s.sub ? `(${s.sub})` : ''}`);
		byIndex.set(name, entry);
	}
	const indexes = [...byIndex].map(([name, ix]) => ({
		name,
		def: `CREATE ${name === 'PRIMARY' ? 'UNIQUE ' : ix.unique ? 'UNIQUE ' : ''}INDEX ${q(name)} ON ${q(table)} USING ${ix.type} (${ix.cols.join(', ')})`,
		primary: name === 'PRIMARY',
		unique: ix.unique,
		size: sizeOf.has(name) ? sizeOf.get(name)! : null
	}));

	const colsOf = new Map<string, { cols: string[]; refSchema?: string; refTable?: string; refCols: string[] }>();
	for (const k of keyColumns) {
		const name = String(k.name);
		const entry = colsOf.get(name) ?? { cols: [], refCols: [] };
		entry.cols.push(q(String(k.col)));
		if (k.ref_table) {
			entry.refSchema = String(k.ref_schema);
			entry.refTable = String(k.ref_table);
			entry.refCols.push(q(String(k.ref_col)));
		}
		colsOf.set(name, entry);
	}
	const rules = new Map(refs.map((r) => [String(r.name), r]));
	const checkOf = new Map(checks.map((c) => [String(c.name), String(c.clause)]));
	const TYPES: Record<string, string> = { 'PRIMARY KEY': 'primary key', UNIQUE: 'unique', 'FOREIGN KEY': 'foreign key', CHECK: 'check' };
	const ruleText = (r: Row | undefined) =>
		[r?.on_update && r.on_update !== 'RESTRICT' && r.on_update !== 'NO ACTION' && ` ON UPDATE ${r.on_update}`, r?.on_delete && r.on_delete !== 'RESTRICT' && r.on_delete !== 'NO ACTION' && ` ON DELETE ${r.on_delete}`]
			.filter(Boolean)
			.join('');
	const constraintList = constraints.map((c) => {
		const name = String(c.name);
		const type = String(c.type);
		const k = colsOf.get(name);
		let def = type;
		if (type === 'PRIMARY KEY' || type === 'UNIQUE') def = `${type} (${k?.cols.join(', ') ?? ''})`;
		else if (type === 'FOREIGN KEY' && k) {
			const target = k.refSchema && k.refSchema !== schema ? `${q(k.refSchema)}.${q(k.refTable!)}` : q(k.refTable!);
			def = `FOREIGN KEY (${k.cols.join(', ')}) REFERENCES ${target}(${k.refCols.join(', ')})${ruleText(rules.get(name))}`;
		} else if (type === 'CHECK') def = `CHECK (${checkOf.get(name) ?? '…'})`;
		return { name, type: TYPES[type] ?? type.toLowerCase(), def };
	});

	const refGroups = new Map<string, { name: string; from_schema: string; from_table: string; cols: string[]; refCols: string[] }>();
	for (const r of referencedBy) {
		const key = `${r.from_schema}.${r.from_table}.${r.name}`;
		const g = refGroups.get(key) ?? { name: String(r.name), from_schema: String(r.from_schema), from_table: String(r.from_table), cols: [], refCols: [] };
		g.cols.push(q(String(r.col)));
		g.refCols.push(q(String(r.ref_col)));
		refGroups.set(key, g);
	}

	return {
		kind,
		estimatedRows: Number(m.est_rows ?? 0),
		totalBytes: kind === 'view' ? null : Number(m.data ?? 0) + Number(m.idx ?? 0),
		tableBytes: kind === 'view' ? null : num(m.data),
		indexBytes: kind === 'view' ? null : num(m.idx),
		comment: (m.comment as string) || null,
		owner: kind === 'view' ? String(m.definer ?? '') : '',
		storageEngine: (m.engine as string) ?? null,
		collation: (m.collation as string) ?? null,
		viewDefinition: (m.viewdef as string) ?? null,
		columns: cols,
		indexes,
		constraints: constraintList,
		referencedBy: [...refGroups.values()].map((g) => ({
			name: g.name,
			from_schema: g.from_schema,
			from_table: g.from_table,
			def: `FOREIGN KEY (${g.cols.join(', ')}) REFERENCES ${q(table)}(${g.refCols.join(', ')})`
		})),
		triggers: triggers.map((t) => ({ name: String(t.name), def: `${t.timing} ${t.event} FOR EACH ROW ${t.stmt}`, enabled: true }))
	};
}

/** The account's grants, and whether they amount to an administrator. */
export function summarizeGrants(grants: string[]) {
	const global = grants.filter((g) => /\bON \*\.\*/i.test(g));
	const all = global.some((g) => /^GRANT ALL( PRIVILEGES)? ON/i.test(g));
	const has = (priv: string) => all || global.some((g) => new RegExp(`(^GRANT |, )${priv}(,| ON)`, 'i').test(g));
	return {
		superuser: all || has('SUPER'),
		canWrite: all || ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER'].some((p) => grants.some((g) => new RegExp(`(^GRANT |, )${p}(,| ON)`, 'i').test(g) || /^GRANT ALL/i.test(g))),
		canCreate: all || grants.some((g) => /^GRANT ALL/i.test(g) || /(^GRANT |, )CREATE(,| ON)/i.test(g)),
		process: has('PROCESS'),
		connectionAdmin: has('SUPER') || has('CONNECTION_ADMIN')
	};
}

/** SHOW GRANTS for the current account, with password hashes and auth strings removed. */
export async function grants(id: string): Promise<string[]> {
	const rows = await readQuery<Row>(id, 'SHOW GRANTS');
	return rows.map((r) => redactGrant(String(Object.values(r)[0])));
}

export function redactGrant(grant: string): string {
	return grant.replace(/\s+IDENTIFIED\s+(BY|VIA|WITH)\b[\s\S]*?(?=\s+(WITH\s+GRANT\s+OPTION|REQUIRE\b)|$)/i, '');
}

export async function overview(id: string) {
	const conn = getConnection(id);
	if (!conn) throw new NotFound('Connection not found');
	const [info, status, top, engines, sessions, grantList] = await Promise.all([
		readQuery<Row>(
			id,
			`SELECT VERSION() AS version, @@version_comment AS comment, CURRENT_USER() AS current_user_, DATABASE() AS db,
				@@max_connections AS max_connections, @@read_only AS read_only, @@hostname AS hostname`
		),
		readQuery<Row>(id, `SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime', 'Threads_connected', 'Innodb_buffer_pool_reads', 'Innodb_buffer_pool_read_requests')`),
		readQuery<Row>(
			id,
			`SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name, DATA_LENGTH + INDEX_LENGTH AS size, TABLE_ROWS AS est_rows
			 FROM information_schema.TABLES WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA NOT IN (${SYSTEM_IN})
			 ORDER BY size DESC LIMIT 8`
		),
		readQuery<Row>(id, `SELECT ENGINE AS name, SUPPORT AS support FROM information_schema.ENGINES WHERE SUPPORT IN ('YES', 'DEFAULT') ORDER BY SUPPORT = 'DEFAULT' DESC, ENGINE`),
		readQuery<Row>(id, `SELECT COMMAND AS command, COUNT(*) AS count FROM information_schema.PROCESSLIST GROUP BY 1`),
		grants(id).catch(() => [] as string[])
	]);
	const i = info[0];
	const st = Object.fromEntries(status.map((r) => [String(r.Variable_name ?? r.VARIABLE_NAME), Number(r.Value ?? r.VARIABLE_VALUE)]));
	const dbName = (i.db as string) ?? conn.database;
	const [size] = await readQuery<Row>(
		id,
		`SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS bytes, COUNT(*) AS tables FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
		[dbName ?? '']
	);
	const g = summarizeGrants(grantList);
	const { flavor } = await serverInfo(id);
	const reads = st.Innodb_buffer_pool_reads;
	const requests = st.Innodb_buffer_pool_read_requests;
	const version = `${i.version}${i.comment ? ` ${i.comment}` : ''}`;
	return {
		engine: 'mysql' as const,
		flavor,
		version,
		serverVersion: /^[\d.]+/.exec(String(i.version))?.[0] ?? String(i.version),
		database: dbName ?? null,
		databaseBytes: Number(size?.bytes ?? 0),
		startedAt: st.Uptime ? new Date(Date.now() - st.Uptime * 1000).toISOString() : null,
		currentUser: String(i.current_user_),
		superuser: g.superuser,
		canCreate: g.canCreate,
		canWrite: g.canWrite,
		grants: grantList,
		maxConnections: Number(i.max_connections),
		threadsConnected: st.Threads_connected ?? null,
		cacheHitRatio: requests ? Math.round(10000 * (1 - (reads ?? 0) / requests)) / 100 : null,
		inRecovery: false,
		serverReadOnly: Number(i.read_only) === 1,
		largestTables: top.map((t) => ({ schema: String(t.schema), name: String(t.name), sizeBytes: Number(t.size ?? 0), estimatedRows: Number(t.est_rows ?? 0) })),
		extensions: engines.map((e) => ({ name: String(e.name), version: e.support === 'DEFAULT' ? 'default' : '' })),
		activity: sessions.map((s) => {
			const command = String(s.command).toLowerCase();
			return { state: command === 'sleep' ? 'idle' : command === 'query' || command === 'execute' ? 'active' : command, count: Number(s.count) };
		})
	};
}

/** Compact schema description for editor autocompletion. */
export async function completionSchema(id: string) {
	const rows = await readQuery<{ schema: string; table: string; column: string }>(
		id,
		`SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS \`table\`, COLUMN_NAME AS \`column\`
		 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA NOT IN (${SYSTEM_IN})
		 ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION LIMIT 50000`
	);
	const out: { schema: string; table: string; columns: string[] }[] = [];
	for (const r of rows) {
		const last = out.at(-1);
		if (last && last.schema === r.schema && last.table === r.table) last.columns.push(r.column);
		else {
			if (out.length >= 2000) break;
			out.push({ schema: r.schema, table: r.table, columns: [r.column] });
		}
	}
	return out;
}

export const DIAGRAM_LIMIT = 300;

/** Tables of one database with their columns and foreign keys, in the shape SchemaDiagram uses. */
export async function diagram(id: string, schema: string, { views = false } = {}): Promise<SchemaDiagram> {
	const rels = await readQuery<{ name: string; type: string }>(
		id,
		`SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES
		 WHERE TABLE_SCHEMA = ? AND (TABLE_TYPE <> 'VIEW' OR ?) ORDER BY TABLE_NAME LIMIT ?`,
		[schema, views ? 1 : 0, DIAGRAM_LIMIT + 1]
	);
	const truncated = rels.length > DIAGRAM_LIMIT;
	if (truncated) rels.length = DIAGRAM_LIMIT;
	if (!rels.length) return { schema, tables: [], foreignKeys: [], truncated };
	const names = rels.map((r) => r.name);

	const fkRows = await readQuery<{ name: string; from_table: string; col: string; to_schema: string; to_table: string; to_col: string }>(
		id,
		`SELECT CONSTRAINT_NAME AS name, TABLE_NAME AS from_table, COLUMN_NAME AS col, REFERENCED_TABLE_SCHEMA AS to_schema,
			REFERENCED_TABLE_NAME AS to_table, REFERENCED_COLUMN_NAME AS to_col
		 FROM information_schema.KEY_COLUMN_USAGE
		 WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL AND TABLE_NAME IN (?)
		 ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
		[schema, names]
	);
	const fks = new Map<string, { name: string; fromTable: string; toSchema: string; toTable: string; from: string[]; to: string[] }>();
	for (const r of fkRows) {
		const key = `${r.from_table}\u0000${r.name}`;
		const fk = fks.get(key) ?? { name: r.name, fromTable: r.from_table, toSchema: r.to_schema, toTable: r.to_table, from: [], to: [] };
		fk.from.push(r.col);
		fk.to.push(r.to_col);
		fks.set(key, fk);
	}

	const included = new Set(names);
	const external = new Map<string, { schema: string; name: string; keys: Set<string> }>();
	for (const fk of fks.values()) {
		if (fk.toSchema === schema && included.has(fk.toTable)) continue;
		const key = `${fk.toSchema}.${fk.toTable}`;
		const ext = external.get(key) ?? { schema: fk.toSchema, name: fk.toTable, keys: new Set<string>() };
		for (const c of fk.to) ext.keys.add(c);
		external.set(key, ext);
	}

	const colRows = await readQuery<{ schema: string; table: string; name: string; type: string; nullable: string; key: string }>(
		id,
		`SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS \`table\`, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_KEY AS \`key\`
		 FROM information_schema.COLUMNS
		 WHERE (TABLE_SCHEMA = ? AND TABLE_NAME IN (?)) ${external.size ? `OR (TABLE_SCHEMA, TABLE_NAME) IN (${[...external.values()].map(() => '(?, ?)').join(', ')})` : ''}
		 ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
		[schema, names, ...[...external.values()].flatMap((e) => [e.schema, e.name])]
	);
	const colsBy = new Map<string, DiagramColumn[]>();
	for (const c of colRows) {
		const key = `${c.schema}.${c.table}`;
		const ext = c.schema !== schema || !included.has(c.table) ? external.get(key) : undefined;
		const pk = c.key === 'PRI';
		if (ext && !pk && !ext.keys.has(c.name)) continue;
		let list = colsBy.get(key);
		if (!list) colsBy.set(key, (list = []));
		list.push({ name: c.name, type: String(c.type), nullable: c.nullable === 'YES', isPrimaryKey: pk });
	}

	return {
		schema,
		truncated,
		tables: [
			...rels.map((r) => ({ schema, name: r.name, kind: kindOf(r.type), columns: colsBy.get(`${schema}.${r.name}`) ?? [] })),
			...[...external.values()].map((e) => ({ schema: e.schema, name: e.name, kind: 'table' as const, columns: colsBy.get(`${e.schema}.${e.name}`) ?? [], external: true }))
		],
		foreignKeys: [...fks.values()].map((fk) => ({
			name: fk.name,
			fromSchema: schema,
			fromTable: fk.fromTable,
			fromColumns: fk.from,
			toSchema: fk.toSchema,
			toTable: fk.toTable,
			toColumns: fk.to
		}))
	};
}
