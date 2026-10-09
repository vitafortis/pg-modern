/**
 * Staged row edits from the table browser: validated against the table's metadata,
 * turned into parameterised UPDATE / INSERT / DELETE statements on the full key, and
 * applied in one transaction where every statement must affect exactly one row.
 */
import { buildDelete, buildInsert, buildSelectRow, buildUpdate, type Dialect, type Stmt } from './sql.ts';
import { sameValue, type EditColumn, type RowChange, type TableMeta } from '#lib/rows.ts';
import type { Tx } from './db.ts';

export { sameValue };

export class ChangeError extends Error {}

/**
 * update/delete: `key` is the row's full key (column → value as loaded); update: `set`
 * column → new value and `original` column → value as loaded (edited columns);
 * insert: `values` (missing columns get their default).
 */
export type ChangeInput = RowChange;

export interface PlannedChange {
	index: number;
	op: ChangeInput['op'];
	stmt: Stmt;
	key?: Record<string, unknown>;
	/** Edited columns whose old value can't be compared in SQL; read and compared first. */
	precheck?: { stmt: Stmt; columns: string[]; expected: unknown[] };
}

export const MAX_CHANGES = 1000;

/** A value from the editor as a bind parameter for this column. */
export function toParam(dialect: Dialect, col: EditColumn, v: unknown): unknown {
	if (v === null || v === undefined) return null;
	if (col.kind === 'json') return JSON.stringify(v);
	if (typeof v === 'boolean') return dialect === 'postgres' ? v : v ? 1 : 0;
	if (typeof v === 'number') {
		if (!Number.isFinite(v)) throw new ChangeError(`"${col.name}": not a finite number`);
		return v;
	}
	if (typeof v !== 'string') throw new ChangeError(`"${col.name}": expected text, a number, true/false or null`);
	if (col.kind === 'boolean' && dialect !== 'postgres') {
		if (/^(true|t|yes|y|on|1)$/i.test(v.trim())) return 1;
		if (/^(false|f|no|n|off|0)$/i.test(v.trim())) return 0;
	}
	// MySQL BIT columns take numbers; a string would be stored as its bytes.
	if (dialect === 'mysql' && /^bit\b/i.test(col.type) && /^\d+$/.test(v.trim())) return Number(v.trim());
	return v;
}

function record(v: unknown, what: string): Record<string, unknown> {
	if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ChangeError(`${what} must be an object`);
	return v as Record<string, unknown>;
}

/** Validates the changes against the table and builds their statements (nothing runs). */
export function planChanges(meta: TableMeta, input: unknown): PlannedChange[] {
	if (!meta.writable) throw new ChangeError(meta.reason ?? 'This relation can’t be edited');
	if (!Array.isArray(input) || !input.length) throw new ChangeError('No changes');
	if (input.length > MAX_CHANGES) throw new ChangeError(`At most ${MAX_CHANGES} changes at a time`);
	const { dialect, schema, table } = meta;
	const byName = new Map(meta.columns.map((c) => [c.name, c]));
	const column = (name: string) => {
		const c = byName.get(name);
		if (!c) throw new ChangeError(`Unknown column "${name}"`);
		return c;
	};
	const editable = (name: string) => {
		const c = column(name);
		if (!c.editable) throw new ChangeError(`"${name}" can’t be changed (${c.reason ?? 'read-only'})`);
		return c;
	};
	const keyOf = (raw: unknown) => {
		if (!meta.key.length) throw new ChangeError('This table has no primary key, so existing rows can’t be edited or deleted');
		const k = record(raw, '"key"');
		if (Object.keys(k).length !== meta.key.length || meta.key.some((c) => !(c in k))) {
			throw new ChangeError(`"key" must have exactly the key columns: ${meta.key.join(', ')}`);
		}
		const out: Record<string, unknown> = {};
		for (const c of meta.key) {
			if (k[c] === null || k[c] === undefined) throw new ChangeError(`Key column "${c}" can’t be NULL`);
			out[c] = toParam(dialect, column(c), k[c]);
		}
		return out;
	};

	return input.map((raw, index): PlannedChange => {
		const ch = record(raw, 'Each change') as unknown as ChangeInput;
		if (ch.op === 'insert') {
			const values: Record<string, unknown> = {};
			for (const [c, v] of Object.entries(record(ch.values ?? {}, '"values"'))) values[c] = toParam(dialect, editable(c), v);
			return { index, op: 'insert', stmt: buildInsert(dialect, { schema, table, values }) };
		}
		if (ch.op === 'delete') {
			const key = keyOf(ch.key);
			return { index, op: 'delete', key, stmt: buildDelete(dialect, { schema, table, key }) };
		}
		if (ch.op === 'update') {
			const key = keyOf(ch.key);
			const setIn = record(ch.set, '"set"');
			if (!Object.keys(setIn).length) throw new ChangeError('An update needs at least one column');
			const originalIn = ch.original === undefined ? {} : record(ch.original, '"original"');
			const set: Record<string, unknown> = {};
			const original: Record<string, unknown> = {};
			const compare: Record<string, EditColumn['compare']> = {};
			const unchecked: string[] = [];
			for (const [c, v] of Object.entries(setIn)) {
				const col = editable(c);
				set[c] = toParam(dialect, col, v);
				if (c in originalIn) {
					original[c] = toParam(dialect, col, originalIn[c]);
					compare[c] = col.compare;
					if (col.compare === 'none') unchecked.push(c);
				}
			}
			const planned: PlannedChange = { index, op: 'update', key, stmt: buildUpdate(dialect, { schema, table, key, set, original, compare }) };
			if (unchecked.length) {
				planned.precheck = {
					stmt: buildSelectRow(dialect, { schema, table, key, columns: unchecked }),
					columns: unchecked,
					expected: unchecked.map((c) => originalIn[c])
				};
			}
			return planned;
		}
		throw new ChangeError(`Unknown change type "${String((ch as { op?: unknown }).op)}"`);
	});
}

export interface ApplyFailure {
	index: number;
	op: ChangeInput['op'];
	key?: Record<string, unknown>;
	reason: string;
	/** The row changed or disappeared since it was loaded. */
	conflict: boolean;
}

export interface ApplyOutcome {
	commit: boolean;
	counts: { updated: number; inserted: number; deleted: number };
	failed?: ApplyFailure;
}

const describeKey = (key: Record<string, unknown> | undefined) =>
	key ? Object.entries(key).map(([k, v]) => `${k} = ${v === null ? 'NULL' : typeof v === 'string' ? `'${v}'` : String(v)}`).join(', ') : '';

/**
 * Runs the planned statements in order inside `tx`; stops at the first problem. The
 * caller commits only when `commit` is true. `isServerError` tells database errors
 * (reported per change) from crashes (rethrown).
 */
export async function applyPlanned(tx: Tx, meta: TableMeta, planned: PlannedChange[], isServerError: (err: unknown) => boolean, errorText: (err: unknown) => string): Promise<ApplyOutcome> {
	const counts = { updated: 0, inserted: 0, deleted: 0 };
	const fail = (p: PlannedChange, reason: string, conflict: boolean): ApplyOutcome => ({
		commit: false,
		counts,
		failed: { index: p.index, op: p.op, key: p.key, reason, conflict }
	});
	for (const p of planned) {
		const where = p.key ? ` (${describeKey(p.key)})` : '';
		try {
			if (p.precheck) {
				const { rows } = await tx.run(p.precheck.stmt.sql, p.precheck.stmt.params);
				if (!rows.length) return fail(p, `The row${where} no longer exists.`, true);
				const changed = p.precheck.columns.filter((_, i) => !sameValue(rows[0][i], p.precheck!.expected[i]));
				if (changed.length) return fail(p, `Someone else changed ${changed.join(', ')} in the row${where} since you loaded it.`, true);
			}
			const { rowCount } = await tx.run(p.stmt.sql, p.stmt.params);
			if (rowCount === 1) {
				counts[p.op === 'update' ? 'updated' : p.op === 'insert' ? 'inserted' : 'deleted']++;
				continue;
			}
			if (rowCount > 1) return fail(p, `This would change ${rowCount} rows instead of one; the key isn’t unique.`, false);
			if (p.op === 'insert') return fail(p, 'The row wasn’t inserted.', false);
			const probe = buildSelectRow(meta.dialect, { schema: meta.schema, table: meta.table, key: p.key!, columns: [] });
			const { rows } = await tx.run(probe.sql, probe.params);
			if (!rows.length) return fail(p, `The row${where} no longer exists.`, true);
			return fail(p, `Someone else changed the row${where} since you loaded it.`, true);
		} catch (err) {
			if (!isServerError(err)) throw err;
			return fail(p, errorText(err), false);
		}
	}
	return { commit: true, counts };
}
