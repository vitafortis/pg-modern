import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitRanges, statementAt } from '../src/lib/sql-split.ts';
import { escapesReadOnly, returnsRows } from '../src/lib/server/sql.ts';

test('splits statements, respecting quotes, dollar bodies and comments', () => {
	const sql = `select 'a;b'; -- c;d
select $x$ e;f $x$; /* g; /* nested; */ h; */ select "i;j"`;
	assert.deepEqual(
		splitRanges(sql).map((r) => r.text),
		["select 'a;b'", '-- c;d\nselect $x$ e;f $x$', '/* g; /* nested; */ h; */ select "i;j"']
	);
});

test('drops comment-only statements', () => {
	assert.deepEqual(splitRanges('select 1; -- trailing\n;  ;').map((r) => r.text), ['select 1']);
});

test('finds the statement under the cursor', () => {
	const sql = 'select 1;\n\nselect 2;';
	assert.equal(statementAt(sql, 2)?.text, 'select 1');
	assert.equal(statementAt(sql, sql.length)?.text, 'select 2');
});

test('flags statements that would escape a read-only transaction', () => {
	for (const s of ['COMMIT', 'end', 'rollback', 'begin', 'set transaction read write', 'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE', 'set default_transaction_read_only = off', 'set local transaction_read_only to off', 'reset all', 'set role postgres', '/* x */ commit']) {
		assert.ok(escapesReadOnly(s), s);
	}
	for (const s of ['select 1', 'set search_path = public', 'with x as (select 1) select * from x', 'show all']) {
		assert.ok(!escapesReadOnly(s), s);
	}
});

test('detects row-returning statements', () => {
	assert.ok(returnsRows('-- hi\nSELECT 1'));
	assert.ok(returnsRows('insert into t values (1) returning id'));
	assert.ok(!returnsRows('vacuum'));
});
