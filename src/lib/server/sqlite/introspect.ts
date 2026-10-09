/**
 * SQLite introspection through sqlite_schema and the table-valued pragmas. The
 * database is the single schema `main`; the shapes returned match introspect.ts.
 */
import { statSync } from 'node:fs';
import { getConnection } from '../store.ts';
import { NotFound } from '../pg.ts';
import { quoteIdentFor } from '#lib/engine.ts';
import { guessApp } from './files.ts';
import { readArrays, readMany, readQuery, softQuery } from './client.ts';
import type { ColumnInfo, DiagramColumn, RelationSummary, SchemaDiagram, SchemaTree } from '#lib/types.ts';
import type { BrowseParams } from '../introspect.ts';

export const SCHEMA = 'main';
const q = (name: string) => quoteIdentFor('sqlite', name);
type Row = Record<string, unknown>;

/** Above this, sizes from dbstat (which walks every page) and exact counts are skipped. */
const EXACT_LIMIT_BYTES = 1024 * 1024 * 1024;

function connOf(id: string) {
	const conn = getConnection(id);
	if (!conn) throw new NotFound('Connection not found');
	return conn;
}

function fileBytes(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

function checkSchema(schema: string) {
	if (schema !== SCHEMA) throw new NotFound(`SQLite connections have one schema, "${SCHEMA}"`);
}

/** Row counts per table: exact for databases up to 1 GB, else sqlite_stat1 estimates. */
async function rowCounts(id: string, tables: string[], exact: boolean): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	const stats = await softQuery<{ tbl: string; stat: string }>(id, 'SELECT tbl, stat FROM sqlite_stat1');
	for (const s of stats) out.set(s.tbl, Math.max(out.get(s.tbl) ?? 0, Number(String(s.stat).split(' ')[0]) || 0));
	if (exact && tables.length) {
		const counts = await readMany(id, tables.map((t) => ({ sql: `SELECT count(*) AS n FROM ${q(t)}` })), { soft: true });
		counts.forEach((r, i) => Array.isArray(r) && out.set(tables[i], Number(r[0]?.n ?? 0)));
	}
	return out;
}

async function sizes(id: string, exact: boolean): Promise<Map<string, number> | null> {
	if (!exact) return null;
	const rows = await softQuery<{ name: string; bytes: number }>(id, 'SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name');
	return rows.length ? new Map(rows.map((r) => [r.name, Number(r.bytes)])) : null;
}

async function relations(id: string, includeSystem: boolean) {
	return readQuery<{ name: string; type: string; sql: string | null }>(
		id,
		`SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table', 'view') AND (? OR name NOT LIKE 'sqlite\\_%' ESCAPE '\\') ORDER BY name`,
		[includeSystem ? 1 : 0]
	);
}

export async function schemaTree(id: string, includeSystem = false): Promise<SchemaTree> {
	const conn = connOf(id);
	const exact = fileBytes(conn.database) <= EXACT_LIMIT_BYTES;
	const rels = await relations(id, includeSystem);
	const tables = rels.filter((r) => r.type === 'table' && !/^create\s+virtual/i.test(r.sql ?? '')).map((r) => r.name);
	const [counts, bytes] = await Promise.all([rowCounts(id, tables, exact), sizes(id, exact)]);
	return {
		schemas: [
			{
				name: SCHEMA,
				functions: 0,
				relations: rels.map(
					(r): RelationSummary => ({
						name: r.name,
						kind: r.type === 'view' ? 'view' : /^create\s+virtual/i.test(r.sql ?? '') ? 'foreign' : 'table',
						estimatedRows: counts.get(r.name) ?? 0,
						sizeBytes: r.type === 'view' ? null : (bytes?.get(r.name) ?? null)
					})
				)
			}
		]
	};
}

export async function columns(id: string, table: string): Promise<ColumnInfo[]> {
	const rows = await readQuery<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number; hidden: number }>(
		id,
		'SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid',
		[table]
	);
	return rows.map((r) => ({
		name: r.name,
		type: (r.type || 'any').toLowerCase() + (r.hidden === 2 || r.hidden === 3 ? ' generated' : ''),
		nullable: !r.notnull && !r.pk,
		default: r.dflt_value,
		isPrimaryKey: r.pk > 0,
		comment: null
	}));
}

export async function browse(id: string, p: BrowseParams) {
	checkSchema(p.schema);
	const cols = await columns(id, p.table);
	if (!cols.length) throw new Error(`Table ${p.table} not found`);
	const known = new Set(cols.map((c) => c.name));
	const values: unknown[] = [];
	const where: string[] = [];
	for (const f of p.filters) {
		if (!known.has(f.column)) continue;
		const col = q(f.column);
		switch (f.op) {
			case 'null':
				where.push(`${col} IS NULL`);
				break;
			case 'notnull':
				where.push(`${col} IS NOT NULL`);
				break;
			case 'contains':
				values.push(`%${f.value ?? ''}%`);
				where.push(`CAST(${col} AS TEXT) LIKE ?`);
				break;
			case 'starts':
				values.push(`${f.value ?? ''}%`);
				where.push(`CAST(${col} AS TEXT) LIKE ?`);
				break;
			default:
				if (!['=', '!=', '<', '>', '<=', '>='].includes(f.op)) continue;
				// A bound value has no affinity, so the column's numeric affinity applies to it.
				values.push(f.value ?? '');
				where.push(`${col} ${f.op === '!=' ? '<>' : f.op} ?`);
		}
	}
	if (p.search?.trim()) {
		const term = `%${p.search.trim()}%`;
		where.push(`(${cols.map((c) => (values.push(term), `CAST(${q(c.name)} AS TEXT) LIKE ?`)).join(' OR ')})`);
	}
	const from = q(p.table);
	const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
	const pk = cols.filter((c) => c.isPrimaryKey).map((c) => q(c.name));
	const order =
		p.sort && known.has(p.sort)
			? `ORDER BY ${q(p.sort)} IS NULL, ${q(p.sort)} ${p.dir === 'desc' ? 'DESC' : 'ASC'}`
			: pk.length
				? `ORDER BY ${pk.join(', ')}`
				: '';

	const started = performance.now();
	const res = await readArrays(id, `SELECT * FROM ${from} ${whereSql} ${order} LIMIT ${Math.floor(p.limit)} OFFSET ${Math.floor(p.offset)}`, values, p.limit);
	const durationMs = Math.round(performance.now() - started);
	let total: number | null = null;
	let totalIsEstimate = false;
	const conn = connOf(id);
	if (whereSql || fileBytes(conn.database) <= EXACT_LIMIT_BYTES) {
		const [count] = await readMany(id, [{ sql: `SELECT count(*) AS n FROM ${from} ${whereSql}`, params: values }], { soft: true });
		if (Array.isArray(count)) total = Number(count[0]?.n ?? 0);
	} else {
		const est = await rowCounts(id, [], false);
		if (est.has(p.table)) {
			total = est.get(p.table)!;
			totalIsEstimate = true;
		} else {
			const [count] = await readMany(id, [{ sql: `SELECT count(*) AS n FROM ${from}` }], { soft: true });
			if (Array.isArray(count)) total = Number(count[0]?.n ?? 0);
		}
	}
	return { columns: cols, rows: res.rows, total, totalIsEstimate, durationMs };
}

/** `PRIMARY KEY`, `UNIQUE`, … from an index's origin. */
const ORIGIN: Record<string, string> = { pk: 'primary key', u: 'unique' };

export async function structure(id: string, schema: string, table: string) {
	checkSchema(schema);
	const conn = connOf(id);
	const exact = fileBytes(conn.database) <= EXACT_LIMIT_BYTES;
	const [[meta], indexList, fks, referencing, triggers, indexSql] = (await readMany(id, [
		{ sql: `SELECT type, sql FROM sqlite_schema WHERE name = ? AND type IN ('table', 'view')`, params: [table] },
		{ sql: 'SELECT name, "unique", origin, partial FROM pragma_index_list(?) ORDER BY origin = \'pk\' DESC, name', params: [table] },
		{ sql: 'SELECT id, seq, "table" AS ref, "from" AS col, "to" AS ref_col, on_update, on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq', params: [table] },
		{
			sql: `SELECT m.name AS from_table, f.id, f.seq, f."from" AS col, f."to" AS ref_col FROM sqlite_schema m, pragma_foreign_key_list(m.name) f
				WHERE m.type = 'table' AND f."table" = ? COLLATE NOCASE ORDER BY m.name, f.id, f.seq`,
			params: [table]
		},
		{ sql: `SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`, params: [table] },
		{ sql: `SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = ?`, params: [table] }
	])) as Row[][];
	if (!meta) throw new Error(`Table ${table} not found`);
	const columnList = await columns(id, table);
	const kind = meta.type === 'view' ? 'view' : 'table';
	const sql = String(meta.sql ?? '');

	const ixCols = indexList.length
		? ((await readMany(
				id,
				indexList.map((ix) => ({ sql: 'SELECT name, desc, coll, key FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno', params: [ix.name] }))
			)) as Row[][])
		: [];
	const sizeRows = exact
		? await softQuery<{ name: string; bytes: number }>(
				id,
				`SELECT name, sum(pgsize) AS bytes FROM dbstat WHERE name IN (${[table, ...indexList.map((i) => String(i.name))].map(() => '?').join(', ')}) GROUP BY name`,
				[table, ...indexList.map((i) => String(i.name))]
			)
		: [];
	const sizeOf = new Map(sizeRows.map((r) => [r.name, Number(r.bytes)]));
	const sqlOf = new Map(indexSql.map((r) => [String(r.name), r.sql as string | null]));
	const [count] = kind === 'table' && exact ? await readMany(id, [{ sql: `SELECT count(*) AS n FROM ${q(table)}` }], { soft: true }) : [null];
	const estimatedRows = Array.isArray(count) ? Number(count[0]?.n ?? 0) : ((await rowCounts(id, [], false)).get(table) ?? 0);

	const pkCols = columnList.filter((c) => c.isPrimaryKey);
	const indexes = indexList.map((ix, i) => {
		const name = String(ix.name);
		const colsText = (ixCols[i] ?? []).map((c) => (c.name == null ? '(expression)' : `${q(String(c.name))}${c.desc ? ' DESC' : ''}`)).join(', ');
		return {
			name,
			def: sqlOf.get(name) ?? `${ix.origin === 'pk' ? 'PRIMARY KEY' : 'UNIQUE'} (${colsText}) — automatic index`,
			primary: ix.origin === 'pk',
			unique: Number(ix.unique) === 1,
			size: sizeOf.has(name) ? sizeOf.get(name)! : null
		};
	});

	const constraints: { name: string; type: string; def: string }[] = [];
	// A rowid table's INTEGER PRIMARY KEY has no separate index.
	if (pkCols.length && !indexList.some((ix) => ix.origin === 'pk')) {
		constraints.push({ name: 'PRIMARY KEY', type: 'primary key', def: `PRIMARY KEY (${pkCols.map((c) => q(c.name)).join(', ')})` });
	}
	for (const ix of indexList) {
		if (ix.origin === 'c') continue;
		const i = indexList.indexOf(ix);
		constraints.push({
			name: String(ix.name),
			type: ORIGIN[String(ix.origin)] ?? String(ix.origin),
			def: `${ix.origin === 'pk' ? 'PRIMARY KEY' : 'UNIQUE'} (${(ixCols[i] ?? []).map((c) => q(String(c.name))).join(', ')})`
		});
	}
	const fkGroups = new Map<number, { ref: string; cols: string[]; refCols: (string | null)[]; onUpdate: string; onDelete: string }>();
	for (const f of fks) {
		const g = fkGroups.get(Number(f.id)) ?? { ref: String(f.ref), cols: [], refCols: [], onUpdate: String(f.on_update), onDelete: String(f.on_delete) };
		g.cols.push(String(f.col));
		g.refCols.push(f.ref_col == null ? null : String(f.ref_col));
		fkGroups.set(Number(f.id), g);
	}
	for (const [fkId, g] of fkGroups) {
		const rules = [g.onUpdate !== 'NO ACTION' && ` ON UPDATE ${g.onUpdate}`, g.onDelete !== 'NO ACTION' && ` ON DELETE ${g.onDelete}`].filter(Boolean).join('');
		const refCols = g.refCols.every((c) => c == null) ? '' : `(${g.refCols.map((c) => q(c ?? '?')).join(', ')})`;
		constraints.push({
			name: `fk_${fkId}`,
			type: 'foreign key',
			def: `FOREIGN KEY (${g.cols.map(q).join(', ')}) REFERENCES ${q(g.ref)}${refCols}${rules}`
		});
	}
	for (const m of sql.matchAll(/\bCHECK\s*\(/gi)) {
		// The balanced (...) after CHECK.
		let depth = 0;
		let end = m.index! + m[0].length - 1;
		for (; end < sql.length; end++) {
			if (sql[end] === '(') depth++;
			else if (sql[end] === ')' && --depth === 0) break;
		}
		constraints.push({ name: `check_${constraints.length + 1}`, type: 'check', def: sql.slice(m.index!, end + 1) });
	}

	const refGroups = new Map<string, { from_table: string; cols: string[]; refCols: string[] }>();
	for (const r of referencing) {
		const key = `${r.from_table}\u0000${r.id}`;
		const g = refGroups.get(key) ?? { from_table: String(r.from_table), cols: [], refCols: [] };
		g.cols.push(q(String(r.col)));
		g.refCols.push(r.ref_col == null ? (pkCols[g.refCols.length]?.name ? q(pkCols[g.refCols.length].name) : '?') : q(String(r.ref_col)));
		refGroups.set(key, g);
	}

	const tableBytes = sizeOf.get(table) ?? null;
	const indexBytes = indexList.length ? (exact ? indexList.reduce((n, ix) => n + (sizeOf.get(String(ix.name)) ?? 0), 0) : null) : exact ? 0 : null;
	const storage = /^create\s+virtual/i.test(sql)
		? `virtual (${/using\s+(\w+)/i.exec(sql)?.[1] ?? '?'})`
		: [/without\s+rowid/i.test(sql) ? 'WITHOUT ROWID' : 'rowid', /\)\s*(?:without\s+rowid\s*,\s*)?strict\b/i.test(sql) ? 'STRICT' : ''].filter(Boolean).join(', ');

	return {
		kind,
		estimatedRows,
		totalBytes: kind === 'view' || tableBytes == null ? null : tableBytes + (indexBytes ?? 0),
		tableBytes: kind === 'view' ? null : tableBytes,
		indexBytes: kind === 'view' ? null : indexBytes,
		comment: null,
		owner: '',
		storageEngine: kind === 'view' ? null : storage,
		collation: null,
		viewDefinition: kind === 'view' ? sql : null,
		createSql: sql,
		columns: columnList,
		indexes,
		constraints,
		referencedBy: [...refGroups.values()].map((g, i) => ({
			name: `fk_${i}`,
			from_schema: SCHEMA,
			from_table: g.from_table,
			def: `FOREIGN KEY (${g.cols.join(', ')}) REFERENCES ${q(table)}(${g.refCols.join(', ')})`
		})),
		triggers: triggers.map((t) => ({ name: String(t.name), def: String(t.sql ?? ''), enabled: true }))
	};
}

export async function overview(id: string) {
	const conn = connOf(id);
	const path = conn.database;
	const fileSize = fileBytes(path);
	const exact = fileSize <= EXACT_LIMIT_BYTES;
	const [[info], objects] = (await readMany(id, [
		{
			sql: `SELECT sqlite_version() AS version, (SELECT page_size FROM pragma_page_size) AS page_size, (SELECT page_count FROM pragma_page_count) AS page_count,
				(SELECT freelist_count FROM pragma_freelist_count) AS freelist, (SELECT journal_mode FROM pragma_journal_mode) AS journal_mode,
				(SELECT encoding FROM pragma_encoding) AS encoding, (SELECT user_version FROM pragma_user_version) AS user_version,
				(SELECT application_id FROM pragma_application_id) AS application_id, (SELECT auto_vacuum FROM pragma_auto_vacuum) AS auto_vacuum`
		},
		{ sql: `SELECT type, count(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' GROUP BY type` }
	])) as Row[][];
	const tables = (await relations(id, false)).filter((r) => r.type === 'table' && !/^create\s+virtual/i.test(r.sql ?? '')).map((r) => r.name);
	const [counts, bytes] = await Promise.all([rowCounts(id, tables, exact), sizes(id, exact)]);
	const largestTables = tables
		.map((name) => ({ schema: SCHEMA, name, sizeBytes: bytes?.get(name) ?? 0, estimatedRows: counts.get(name) ?? 0 }))
		.sort((a, b) => b.sizeBytes - a.sizeBytes || b.estimatedRows - a.estimatedRows)
		.slice(0, 8);
	const count = (type: string) => Number(objects.find((o) => o.type === type)?.n ?? 0);
	const pageSize = Number(info.page_size);
	return {
		engine: 'sqlite' as const,
		flavor: 'sqlite' as const,
		version: `SQLite ${info.version}`,
		serverVersion: String(info.version),
		path,
		app: guessApp(conn.snapshot?.containerPath ?? path) ?? null,
		snapshot: conn.snapshot ?? null,
		fileBytes: fileSize,
		walBytes: fileBytes(`${path}-wal`),
		databaseBytes: pageSize * Number(info.page_count),
		pageSize,
		pageCount: Number(info.page_count),
		freelistCount: Number(info.freelist),
		journalMode: String(info.journal_mode),
		encoding: String(info.encoding),
		userVersion: Number(info.user_version),
		applicationId: Number(info.application_id),
		autoVacuum: ['none', 'full', 'incremental'][Number(info.auto_vacuum)] ?? String(info.auto_vacuum),
		counts: { tables: count('table'), views: count('view'), indexes: count('index'), triggers: count('trigger') },
		sizesKnown: !!bytes,
		rowsExact: exact,
		largestTables
	};
}

/** Compact schema description for editor autocompletion. */
export async function completionSchema(id: string) {
	const rows = await readQuery<{ tbl: string; col: string }>(
		id,
		`SELECT m.name AS tbl, p.name AS col FROM sqlite_schema m JOIN pragma_table_info(m.name) p
		 WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY m.name, p.cid LIMIT 50000`
	);
	const out: { schema: string; table: string; columns: string[] }[] = [];
	for (const r of rows) {
		const last = out.at(-1);
		if (last && last.table === r.tbl) last.columns.push(r.col);
		else {
			if (out.length >= 2000) break;
			out.push({ schema: SCHEMA, table: r.tbl, columns: [r.col] });
		}
	}
	return out;
}

export const DIAGRAM_LIMIT = 300;

export async function diagram(id: string, schema: string, { views = false } = {}): Promise<SchemaDiagram> {
	checkSchema(schema);
	const rels = (await relations(id, false)).filter((r) => r.type === 'table' || views);
	const truncated = rels.length > DIAGRAM_LIMIT;
	if (truncated) rels.length = DIAGRAM_LIMIT;
	if (!rels.length) return { schema, tables: [], foreignKeys: [], truncated };
	const [colRows, fkRows] = (await readMany(id, [
		{
			sql: `SELECT m.name AS tbl, p.name, p.type, p."notnull", p.pk FROM sqlite_schema m JOIN pragma_table_info(m.name) p
				WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY m.name, p.cid`
		},
		{
			sql: `SELECT m.name AS from_table, f.id, f.seq, f."table" AS to_table, f."from" AS col, f."to" AS to_col
				FROM sqlite_schema m, pragma_foreign_key_list(m.name) f WHERE m.type = 'table' ORDER BY m.name, f.id, f.seq`
		}
	])) as Row[][];
	const included = new Set(rels.map((r) => r.name));
	const colsBy = new Map<string, DiagramColumn[]>();
	for (const c of colRows) {
		const t = String(c.tbl);
		if (!colsBy.has(t)) colsBy.set(t, []);
		colsBy.get(t)!.push({ name: String(c.name), type: String(c.type || 'any').toLowerCase(), nullable: !c.notnull && !Number(c.pk), isPrimaryKey: Number(c.pk) > 0 });
	}
	// Table names in REFERENCES are case-insensitive; map them to the real name.
	const realName = new Map([...colsBy.keys()].map((n) => [n.toLowerCase(), n]));
	const fks = new Map<string, { name: string; fromTable: string; toTable: string; from: string[]; to: (string | null)[] }>();
	for (const r of fkRows) {
		if (!included.has(String(r.from_table))) continue;
		const key = `${r.from_table}\u0000${r.id}`;
		const toTable = realName.get(String(r.to_table).toLowerCase()) ?? String(r.to_table);
		const fk = fks.get(key) ?? { name: `${r.from_table}_fk_${r.id}`, fromTable: String(r.from_table), toTable, from: [], to: [] };
		fk.from.push(String(r.col));
		fk.to.push(r.to_col == null ? null : String(r.to_col));
		fks.set(key, fk);
	}
	return {
		schema,
		truncated,
		tables: rels.map((r) => ({ schema, name: r.name, kind: r.type === 'view' ? ('view' as const) : ('table' as const), columns: colsBy.get(r.name) ?? [] })),
		foreignKeys: [...fks.values()]
			.filter((fk) => included.has(fk.toTable))
			.map((fk) => {
				// REFERENCES t without columns means t's primary key.
				const pk = (colsBy.get(fk.toTable) ?? []).filter((c) => c.isPrimaryKey).map((c) => c.name);
				return {
					name: fk.name,
					fromSchema: schema,
					fromTable: fk.fromTable,
					fromColumns: fk.from,
					toSchema: schema,
					toTable: fk.toTable,
					toColumns: fk.to.map((c, i) => c ?? pk[i] ?? '?')
				};
			})
	};
}
