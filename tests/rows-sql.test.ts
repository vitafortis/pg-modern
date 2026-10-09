import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	batchSize,
	buildBatchInsert,
	buildCreateTable,
	buildDelete,
	buildInsert,
	buildSelectRow,
	buildUpdate,
	conflictClause,
	describeBatch,
	literal,
	validColumnType
} from '../src/lib/server/rows/sql.ts';
import { applyPlanned, planChanges, sameValue, toParam } from '../src/lib/server/rows/edit.ts';
import { chooseKey } from '../src/lib/server/rows/db.ts';
import type { EditColumn, TableMeta, Tx } from '../src/lib/server/rows/db.ts';
import { fieldValue, parseImportOptions, importRows, createStatement } from '../src/lib/server/rows/import.ts';

const t = { schema: 'public', table: 'users' };

test('update: postgres, full key, null-safe concurrency check on edited columns', () => {
	const s = buildUpdate('postgres', { ...t, key: { id: 7 }, set: { name: 'Ann', bio: null }, original: { name: 'Anne', bio: 'x' } });
	assert.equal(s.sql, 'UPDATE "public"."users" SET "name" = $1, "bio" = $2 WHERE "id" = $3 AND "name" IS NOT DISTINCT FROM $4 AND "bio" IS NOT DISTINCT FROM $5');
	assert.deepEqual(s.params, ['Ann', null, 7, 'Anne', 'x']);
	assert.equal(s.display, `UPDATE "public"."users" SET "name" = 'Ann', "bio" = NULL WHERE "id" = 7 AND "name" IS NOT DISTINCT FROM 'Anne' AND "bio" IS NOT DISTINCT FROM 'x'`);
});

test('update: mysql uses ? and <=>; composite keys; NULL originals', () => {
	const s = buildUpdate('mysql', { schema: 'shop', table: 'order items', key: { order_id: 1, line: 2 }, set: { qty: '3' }, original: { qty: null } });
	assert.equal(s.sql, 'UPDATE `shop`.`order items` SET `qty` = ? WHERE `order_id` = ? AND `line` = ? AND `qty` <=> ?');
	assert.deepEqual(s.params, ['3', 1, 2, null]);
	assert.match(s.display, /`qty` <=> NULL$/);
});

test('update: sqlite dialect uses ? and IS, double-quoted names', () => {
	const s = buildUpdate('sqlite', { schema: 'main', table: 't', key: { id: 1 }, set: { a: 'x' }, original: { a: 'y' } });
	assert.equal(s.sql, 'UPDATE "main"."t" SET "a" = ? WHERE "id" = ? AND "a" IS ?');
});

test('update: json compares as jsonb, uncomparable columns are left out of the WHERE', () => {
	const s = buildUpdate('postgres', {
		...t,
		key: { id: 1 },
		set: { doc: '{"a":1}', pos: '(1,2)' },
		original: { doc: '{"a": 0}', pos: '(0,0)' },
		compare: { doc: 'json', pos: 'none' }
	});
	assert.equal(s.sql, 'UPDATE "public"."users" SET "doc" = $1, "pos" = $2 WHERE "id" = $3 AND "doc"::jsonb IS NOT DISTINCT FROM $4::jsonb');
	assert.equal(s.params.length, 4);
});

test('update: changing the key itself matches on the old key', () => {
	const s = buildUpdate('postgres', { ...t, key: { id: 1 }, set: { id: 2 }, original: { id: 1 } });
	assert.equal(s.sql, 'UPDATE "public"."users" SET "id" = $1 WHERE "id" = $2');
	assert.deepEqual(s.params, [2, 1]);
});

test('identifiers are quoted, values never inlined', () => {
	const s = buildUpdate('postgres', { schema: 'a"b', table: 'c', key: { 'i"d': "1'; drop table x; --" }, set: { n: "O'Brien" } });
	assert.equal(s.sql, 'UPDATE "a""b"."c" SET "n" = $1 WHERE "i""d" = $2');
	assert.ok(!s.sql.includes('drop'));
	assert.equal(literal('postgres', "O'Brien"), "'O''Brien'");
	assert.equal(literal('mysql', "O'Brien\\"), "'O\\'Brien\\\\'");
	const m = buildUpdate('mysql', { schema: 'd', table: 'we`ird', key: { id: 1 }, set: { n: 1 } });
	assert.equal(m.sql, 'UPDATE `d`.`we``ird` SET `n` = ? WHERE `id` = ?');
});

test('delete and insert', () => {
	assert.equal(buildDelete('postgres', { ...t, key: { a: 1, b: 'x' } }).sql, 'DELETE FROM "public"."users" WHERE "a" = $1 AND "b" = $2');
	assert.equal(buildDelete('mysql', { ...t, key: { id: 9 } }).sql, 'DELETE FROM `public`.`users` WHERE `id` = ?');
	assert.throws(() => buildDelete('postgres', { ...t, key: {} }));
	const ins = buildInsert('postgres', { ...t, values: { name: 'x', active: true, note: null } });
	assert.equal(ins.sql, 'INSERT INTO "public"."users" ("name", "active", "note") VALUES ($1, $2, $3)');
	assert.equal(ins.display, `INSERT INTO "public"."users" ("name", "active", "note") VALUES ('x', TRUE, NULL)`);
	assert.equal(buildInsert('postgres', { ...t, values: {} }).sql, 'INSERT INTO "public"."users" DEFAULT VALUES');
	assert.equal(buildInsert('mysql', { ...t, values: {} }).sql, 'INSERT INTO `public`.`users` () VALUES ()');
});

test('select row for update', () => {
	assert.equal(buildSelectRow('postgres', { ...t, key: { id: 1 }, columns: ['f'] }).sql, 'SELECT "f" FROM "public"."users" WHERE "id" = $1 FOR UPDATE');
	assert.equal(buildSelectRow('sqlite', { ...t, key: { id: 1 }, columns: [] }).sql, 'SELECT 1 FROM "public"."users" WHERE "id" = ?');
});

test('batch insert numbering, conflict clauses and batch sizing', () => {
	const b = buildBatchInsert('postgres', { ...t, columns: ['id', 'name'], rows: [[1, 'a'], [2, null]], onConflict: 'update', key: ['id'] });
	assert.equal(b.sql, 'INSERT INTO "public"."users" ("id", "name") VALUES ($1, $2), ($3, $4) ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name"');
	assert.deepEqual(b.params, [1, 'a', 2, null]);
	assert.equal(conflictClause('postgres', { columns: ['id'], onConflict: 'skip' }), ' ON CONFLICT DO NOTHING');
	assert.equal(conflictClause('postgres', { columns: ['id'], onConflict: 'update', key: ['id'] }), ' ON CONFLICT ("id") DO NOTHING');
	assert.throws(() => conflictClause('postgres', { columns: ['a'], onConflict: 'update', key: [] }), /primary key/);
	const m = buildBatchInsert('mysql', { ...t, columns: ['id', 'name'], rows: [[1, 'a']], onConflict: 'update', key: ['id'] });
	assert.equal(m.sql, 'INSERT INTO `public`.`users` (`id`, `name`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `name` = VALUES(`name`)');
	assert.equal(conflictClause('mysql', { columns: ['id', 'n'], onConflict: 'skip', key: ['id'] }), ' ON DUPLICATE KEY UPDATE `id` = `id`');
	assert.equal(conflictClause('mysql', { columns: ['id'], onConflict: 'error' }), '');
	assert.throws(() => buildBatchInsert('postgres', { ...t, columns: ['a', 'b'], rows: [[1]] }));
	assert.equal(batchSize(3), 500);
	assert.equal(batchSize(200), 300);
	assert.equal(batchSize(100_000), 1);
	assert.match(describeBatch('postgres', { ...t, columns: ['a'], rowCount: 3, source: 'x.csv' }), /VALUES \(…\); -- 3 rows from x\.csv$/);
});

test('create table validates names and types', () => {
	const s = buildCreateTable('postgres', { ...t, columns: [{ name: 'id', type: 'bigint' }, { name: 'price', type: 'numeric(10, 2)' }, { name: 'tags', type: 'text[]' }], primaryKey: ['id'] });
	assert.equal(s.sql, 'CREATE TABLE "public"."users" (\n  "id" bigint NOT NULL,\n  "price" numeric(10, 2),\n  "tags" text[],\n  PRIMARY KEY ("id")\n)');
	assert.ok(validColumnType('double precision'));
	assert.ok(validColumnType('int unsigned'));
	assert.ok(validColumnType('timestamp with time zone'));
	assert.ok(!validColumnType('text); drop table x; --'));
	assert.ok(!validColumnType("varchar(10) default 'x'"));
	assert.throws(() => buildCreateTable('mysql', { ...t, columns: [{ name: 'a', type: 'int' }, { name: 'A', type: 'int' }] }), /Duplicate/);
	assert.throws(() => buildCreateTable('mysql', { ...t, columns: [{ name: 'a', type: 'int' }], primaryKey: ['b'] }));
});

// --- planning ----------------------------------------------------------------------

const col = (name: string, over: Partial<EditColumn> = {}): EditColumn => ({ name, type: 'text', nullable: true, default: null, editable: true, kind: 'text', compare: 'eq', ...over });
const meta = (over: Partial<TableMeta> = {}): TableMeta => ({
	dialect: 'postgres',
	schema: 'public',
	table: 'users',
	writable: true,
	key: ['id'],
	keyKind: 'primary',
	columns: [col('id', { kind: 'number', nullable: false }), col('name'), col('doc', { kind: 'json', compare: 'json' }), col('score', { kind: 'number', compare: 'none' }), col('total', { editable: false, reason: 'Generated column' }), col('active', { kind: 'boolean' })],
	...over
});

test('planChanges builds statements and validates against the table', () => {
	const planned = planChanges(meta(), [
		{ op: 'update', key: { id: 1 }, set: { name: 'b', doc: { a: 1 } }, original: { name: 'a', doc: { a: 0 } } },
		{ op: 'insert', values: { name: 'new' } },
		{ op: 'delete', key: { id: 2 } }
	]);
	assert.equal(planned.length, 3);
	assert.equal(planned[0].stmt.sql, 'UPDATE "public"."users" SET "name" = $1, "doc" = $2 WHERE "id" = $3 AND "name" IS NOT DISTINCT FROM $4 AND "doc"::jsonb IS NOT DISTINCT FROM $5::jsonb');
	assert.deepEqual(planned[0].stmt.params, ['b', '{"a":1}', 1, 'a', '{"a":0}']);
	assert.equal(planned[1].stmt.sql, 'INSERT INTO "public"."users" ("name") VALUES ($1)');
	assert.equal(planned[2].stmt.sql, 'DELETE FROM "public"."users" WHERE "id" = $1');

	assert.throws(() => planChanges(meta(), [{ op: 'update', key: { id: 1 }, set: { nope: 1 } }]), /Unknown column/);
	assert.throws(() => planChanges(meta(), [{ op: 'update', key: { id: 1 }, set: { total: 1 } }]), /can’t be changed/);
	assert.throws(() => planChanges(meta(), [{ op: 'update', key: { name: 'x' }, set: { name: 'y' } }]), /key columns/);
	assert.throws(() => planChanges(meta(), [{ op: 'delete', key: { id: null } }]), /NULL/);
	assert.throws(() => planChanges(meta({ key: [], keyKind: null }), [{ op: 'delete', key: { id: 1 } }]), /no primary key/);
	assert.doesNotThrow(() => planChanges(meta({ key: [], keyKind: null }), [{ op: 'insert', values: { name: 'ok' } }]));
	assert.throws(() => planChanges(meta({ writable: false, reason: 'view' }), [{ op: 'insert', values: {} }]), /view/);
	assert.throws(() => planChanges(meta(), []), /No changes/);
	assert.throws(() => planChanges(meta(), [{ op: 'truncate' }]), /Unknown change/);
	assert.throws(() => planChanges(meta(), [{ op: 'update', key: { id: 1 }, set: { name: { evil: 1 } } }]), /expected text/);
});

test('uncomparable edited columns get a read-and-compare precheck', () => {
	const [p] = planChanges(meta(), [{ op: 'update', key: { id: 1 }, set: { score: '2.5' }, original: { score: 1.5 } }]);
	assert.equal(p.stmt.sql, 'UPDATE "public"."users" SET "score" = $1 WHERE "id" = $2');
	assert.equal(p.precheck?.stmt.sql, 'SELECT "score" FROM "public"."users" WHERE "id" = $1 FOR UPDATE');
	assert.deepEqual(p.precheck?.expected, [1.5]);
});

test('toParam converts per engine', () => {
	assert.equal(toParam('mysql', col('b', { kind: 'boolean' }), true), 1);
	assert.equal(toParam('mysql', col('b', { kind: 'boolean' }), 'false'), 0);
	assert.equal(toParam('postgres', col('b', { kind: 'boolean' }), false), false);
	assert.equal(toParam('mysql', col('j', { kind: 'json' }), [1, 'a']), '[1,"a"]');
	assert.equal(toParam('postgres', col('j', { kind: 'json' }), 'str'), '"str"');
	assert.equal(toParam('mysql', col('f', { type: 'bit(8)', kind: 'number' }), '5'), 5);
	assert.equal(toParam('postgres', col('x'), null), null);
	assert.throws(() => toParam('postgres', col('x'), NaN));
});

test('sameValue compares like the browser sees values', () => {
	assert.ok(sameValue({ a: 1 }, { a: 1 }));
	assert.ok(sameValue(null, undefined));
	assert.ok(!sameValue('1', 1));
});

test('chooseKey prefers the primary key, then the narrowest NOT NULL unique key', () => {
	assert.deepEqual(chooseKey([{ primary: false, columns: ['a'] }, { primary: true, columns: ['id'] }], () => true), { key: ['id'], keyKind: 'primary' });
	const notNull = (c: string) => c !== 'maybe';
	assert.deepEqual(chooseKey([{ primary: false, columns: ['x', 'y'] }, { primary: false, columns: ['maybe'] }, { primary: false, columns: ['z'] }], notNull), { key: ['z'], keyKind: 'unique' });
	assert.deepEqual(chooseKey([{ primary: false, columns: ['maybe'] }], notNull), { key: [], keyKind: null });
});

/** A fake transaction: answers by statement prefix and records what ran. */
function fakeTx(answers: (sql: string, params: unknown[]) => { rowCount: number; rows?: unknown[][] } | Error): Tx & { log: string[] } {
	const log: string[] = [];
	return {
		dialect: 'postgres',
		log,
		async run(sql, params = []) {
			log.push(sql);
			const a = answers(sql, params);
			if (a instanceof Error) throw a;
			return { rowCount: a.rowCount, rows: a.rows ?? [] };
		}
	};
}
const serverErr = (msg: string) => Object.assign(new Error(msg), { code: '23505' });
const isServerError = (e: unknown) => !!e && typeof e === 'object' && 'code' in e;
const errorText = (e: unknown) => (e as Error).message;

test('applyPlanned: every statement must hit exactly one row', async () => {
	const planned = planChanges(meta(), [
		{ op: 'update', key: { id: 1 }, set: { name: 'b' }, original: { name: 'a' } },
		{ op: 'delete', key: { id: 2 } }
	]);
	const ok = await applyPlanned(fakeTx(() => ({ rowCount: 1 })), meta(), planned, isServerError, errorText);
	assert.deepEqual(ok, { commit: true, counts: { updated: 1, inserted: 0, deleted: 1 } });

	// The UPDATE matched nothing, but the row is still there: someone changed it.
	const conflict = await applyPlanned(
		fakeTx((sql) => (sql.startsWith('UPDATE') ? { rowCount: 0 } : { rowCount: 1, rows: [[1]] })),
		meta(),
		planned,
		isServerError,
		errorText
	);
	assert.equal(conflict.commit, false);
	assert.equal(conflict.failed?.index, 0);
	assert.equal(conflict.failed?.conflict, true);
	assert.match(conflict.failed!.reason, /changed the row \(id = 1\)/);

	const gone = await applyPlanned(fakeTx((sql) => (sql.startsWith('DELETE') ? { rowCount: 0 } : sql.startsWith('SELECT') ? { rowCount: 0 } : { rowCount: 1 })), meta(), planned, isServerError, errorText);
	assert.equal(gone.failed?.index, 1);
	assert.match(gone.failed!.reason, /no longer exists/);

	const dbError = await applyPlanned(fakeTx(() => serverErr('duplicate key')), meta(), planned, isServerError, errorText);
	assert.deepEqual(dbError.failed, { index: 0, op: 'update', key: { id: 1 }, reason: 'duplicate key', conflict: false });

	await assert.rejects(applyPlanned(fakeTx(() => new Error('socket hang up')), meta(), planned, isServerError, errorText), /socket/);
});

test('applyPlanned: precheck catches concurrent changes of uncomparable columns', async () => {
	const planned = planChanges(meta(), [{ op: 'update', key: { id: 1 }, set: { score: '2' }, original: { score: 1.5 } }]);
	const changed = await applyPlanned(fakeTx((sql) => (sql.startsWith('SELECT') ? { rowCount: 1, rows: [[1.75]] } : { rowCount: 1 })), meta(), planned, isServerError, errorText);
	assert.match(changed.failed!.reason, /changed score/);
	const same = await applyPlanned(fakeTx((sql) => (sql.startsWith('SELECT') ? { rowCount: 1, rows: [[1.5]] } : { rowCount: 1 })), meta(), planned, isServerError, errorText);
	assert.equal(same.commit, true);
});

// --- import --------------------------------------------------------------------------

test('import options and field values', () => {
	assert.throws(() => parseImportOptions({ schema: 's', table: 't', mapping: [null] }), /at least one/);
	assert.throws(() => parseImportOptions({ schema: 's', table: 't', mapping: ['a'], delimiter: '"' }), /delimiter/);
	assert.throws(() => parseImportOptions({ schema: 's', table: 't', mapping: ['a'], onConflict: 'replace' }), /onConflict/);
	const o = parseImportOptions({ schema: 's', table: 't', mapping: ['a', '', 'b'] });
	assert.deepEqual(o.mapping, ['a', null, 'b']);
	assert.equal(o.emptyAsNull, true);
	assert.equal(o.header, true);
	assert.equal(fieldValue('postgres', '', { emptyAsNull: true }), null);
	assert.equal(fieldValue('postgres', '', { emptyAsNull: false }), '');
	assert.equal(fieldValue('mysql', 'yes', { emptyAsNull: true, boolean: true }), 1);
	assert.equal(fieldValue('postgres', 'yes', { emptyAsNull: true, boolean: true }), 'yes');
	const create = createStatement('postgres', parseImportOptions({ schema: 's', table: 'n', mapping: ['a', null], create: { columns: [{ name: 'a', type: 'int' }] } }));
	assert.equal(create?.sql, 'CREATE TABLE "s"."n" (\n  "a" int\n)');
	assert.throws(() => createStatement('postgres', parseImportOptions({ schema: 's', table: 'n', mapping: ['a'], create: { columns: [{ name: 'b', type: 'int' }] } })), /match/);
});

test('importRows batches, numbers failing rows and reports field-count errors', async () => {
	const csv = 'id,name\n1,a\n2,"b, with comma"\n3,\n';
	const opts = parseImportOptions({ schema: 's', table: 't', mapping: ['id', 'name'] });
	const ctx = { key: ['id'], booleanColumns: new Set<string>(), isServerError, errorText, source: 'x.csv' };
	const params: unknown[][] = [];
	const ok = await importRows(fakeTx((sql, p) => (sql.startsWith('INSERT') ? (params.push(p), { rowCount: 3 }) : { rowCount: 0 })), csv, opts, ctx);
	assert.equal(ok.commit, true);
	assert.equal(ok.rows, 3);
	assert.deepEqual(params[0], ['1', 'a', '2', 'b, with comma', '3', null]);

	// Row 2 violates a constraint: the batch fails, then rows are retried one by one.
	const tx = fakeTx((sql, p) => (sql.startsWith('INSERT') && (p.length > 2 || p[0] === '2') ? serverErr('bad row') : { rowCount: 1 }));
	const bad = await importRows(tx, csv, opts, ctx);
	assert.equal(bad.commit, false);
	assert.deepEqual(bad.failed, { row: 2, line: 3, message: 'bad row' });
	assert.ok(tx.log.includes('ROLLBACK TO SAVEPOINT pgm_import'));

	const short = await importRows(fakeTx(() => ({ rowCount: 1 })), 'id,name\n1,a\n2\n', opts, ctx);
	assert.deepEqual(short.failed, { row: 2, line: 3, message: 'Expected 2 fields, found 1' });

	const unterminated = await importRows(fakeTx(() => ({ rowCount: 1 })), 'id,name\n1,"open\n', opts, ctx);
	assert.equal(unterminated.failed?.line, 2);

	const truncate = fakeTx((sql) => ({ rowCount: sql.startsWith('DELETE') ? 5 : 3 }));
	const t2 = await importRows(truncate, csv, { ...opts, truncate: true }, ctx);
	assert.equal(t2.deleted, 5);
	assert.equal(truncate.log[0], 'DELETE FROM "s"."t"');
});
