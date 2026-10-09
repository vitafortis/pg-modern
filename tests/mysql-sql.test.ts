import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitRanges, statementAt, usesDelimiter } from '../src/lib/sql-split.ts';
import { changesSession, isDestructiveMysql, normalize, readOnlyProblem, useTarget } from '../src/lib/server/mysql/classify.ts';

const split = (sql: string) => splitRanges(sql, 'mysql').map((r) => r.text);

test('mysql split: backticks, backslash escapes and # / -- comments', () => {
	assert.deepEqual(split("select 'a;b\\';c'; select `q;r`; select \"x;y\""), ["select 'a;b\\';c'", 'select `q;r`', 'select "x;y"']);
	assert.deepEqual(split('select 1; # one;two\nselect 2 -- three;\n;'), ['select 1', '# one;two\nselect 2 -- three;']);
	// `--` without a following space is an operator, not a comment.
	assert.deepEqual(split('select 1--2; select 3'), ['select 1--2', 'select 3']);
	// No dollar quoting in MySQL.
	assert.deepEqual(split('select $a$; select 2'), ['select $a$', 'select 2']);
});

test('mysql split: DELIMITER blocks keep procedure bodies together', () => {
	const sql = 'select 1;\nDELIMITER //\nCREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET NEW.a = 1; SET NEW.b = 2; END//\nDELIMITER ;\nselect 2;';
	assert.deepEqual(split(sql), ['select 1', 'CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET NEW.a = 1; SET NEW.b = 2; END', 'select 2']);
	assert.ok(usesDelimiter(sql));
	assert.ok(!usesDelimiter('select 1'));
	// The editor finds statements by offset the same way.
	assert.equal(statementAt(sql, sql.indexOf('NEW.b'), 'mysql')?.text.startsWith('CREATE TRIGGER'), true);
});

test('postgres split is unchanged by default', () => {
	assert.deepEqual(splitRanges("select $x$ a;b $x$; select '#;'").map((r) => r.text), ["select $x$ a;b $x$", "select '#;'"]);
});

test('normalize hides literals and keeps executable comments', () => {
	assert.equal(normalize("SELECT 'into outfile' AS `update` -- drop\nFROM t"), "select 'str' as `id` from t");
	assert.equal(normalize('SELECT 1 /*! INTO OUTFILE "/tmp/x" */'), "select 1 into outfile 'str'");
	assert.equal(normalize('SELECT /*+ MAX_EXECUTION_TIME(1) */ 1'), 'select 1');
});

test('read-only allowlist accepts reads', () => {
	for (const s of [
		'SELECT 1',
		'select * from `shop`.`orders` where note = "delete me" and id in (select id from x)',
		'WITH a AS (SELECT 1) SELECT * FROM a',
		'(SELECT 1) UNION (SELECT 2)',
		'TABLE orders',
		'VALUES ROW(1, 2)',
		'SHOW TABLES',
		'show full processlist',
		'DESCRIBE orders',
		'desc shop.orders',
		'EXPLAIN SELECT * FROM t',
		'EXPLAIN FORMAT=JSON SELECT * FROM t',
		'explain analyze select 1',
		'EXPLAIN orders',
		'HELP "select"',
		'USE shop',
		'use `my db`',
		"select insert('abc', 1, 1, 'x'), replace('a', 'a', 'b')",
		'SELECT SLEEP(1), GET_LOCK("x", 1)',
		'-- comment\nselect 1',
		'# comment\nselect 1'
	]) {
		assert.equal(readOnlyProblem(s), null, s);
	}
});

test('read-only allowlist blocks writes, DDL, files, locks and session changes', () => {
	for (const s of [
		'INSERT INTO t VALUES (1)',
		'update t set a = 1',
		'DELETE FROM t',
		'REPLACE INTO t VALUES (1)',
		'CREATE TABLE x (id int)',
		'DROP TABLE t',
		'ALTER TABLE t ADD c int',
		'TRUNCATE t',
		'RENAME TABLE a TO b',
		"SELECT * FROM t INTO OUTFILE '/tmp/x'",
		"SELECT * INTO DUMPFILE '/tmp/x' FROM t",
		'SELECT 1 INTO @x',
		'SELECT 1 /*! INTO OUTFILE "/tmp/x" */',
		'SELECT * FROM t FOR UPDATE',
		'select * from t lock in share mode',
		'SET SESSION transaction_read_only = OFF',
		'set @a = 1',
		'SET autocommit = 1',
		'LOCK TABLES t WRITE',
		'UNLOCK TABLES',
		'COMMIT',
		'START TRANSACTION',
		'BEGIN',
		'ROLLBACK',
		'XA START "x"',
		'CALL p()',
		'HANDLER t OPEN',
		"LOAD DATA INFILE '/tmp/x' INTO TABLE t",
		'DO SLEEP(1)',
		'KILL 12',
		'GRANT ALL ON *.* TO x',
		'FLUSH PRIVILEGES',
		'PREPARE s FROM "delete from t"',
		'WITH a AS (SELECT 1) DELETE FROM t',
		'WITH a AS (SELECT 1) UPDATE t SET x = 1',
		'EXPLAIN DELETE FROM t',
		'EXPLAIN ANALYZE UPDATE t SET a = 1',
		'ANALYZE TABLE t',
		'OPTIMIZE TABLE t',
		'USE a; DROP TABLE t'
	]) {
		assert.notEqual(readOnlyProblem(s), null, s);
	}
});

test('USE target and session-changing statements', () => {
	assert.equal(useTarget('USE shop'), 'shop');
	assert.equal(useTarget('use `odd``name`;'), 'odd`name');
	assert.equal(useTarget('select 1'), null);
	assert.ok(changesSession('SET @a = 1'));
	assert.ok(changesSession('LOCK TABLES t READ'));
	assert.ok(changesSession('CREATE TEMPORARY TABLE x (id int)'));
	assert.ok(changesSession('START TRANSACTION'));
	assert.ok(!changesSession('select * from t'));
	assert.ok(!changesSession('insert into t values (1)'));
});

test('destructive statements in MySQL syntax', () => {
	for (const s of ['DROP TABLE t', 'drop database shop', 'TRUNCATE TABLE t', 'DELETE FROM t', 'UPDATE t SET a = 1', 'ALTER TABLE t DROP COLUMN c', 'alter table `t` drop index i', '# hi\nDELETE FROM t']) {
		assert.ok(isDestructiveMysql(s), s);
	}
	for (const s of ['DELETE FROM t WHERE id = 1', "UPDATE t SET a = 'drop' WHERE id = 2", 'ALTER TABLE t ADD c int', 'select 1', "insert into t values ('drop table x')"]) {
		assert.ok(!isDestructiveMysql(s), s);
	}
});
