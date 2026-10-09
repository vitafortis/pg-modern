/**
 * Structural diff between two schema snapshots (or a snapshot and the live schema),
 * plus best-effort migration SQL for the simple cases. Pure; shared with the browser.
 *
 * Objects are matched by identity (schema + name, routines also by argument list),
 * so a rename shows up as one object removed and another added.
 */
import { OBJECT_TYPES, type ObjectType, type SchemaSnapshotData, type SnapshotColumn, type SnapshotTable } from './model.ts';

export type Change = 'added' | 'removed' | 'changed';

export interface FieldChange {
	field: string;
	before: string | null;
	after: string | null;
}

/** A change inside an object: a column, index or constraint of a table, or a property. */
export interface DetailChange {
	kind: 'column' | 'index' | 'constraint' | 'primary key' | 'property';
	name: string;
	change: Change;
	before?: string | null;
	after?: string | null;
	fields?: FieldChange[];
}

export interface DiffItem {
	type: ObjectType;
	/** Identity, unique per type: `schema.name`, `schema.name(args)`, `schema.table.trigger`. */
	key: string;
	schema: string | null;
	name: string;
	/** The table a trigger belongs to. */
	table?: string;
	change: Change;
	details: DetailChange[];
	/** Full definitions (views, routines, triggers, types) for a text diff. */
	before?: string | null;
	after?: string | null;
	/** The definition changed but at least one side didn't keep its text (only a hash). */
	bodyUnavailable?: boolean;
}

export interface Counts {
	added: number;
	removed: number;
	changed: number;
}

export interface SchemaDiff {
	items: DiffItem[];
	summary: Record<ObjectType, Counts>;
	total: Counts;
	/** Every schema that appears on either side, for filtering. */
	schemas: string[];
	identical: boolean;
}

const zero = (): Counts => ({ added: 0, removed: 0, changed: 0 });

export function describeColumn(c: SnapshotColumn): string {
	return [c.type, c.nullable ? null : 'NOT NULL', c.default != null ? `DEFAULT ${c.default}` : null, c.extra || null].filter(Boolean).join(' ');
}

function byKey<T>(list: T[], key: (x: T) => string): Map<string, T> {
	return new Map(list.map((x) => [key(x), x]));
}

/** Calls `fn` for every key on either side, in a stable order (left order first, then new ones). */
function pairs<T>(a: Map<string, T>, b: Map<string, T>, fn: (key: string, before: T | undefined, after: T | undefined) => void) {
	for (const [k, v] of a) fn(k, v, b.get(k));
	for (const [k, v] of b) if (!a.has(k)) fn(k, undefined, v);
}

const changeOf = (before: unknown, after: unknown): Change => (before === undefined ? 'added' : after === undefined ? 'removed' : 'changed');

function field(fields: FieldChange[], name: string, before: unknown, after: unknown) {
	const b = before == null ? null : String(before);
	const a = after == null ? null : String(after);
	if (b !== a) fields.push({ field: name, before: b, after: a });
}

function tableDetails(before: SnapshotTable | undefined, after: SnapshotTable | undefined): DetailChange[] {
	const out: DetailChange[] = [];
	const bCols = byKey(before?.columns ?? [], (c) => c.name);
	const aCols = byKey(after?.columns ?? [], (c) => c.name);
	pairs(bCols, aCols, (name, b, a) => {
		if (b && a) {
			const fields: FieldChange[] = [];
			field(fields, 'type', b.type, a.type);
			field(fields, 'nullable', b.nullable ? 'yes' : 'no', a.nullable ? 'yes' : 'no');
			field(fields, 'default', b.default, a.default);
			field(fields, 'extra', b.extra, a.extra);
			if (fields.length) out.push({ kind: 'column', name, change: 'changed', before: describeColumn(b), after: describeColumn(a), fields });
		} else {
			out.push({ kind: 'column', name, change: changeOf(b, a), before: b ? describeColumn(b) : null, after: a ? describeColumn(a) : null });
		}
	});

	const bPk = before?.primaryKey ?? null;
	const aPk = after?.primaryKey ?? null;
	const pkText = (p: typeof bPk) => (p ? `(${p.columns.join(', ')})` : null);
	if (pkText(bPk) !== pkText(aPk) && (before && after)) {
		out.push({ kind: 'primary key', name: aPk?.name ?? bPk?.name ?? 'primary key', change: !bPk ? 'added' : !aPk ? 'removed' : 'changed', before: pkText(bPk), after: pkText(aPk) });
	}

	pairs(byKey(before?.indexes ?? [], (i) => i.name), byKey(after?.indexes ?? [], (i) => i.name), (name, b, a) => {
		if (b && a && b.definition === a.definition) return;
		out.push({ kind: 'index', name, change: changeOf(b, a), before: b?.definition ?? null, after: a?.definition ?? null });
	});
	pairs(byKey(before?.constraints ?? [], (c) => c.name), byKey(after?.constraints ?? [], (c) => c.name), (name, b, a) => {
		if (b && a && b.definition === a.definition && b.type === a.type) return;
		out.push({
			kind: 'constraint',
			name,
			change: changeOf(b, a),
			before: b ? `${b.type.toUpperCase()} ${b.definition}` : null,
			after: a ? `${a.type.toUpperCase()} ${a.definition}` : null
		});
	});

	if (before && after) {
		const props: FieldChange[] = [];
		field(props, 'kind', before.kind, after.kind);
		field(props, 'comment', before.comment, after.comment);
		field(props, 'options', before.options, after.options);
		for (const p of props) out.push({ kind: 'property', name: p.field, change: 'changed', before: p.before, after: p.after });
	}
	return out;
}

/** Compares two snapshots: what it takes to get from `from` to `to`. */
export function diffSchemas(from: SchemaSnapshotData, to: SchemaSnapshotData): SchemaDiff {
	const items: DiffItem[] = [];

	pairs(byKey(from.schemas, (s) => s), byKey(to.schemas, (s) => s), (name, b, a) => {
		if (b === undefined || a === undefined) items.push({ type: 'schema', key: name, schema: name, name, change: changeOf(b, a), details: [] });
	});

	const tKey = (t: { schema: string; name: string }) => `${t.schema}.${t.name}`;
	pairs(byKey(from.tables, tKey), byKey(to.tables, tKey), (key, b, a) => {
		const details = tableDetails(b, a);
		if (b && a && !details.length) return;
		const t = (a ?? b)!;
		items.push({ type: 'table', key, schema: t.schema, name: t.name, change: changeOf(b, a), details });
	});

	pairs(byKey(from.views, tKey), byKey(to.views, tKey), (key, b, a) => {
		if (b && a && b.definition === a.definition && b.materialized === a.materialized) return;
		const v = (a ?? b)!;
		const details: DetailChange[] = [];
		if (b && a && b.materialized !== a.materialized) {
			details.push({ kind: 'property', name: 'materialized', change: 'changed', before: String(b.materialized), after: String(a.materialized) });
		}
		items.push({ type: 'view', key, schema: v.schema, name: v.name, change: changeOf(b, a), details, before: b?.definition ?? null, after: a?.definition ?? null });
	});

	const rKey = (r: { schema: string; name: string; args: string }) => `${r.schema}.${r.name}(${r.args})`;
	pairs(byKey(from.routines, rKey), byKey(to.routines, rKey), (key, b, a) => {
		const r = (a ?? b)!;
		const details: DetailChange[] = [];
		if (b && a) {
			const fields: FieldChange[] = [];
			field(fields, 'kind', b.kind, a.kind);
			field(fields, 'returns', b.returns, a.returns);
			field(fields, 'language', b.language, a.language);
			for (const f of fields) details.push({ kind: 'property', name: f.field, change: 'changed', before: f.before, after: f.after });
			if (!details.length && b.bodyHash === a.bodyHash) return;
		}
		const unavailable = !!b && !!a && b.bodyHash !== a.bodyHash && (b.body == null || a.body == null);
		items.push({
			type: 'routine',
			key,
			schema: r.schema,
			name: `${r.name}(${r.args})`,
			change: changeOf(b, a),
			details,
			before: b?.body ?? null,
			after: a?.body ?? null,
			...(unavailable ? { bodyUnavailable: true } : {})
		});
	});

	const trKey = (t: { schema: string; table: string; name: string }) => `${t.schema}.${t.table}.${t.name}`;
	pairs(byKey(from.triggers, trKey), byKey(to.triggers, trKey), (key, b, a) => {
		if (b && a && b.definition === a.definition) return;
		const t = (a ?? b)!;
		items.push({ type: 'trigger', key, schema: t.schema, table: t.table, name: t.name, change: changeOf(b, a), details: [], before: b?.definition ?? null, after: a?.definition ?? null });
	});

	pairs(byKey(from.types, tKey), byKey(to.types, tKey), (key, b, a) => {
		if (b && a && b.definition === a.definition && b.kind === a.kind) return;
		const t = (a ?? b)!;
		items.push({ type: 'type', key, schema: t.schema, name: t.name, change: changeOf(b, a), details: [], before: b ? `${b.kind}: ${b.definition}` : null, after: a ? `${a.kind}: ${a.definition}` : null });
	});

	pairs(byKey(from.extensions, (e) => e.name), byKey(to.extensions, (e) => e.name), (key, b, a) => {
		if (b && a && b.version === a.version) return;
		items.push({
			type: 'extension',
			key,
			schema: null,
			name: key,
			change: changeOf(b, a),
			details: b && a ? [{ kind: 'property', name: 'version', change: 'changed', before: b.version, after: a.version }] : [],
			before: b?.version ?? null,
			after: a?.version ?? null
		});
	});

	const summary = Object.fromEntries(OBJECT_TYPES.map((t) => [t, zero()])) as Record<ObjectType, Counts>;
	const total = zero();
	for (const i of items) {
		summary[i.type][i.change]++;
		total[i.change]++;
	}
	const schemas = [...new Set([...from.schemas, ...to.schemas, ...items.map((i) => i.schema).filter((s): s is string => !!s)])].sort();
	return { items, summary, total, schemas, identical: items.length === 0 };
}

// --- migration SQL ------------------------------------------------------------------

function quoter(engine: string) {
	return engine === 'mysql' ? (n: string) => `\`${n.replace(/`/g, '``')}\`` : (n: string) => `"${n.replace(/"/g, '""')}"`;
}

/**
 * Best-effort SQL that would turn the diff's `from` side into `to`: new tables, added and dropped
 * columns, nullability and default changes, and new or dropped indexes. Anything it
 * can't express safely (type changes on MySQL, constraints, views, functions) becomes
 * a comment to handle by hand. Destructive statements are left commented out.
 */
export function migrationSql(diff: SchemaDiff, to: SchemaSnapshotData): string {
	const engine = to.engine;
	const q = quoter(engine);
	const mysql = engine === 'mysql';
	const qualified = (schema: string, name: string) => `${q(schema)}.${q(name)}`;
	const lines: string[] = [
		'-- Best-effort migration generated by pg·modern. Review every statement before running it;',
		'-- it covers simple cases only (columns, nullability, defaults, indexes, new tables).',
		''
	];
	const manual: string[] = [];
	const colDef = (c: SnapshotColumn) =>
		[q(c.name), c.type, c.nullable ? null : 'NOT NULL', c.default != null ? `DEFAULT ${c.default}` : null, mysql && c.extra ? c.extra : null].filter(Boolean).join(' ');
	const toTables = byKey(to.tables, (t) => `${t.schema}.${t.name}`);

	for (const item of diff.items) {
		if (item.type === 'schema') {
			if (item.change === 'added') lines.push(mysql ? `CREATE DATABASE ${q(item.name)};` : `CREATE SCHEMA ${q(item.name)};`);
			else manual.push(`-- ${mysql ? 'DROP DATABASE' : 'DROP SCHEMA'} ${q(item.name)};  (removed — dropped manually if intended)`);
			continue;
		}
		if (item.type !== 'table') {
			if (item.type === 'extension' && !mysql && item.change === 'added') lines.push(`CREATE EXTENSION IF NOT EXISTS ${q(item.name)};`);
			else if (item.type === 'extension' && !mysql && item.change === 'changed') lines.push(`ALTER EXTENSION ${q(item.name)} UPDATE TO '${item.after}';`);
			else if ((item.type === 'view' || item.type === 'routine' || item.type === 'trigger') && item.change !== 'removed' && item.after && /^\s*create\b/i.test(item.after)) {
				lines.push(`-- ${item.type} ${item.key} (${item.change})`, item.after.replace(/;?\s*$/, ';'));
			} else manual.push(`-- ${item.type} ${item.key}: ${item.change} — not generated, apply by hand`);
			continue;
		}

		const name = qualified(item.schema!, item.name);
		if (item.change === 'added') {
			const t = toTables.get(item.key)!;
			const defs = t.columns.map((c) => `\t${colDef(c)}`);
			if (t.primaryKey) defs.push(`\tPRIMARY KEY (${t.primaryKey.columns.map(q).join(', ')})`);
			lines.push(`CREATE TABLE ${name} (\n${defs.join(',\n')}\n);`);
			for (const i of t.indexes) lines.push(indexSql(i.definition, mysql, name, i.name, q));
			for (const c of t.constraints) manual.push(`-- ${name}: constraint ${c.name} ${c.type.toUpperCase()} ${c.definition}`);
			continue;
		}
		if (item.change === 'removed') {
			manual.push(`-- DROP TABLE ${name};  (removed — dropped manually if intended)`);
			continue;
		}
		const after = toTables.get(item.key)!;
		for (const d of item.details) {
			if (d.kind === 'column') {
				const col = after.columns.find((c) => c.name === d.name);
				if (d.change === 'added' && col) lines.push(`ALTER TABLE ${name} ADD COLUMN ${colDef(col)};`);
				else if (d.change === 'removed') lines.push(`-- ALTER TABLE ${name} DROP COLUMN ${q(d.name)};  (destructive — uncomment to apply)`);
				else if (col) {
					if (mysql) {
						lines.push(`ALTER TABLE ${name} MODIFY COLUMN ${colDef(col)};`);
						continue;
					}
					for (const f of d.fields ?? []) {
						if (f.field === 'nullable') lines.push(`ALTER TABLE ${name} ALTER COLUMN ${q(d.name)} ${f.after === 'no' ? 'SET' : 'DROP'} NOT NULL;`);
						else if (f.field === 'default') lines.push(`ALTER TABLE ${name} ALTER COLUMN ${q(d.name)} ${f.after == null ? 'DROP DEFAULT' : `SET DEFAULT ${f.after}`};`);
						else if (f.field === 'type') lines.push(`ALTER TABLE ${name} ALTER COLUMN ${q(d.name)} TYPE ${f.after};  -- may need USING …`);
						else manual.push(`-- ${name}.${d.name}: ${f.field} ${f.before ?? '∅'} → ${f.after ?? '∅'}`);
					}
				}
			} else if (d.kind === 'index') {
				if (d.change !== 'added') lines.push(mysql ? `DROP INDEX ${q(d.name)} ON ${name};` : `DROP INDEX ${q(item.schema!)}.${q(d.name)};`);
				if (d.change !== 'removed' && d.after) lines.push(indexSql(d.after, mysql, name, d.name, q));
			} else {
				manual.push(`-- ${name}: ${d.kind} ${d.name} ${d.change}${d.after ? ` → ${d.after}` : ''}`);
			}
		}
	}
	if (lines.length === 3 && !manual.length) lines.push('-- No differences.');
	if (manual.length) lines.push('', '-- Not generated (review by hand):', ...manual);
	return lines.join('\n') + '\n';
}

function indexSql(definition: string, mysql: boolean, table: string, name: string, q: (n: string) => string): string {
	if (!mysql) return /;\s*$/.test(definition) ? definition : `${definition};`;
	// MySQL definitions are captured as `[UNIQUE ]INDEX name (cols)[ USING x]`.
	const m = /^(UNIQUE |FULLTEXT |SPATIAL )?INDEX \S+ (\(.*\))/.exec(definition);
	return m ? `CREATE ${m[1] ?? ''}INDEX ${q(name)} ON ${table} ${m[2]};` : `-- index ${name}: ${definition}`;
}
