/**
 * The engine-agnostic shape of a schema snapshot, shared by the server (capture,
 * storage, diff) and the browser (diff view). No server-only imports.
 *
 * Everything an engine can't express is simply left empty (MySQL has no types or
 * extensions, SQLite has a single schema), so new engines only need a capture
 * function that fills this in.
 */

export interface SnapshotColumn {
	name: string;
	type: string;
	nullable: boolean;
	default: string | null;
	/** Identity / auto_increment / generated expression / ON UPDATE, as the engine reports it. */
	extra?: string | null;
}

export interface SnapshotIndex {
	name: string;
	/** The engine's own definition (pg_get_indexdef, or a synthesized `INDEX name (cols)` on MySQL). */
	definition: string;
	unique: boolean;
}

export interface SnapshotConstraint {
	name: string;
	type: 'foreign key' | 'unique' | 'check' | 'exclusion';
	definition: string;
}

export interface SnapshotTable {
	schema: string;
	name: string;
	kind: 'table' | 'partitioned' | 'foreign';
	/** In ordinal order (that order is part of the schema, so it isn't re-sorted). */
	columns: SnapshotColumn[];
	primaryKey: { name: string; columns: string[] } | null;
	/** Foreign keys, unique, check and exclusion constraints, by name. */
	constraints: SnapshotConstraint[];
	/** Indexes not backing a constraint, by name. */
	indexes: SnapshotIndex[];
	comment?: string | null;
	/** Storage engine and similar table options (MySQL). */
	options?: string | null;
}

export interface SnapshotView {
	schema: string;
	name: string;
	materialized: boolean;
	definition: string;
}

export interface SnapshotRoutine {
	schema: string;
	name: string;
	kind: 'function' | 'procedure' | 'aggregate' | 'window';
	/** Argument list as the engine prints it; overloads differ here. */
	args: string;
	returns: string | null;
	language: string | null;
	/** Hash of the full definition, so a change is caught even when the body isn't kept. */
	bodyHash: string;
	/** The full definition; dropped (keeping `bodyHash`) when a snapshot would be too big. */
	body?: string | null;
}

export interface SnapshotTrigger {
	schema: string;
	table: string;
	name: string;
	definition: string;
}

export interface SnapshotType {
	schema: string;
	name: string;
	kind: 'enum' | 'domain' | 'composite' | 'other';
	definition: string;
}

export interface SnapshotExtension {
	name: string;
	version: string;
}

export interface SchemaSnapshotData {
	format: 1;
	engine: string;
	schemas: string[];
	tables: SnapshotTable[];
	views: SnapshotView[];
	routines: SnapshotRoutine[];
	triggers: SnapshotTrigger[];
	types: SnapshotType[];
	extensions: SnapshotExtension[];
	/** Routine bodies were dropped to stay under the size cap (hashes are still compared). */
	bodiesOmitted?: boolean;
}

export type ObjectType = 'schema' | 'table' | 'view' | 'routine' | 'trigger' | 'type' | 'extension';

export const OBJECT_TYPES: ObjectType[] = ['schema', 'table', 'view', 'routine', 'trigger', 'type', 'extension'];

export const OBJECT_LABELS: Record<ObjectType, string> = {
	schema: 'Schemas',
	table: 'Tables',
	view: 'Views',
	routine: 'Functions & procedures',
	trigger: 'Triggers',
	type: 'Types',
	extension: 'Extensions'
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byKeys = <T>(...keys: ((x: T) => string)[]) => (a: T, b: T) => {
	for (const k of keys) {
		const c = cmp(k(a), k(b));
		if (c) return c;
	}
	return 0;
};

/** Trailing whitespace and CRLFs vary between servers and drivers; they never matter. */
export function normText(s: string | null | undefined): string {
	return (s ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

/**
 * Puts a captured schema into canonical form: every list sorted by its identity, text
 * normalized, optional fields made explicit. Two captures of the same schema produce
 * the same JSON (and so the same hash) whatever order the catalog returned rows in.
 */
export function normalizeSchema(s: SchemaSnapshotData): SchemaSnapshotData {
	const out: SchemaSnapshotData = {
		format: 1,
		engine: s.engine,
		schemas: [...new Set(s.schemas)].sort(cmp),
		tables: s.tables
			.map((t) => ({
				schema: t.schema,
				name: t.name,
				kind: t.kind,
				columns: t.columns.map((c) => ({
					name: c.name,
					type: c.type,
					nullable: !!c.nullable,
					default: c.default == null ? null : normText(c.default),
					extra: c.extra ? normText(c.extra) : null
				})),
				primaryKey: t.primaryKey ? { name: t.primaryKey.name, columns: [...t.primaryKey.columns] } : null,
				constraints: t.constraints
					.map((c) => ({ name: c.name, type: c.type, definition: normText(c.definition) }))
					.sort(byKeys((c) => c.type, (c) => c.name)),
				indexes: t.indexes.map((i) => ({ name: i.name, definition: normText(i.definition), unique: !!i.unique })).sort(byKeys((i) => i.name)),
				comment: t.comment ? normText(t.comment) : null,
				options: t.options ? normText(t.options) : null
			}))
			.sort(byKeys((t) => t.schema, (t) => t.name)),
		views: s.views
			.map((v) => ({ schema: v.schema, name: v.name, materialized: !!v.materialized, definition: normText(v.definition) }))
			.sort(byKeys((v) => v.schema, (v) => v.name)),
		routines: s.routines
			.map((r) => ({
				schema: r.schema,
				name: r.name,
				kind: r.kind,
				args: r.args ?? '',
				returns: r.returns ?? null,
				language: r.language ?? null,
				bodyHash: r.bodyHash,
				body: r.body == null ? null : normText(r.body)
			}))
			.sort(byKeys((r) => r.schema, (r) => r.name, (r) => r.args)),
		triggers: s.triggers
			.map((t) => ({ schema: t.schema, table: t.table, name: t.name, definition: normText(t.definition) }))
			.sort(byKeys((t) => t.schema, (t) => t.table, (t) => t.name)),
		types: s.types
			.map((t) => ({ schema: t.schema, name: t.name, kind: t.kind, definition: normText(t.definition) }))
			.sort(byKeys((t) => t.schema, (t) => t.name)),
		extensions: s.extensions.map((e) => ({ name: e.name, version: e.version })).sort(byKeys((e) => e.name))
	};
	if (s.bodiesOmitted) out.bodiesOmitted = true;
	return out;
}

/**
 * The part of a snapshot that identifies the schema: everything except routine bodies
 * (their hashes stand in) and capture flags. Used for hashing, so a snapshot whose
 * bodies were dropped for size still hashes the same as a full one.
 */
export function hashableSchema(s: SchemaSnapshotData): unknown {
	return {
		...s,
		bodiesOmitted: undefined,
		routines: s.routines.map((r) => ({ ...r, body: undefined }))
	};
}

/** JSON with object keys sorted, so equal values always serialize identically. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_k, v) =>
		v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v
	);
}

export interface SnapshotStats {
	schemas: number;
	tables: number;
	columns: number;
	views: number;
	routines: number;
	triggers: number;
	types: number;
	extensions: number;
	indexes: number;
}

export function snapshotStats(s: SchemaSnapshotData): SnapshotStats {
	return {
		schemas: s.schemas.length,
		tables: s.tables.length,
		columns: s.tables.reduce((n, t) => n + t.columns.length, 0),
		views: s.views.length,
		routines: s.routines.length,
		triggers: s.triggers.length,
		types: s.types.length,
		extensions: s.extensions.length,
		indexes: s.tables.reduce((n, t) => n + t.indexes.length, 0)
	};
}

/** Snapshot metadata as listed in the browser (the schema itself is fetched on demand). */
export interface SchemaSnapshotMeta {
	id: string;
	connectionId: string;
	engine: string;
	label: string;
	note: string | null;
	auto: boolean;
	hash: string;
	sizeBytes: number;
	stats: SnapshotStats;
	createdBy: string | null;
	createdAt: string;
	/** Set on responses: the signed-in user may delete it. */
	canDelete?: boolean;
}

/** One side of a comparison. */
export type DiffSource = { kind: 'live'; connectionId: string } | { kind: 'snapshot'; connectionId: string; snapshotId: string };
