import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import {
	canPrehash,
	mysqlAccount,
	mysqlGrantDatabase,
	mysqlIdent,
	mysqlLiteral,
	mysqlReadOnlyUserSql,
	pgIdent,
	pgLiteral,
	pgReadOnlyUserSql,
	renderScript,
	scramSha256Verifier,
	validateMysql,
	validatePg,
	type PgReadOnlyOptions
} from '../src/lib/server/readonly-user.ts';
import { PASSWORD_ALPHABET, generatePassword } from '../src/lib/password.ts';

const pgBase: PgReadOnlyOptions = {
	role: 'pgmodern_ro',
	password: 'secret',
	database: 'app',
	mode: 'schemas',
	schemas: [{ name: 'public', owners: ['app_owner'] }],
	defaultPrivileges: true,
	monitor: false,
	readAllStats: false,
	prehash: false
};

test('pgIdent quotes and doubles embedded quotes', () => {
	assert.equal(pgIdent('ro'), '"ro"');
	assert.equal(pgIdent('Mixed Case'), '"Mixed Case"');
	assert.equal(pgIdent('a"b'), '"a""b"');
	assert.equal(pgIdent('x"; DROP ROLE postgres; --'), '"x""; DROP ROLE postgres; --"');
});

test('pgLiteral doubles quotes and handles backslashes regardless of standard_conforming_strings', () => {
	assert.equal(pgLiteral('plain'), "'plain'");
	assert.equal(pgLiteral("it's"), "'it''s'");
	assert.equal(pgLiteral("'; DROP TABLE x; --"), "'''; DROP TABLE x; --'");
	assert.equal(pgLiteral('back\\slash'), "E'back\\\\slash'");
	assert.equal(pgLiteral("a\\'b"), "E'a\\\\''b'");
	assert.equal(pgLiteral('ünïcødé'), "'ünïcødé'");
	assert.throws(() => pgLiteral('nul\0byte'));
});

test('mysql quoting: identifiers, literals in both sql_modes, accounts', () => {
	assert.equal(mysqlIdent('db'), '`db`');
	assert.equal(mysqlIdent('we`ird'), '`we``ird`');
	assert.equal(mysqlLiteral("it's"), "'it''s'");
	assert.equal(mysqlLiteral('a\\b'), "'a\\\\b'");
	assert.equal(mysqlLiteral('a\\b', true), "'a\\b'");
	assert.equal(mysqlLiteral("\\'; DROP USER root; --"), "'\\\\''; DROP USER root; --'");
	assert.equal(mysqlLiteral("\\'", true), "'\\'''");
	assert.equal(mysqlAccount('ro', '%'), "'ro'@'%'");
	assert.equal(mysqlAccount("o'neil", '10.0.%'), "'o''neil'@'10.0.%'");
	assert.throws(() => mysqlLiteral('x\0'));
});

test('mysqlGrantDatabase escapes GRANT wildcards so names match literally', () => {
	assert.equal(mysqlGrantDatabase('shop'), '`shop`');
	assert.equal(mysqlGrantDatabase('my_app'), '`my\\_app`');
	assert.equal(mysqlGrantDatabase('100%'), '`100\\%`');
	assert.equal(mysqlGrantDatabase('a`b_c'), '`a``b\\_c`');
	assert.equal(mysqlGrantDatabase('back\\slash'), '`back\\\\slash`');
});

test('Postgres script: role, connect, per-schema grants and default privileges per owner', () => {
	const sql = pgReadOnlyUserSql({ ...pgBase, schemas: [{ name: 'public', owners: ['app_owner', 'migrator', 'pg_database_owner'] }, { name: 'Sales', owners: [] }] }).map((s) => s.sql);
	assert.equal(sql[0], `CREATE ROLE "pgmodern_ro" WITH LOGIN PASSWORD 'secret' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
	assert.ok(sql.includes(`ALTER ROLE "pgmodern_ro" SET default_transaction_read_only = on`));
	assert.ok(sql.includes(`GRANT CONNECT ON DATABASE "app" TO "pgmodern_ro"`));
	assert.ok(sql.includes(`GRANT USAGE ON SCHEMA "public" TO "pgmodern_ro"`));
	assert.ok(sql.includes(`GRANT SELECT ON ALL TABLES IN SCHEMA "Sales" TO "pgmodern_ro"`));
	assert.ok(sql.includes(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA "public" TO "pgmodern_ro"`));
	assert.ok(sql.includes(`ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" IN SCHEMA "public" GRANT SELECT ON TABLES TO "pgmodern_ro"`));
	assert.ok(sql.includes(`ALTER DEFAULT PRIVILEGES FOR ROLE "migrator" IN SCHEMA "public" GRANT SELECT ON SEQUENCES TO "pgmodern_ro"`));
	assert.ok(!sql.some((s) => s.includes('pg_database_owner')), 'predefined roles are skipped');
	assert.ok(!sql.some((s) => /pg_monitor|pg_read_all/.test(s)));
	assert.ok(!sql.some((s) => /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALL PRIVILEGES)\b/.test(s)));
});

test('Postgres script options: monitoring roles, pg_read_all_data, no default privileges', () => {
	const mon = pgReadOnlyUserSql({ ...pgBase, monitor: true, readAllStats: true }).map((s) => s.sql);
	assert.ok(mon.includes('GRANT pg_monitor TO "pgmodern_ro"'));
	assert.ok(!mon.includes('GRANT pg_read_all_stats TO "pgmodern_ro"'), 'pg_monitor already includes it');
	const stats = pgReadOnlyUserSql({ ...pgBase, readAllStats: true }).map((s) => s.sql);
	assert.ok(stats.includes('GRANT pg_read_all_stats TO "pgmodern_ro"'));
	const all = pgReadOnlyUserSql({ ...pgBase, mode: 'read_all_data', schemas: [] }).map((s) => s.sql);
	assert.ok(all.includes('GRANT pg_read_all_data TO "pgmodern_ro"'));
	assert.ok(!all.some((s) => s.includes('SCHEMA')));
	const noDefaults = pgReadOnlyUserSql({ ...pgBase, defaultPrivileges: false }).map((s) => s.sql);
	assert.ok(!noDefaults.some((s) => s.includes('DEFAULT PRIVILEGES')));
});

test('Postgres script quotes hostile role, schema, owner and password values', () => {
	const stmts = pgReadOnlyUserSql({
		...pgBase,
		role: 'evil"; DROP DATABASE app; --',
		password: "pa'ss\\word",
		database: 'my"db',
		schemas: [{ name: 'sch"ema', owners: ['own"er'] }]
	});
	const sql = stmts.map((s) => s.sql);
	assert.equal(sql[0], `CREATE ROLE "evil""; DROP DATABASE app; --" WITH LOGIN PASSWORD E'pa''ss\\\\word' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
	assert.ok(sql.includes(`GRANT CONNECT ON DATABASE "my""db" TO "evil""; DROP DATABASE app; --"`));
	assert.ok(sql.includes(`ALTER DEFAULT PRIVILEGES FOR ROLE "own""er" IN SCHEMA "sch""ema" GRANT SELECT ON TABLES TO "evil""; DROP DATABASE app; --"`));
});

test('Postgres: the password is masked in display text and can be sent as a SCRAM verifier', () => {
	const plain = pgReadOnlyUserSql({ ...pgBase, password: 'hunter2hunter2' });
	assert.ok(plain[0].sql.includes("'hunter2hunter2'"));
	assert.ok(!plain[0].display.includes('hunter2'));
	assert.ok(plain[0].display.includes("PASSWORD '********'"));
	const hashed = pgReadOnlyUserSql({ ...pgBase, password: 'hunter2hunter2', prehash: true });
	assert.ok(!hashed[0].sql.includes('hunter2'));
	assert.match(hashed[0].sql, /PASSWORD 'SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+'/);
	// Non-ASCII passwords would need SASLprep; fall back to sending them as written.
	const unicode = pgReadOnlyUserSql({ ...pgBase, password: 'pässwörd', prehash: true });
	assert.ok(unicode[0].sql.includes("'pässwörd'"));
});

test('scramSha256Verifier follows RFC 7677 / Postgres format', () => {
	const salt = Buffer.from('0123456789abcdef');
	const v = scramSha256Verifier('pencil', salt, 4096);
	const salted = pbkdf2Sync('pencil', salt, 4096, 32, 'sha256');
	const stored = createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest('base64');
	const server = createHmac('sha256', salted).update('Server Key').digest('base64');
	assert.equal(v, `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`);
	assert.notEqual(scramSha256Verifier('pencil'), scramSha256Verifier('pencil'), 'random salt each time');
	assert.ok(canPrehash('Abc 123 !~'));
	assert.ok(!canPrehash('é'));
	assert.ok(!canPrehash(''));
});

test('validatePg rejects bad input', () => {
	assert.equal(validatePg(pgBase), null);
	assert.match(validatePg({ ...pgBase, role: '  ' })!, /role name/);
	assert.match(validatePg({ ...pgBase, role: 'pg_reader' })!, /reserved/);
	assert.match(validatePg({ ...pgBase, role: 'x'.repeat(64) })!, /63/);
	assert.match(validatePg({ ...pgBase, password: '' })!, /password/);
	assert.match(validatePg({ ...pgBase, schemas: [] })!, /schema/);
	assert.equal(validatePg({ ...pgBase, schemas: [], mode: 'read_all_data' }), null);
	assert.throws(() => pgReadOnlyUserSql({ ...pgBase, role: '' }));
});

test('MySQL script: user, per-database SELECT/SHOW VIEW, optional PROCESS and performance_schema', () => {
	const stmts = mysqlReadOnlyUserSql({ user: 'pgmodern_ro', host: '%', password: 'secret', databases: ['shop', 'my_app'], process: true, performanceSchema: true });
	const sql = stmts.map((s) => s.sql);
	assert.deepEqual(sql, [
		"CREATE USER 'pgmodern_ro'@'%' IDENTIFIED BY 'secret'",
		"GRANT SELECT, SHOW VIEW ON `shop`.* TO 'pgmodern_ro'@'%'",
		"GRANT SELECT, SHOW VIEW ON `my\\_app`.* TO 'pgmodern_ro'@'%'",
		"GRANT PROCESS ON *.* TO 'pgmodern_ro'@'%'",
		"GRANT SELECT ON `performance\\_schema`.* TO 'pgmodern_ro'@'%'"
	]);
	assert.equal(stmts[0].display, "CREATE USER 'pgmodern_ro'@'%' IDENTIFIED BY '********'");
	const all = mysqlReadOnlyUserSql({ user: 'ro', host: '10.0.0.%', password: 'p', databases: '*', process: false, performanceSchema: false }).map((s) => s.sql);
	assert.deepEqual(all, ["CREATE USER 'ro'@'10.0.0.%' IDENTIFIED BY 'p'", "GRANT SELECT, SHOW VIEW ON *.* TO 'ro'@'10.0.0.%'"]);
});

test('MySQL script quotes hostile names and passwords for the server’s sql_mode', () => {
	const opts = { user: "x'@'%' IDENTIFIED BY 'y'; --", host: '%', password: "p'w\\", databases: ['d`b'], process: false, performanceSchema: false };
	const def = mysqlReadOnlyUserSql(opts).map((s) => s.sql);
	assert.equal(def[0], "CREATE USER 'x''@''%'' IDENTIFIED BY ''y''; --'@'%' IDENTIFIED BY 'p''w\\\\'");
	assert.equal(def[1], "GRANT SELECT, SHOW VIEW ON `d``b`.* TO 'x''@''%'' IDENTIFIED BY ''y''; --'@'%'");
	const nbe = mysqlReadOnlyUserSql({ ...opts, user: 'ro', noBackslashEscapes: true }).map((s) => s.sql);
	assert.equal(nbe[0], "CREATE USER 'ro'@'%' IDENTIFIED BY 'p''w\\'");
});

test('validateMysql rejects bad input', () => {
	const base = { user: 'ro', host: '%', password: 'p', databases: ['a'], process: false, performanceSchema: false };
	assert.equal(validateMysql(base), null);
	assert.match(validateMysql({ ...base, user: 'x'.repeat(33) })!, /32/);
	assert.match(validateMysql({ ...base, host: '' })!, /host/);
	assert.match(validateMysql({ ...base, databases: [] })!, /database/);
	assert.equal(validateMysql({ ...base, databases: '*' }), null);
	assert.match(validateMysql({ ...base, password: '' })!, /password/i);
});

test('renderScript: comments, optional transaction, redaction', () => {
	const stmts = pgReadOnlyUserSql({ ...pgBase, password: 'topsecret' });
	const full = renderScript(stmts, { transaction: true, header: 'Hello' });
	assert.ok(full.startsWith('-- Hello\n\nBEGIN;\n'));
	assert.ok(full.trimEnd().endsWith('COMMIT;'));
	assert.ok(full.includes("'topsecret'"));
	assert.ok(full.split('\n').some((l) => l.startsWith('-- A login role')));
	const redacted = renderScript(stmts, { redact: true });
	assert.ok(!redacted.includes('topsecret'));
	assert.ok(!redacted.includes('BEGIN'));
	assert.equal(redacted.split('\n').filter((l) => l.endsWith(';')).length, stmts.length);
});

test('generatePassword: length, alphabet, no quoting hazards, randomness', () => {
	const seen = new Set<string>();
	for (let i = 0; i < 200; i++) {
		const p = generatePassword();
		assert.equal(p.length, 28);
		assert.ok([...p].every((c) => PASSWORD_ALPHABET.includes(c)));
		seen.add(p);
	}
	assert.equal(seen.size, 200);
	assert.equal(generatePassword(8).length, 8);
	assert.ok(!/['"\\`$%_ ]/.test(PASSWORD_ALPHABET));
});
