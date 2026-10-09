/**
 * Row editing and CSV import types shared by the server and the browser.
 */

/** `sqlite` is listed so a third engine can reuse the builders (`?` params, "double-quoted" names). */
export type Dialect = 'postgres' | 'mysql' | 'sqlite';

/**
 * How a column's original value can be compared in a WHERE clause (optimistic
 * concurrency): `eq` null-safe equality, `json` as jsonb (Postgres json has no `=`),
 * `none` not reliably comparable (floats on MySQL, xml, geometry, …), checked by
 * reading the row instead.
 */
export type CompareMode = 'eq' | 'json' | 'none';

export type EditKind = 'text' | 'number' | 'boolean' | 'json' | 'date' | 'enum' | 'binary';

export interface EditColumn {
	name: string;
	type: string;
	nullable: boolean;
	default: string | null;
	/** Values can be changed (not generated, identity-always or binary). */
	editable: boolean;
	/** Why not, when it can't. */
	reason?: string;
	kind: EditKind;
	/** Allowed values of an enum column. */
	options?: string[];
	compare: CompareMode;
}

export interface TableMeta {
	dialect: Dialect;
	schema: string;
	table: string;
	/** Rows can be changed at all (a base table). */
	writable: boolean;
	reason?: string;
	/** Columns identifying a row: the primary key, or a unique key on NOT NULL columns. */
	key: string[];
	keyKind: 'primary' | 'unique' | null;
	columns: EditColumn[];
}

/** GET /api/connections/[id]/edit */
export interface EditInfo extends TableMeta {
	/** The current user's effective mode right now. */
	readOnly: boolean;
	importMaxBytes: number;
}

export type OnConflict = 'error' | 'skip' | 'update';

/** One staged change, as sent to POST /api/connections/[id]/edit. */
export interface RowChange {
	op: 'update' | 'insert' | 'delete';
	key?: Record<string, unknown>;
	set?: Record<string, unknown>;
	original?: Record<string, unknown>;
	values?: Record<string, unknown>;
}

/** Values compare equal the way the table browser shows them (same driver parsing). */
export function sameValue(a: unknown, b: unknown): boolean {
	const norm = (v: unknown) => JSON.stringify(v === undefined ? null : v);
	return norm(a) === norm(b);
}
