import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactGrant, summarizeGrants } from '../src/lib/server/mysql/introspect.ts';
import { fieldTypeName, serializeValue } from '../src/lib/server/mysql/client.ts';
import type { FieldPacket } from 'mysql2';

test('grants never carry password hashes to the browser', () => {
	assert.equal(
		redactGrant("GRANT ALL PRIVILEGES ON *.* TO `root`@`%` IDENTIFIED BY PASSWORD '*79D0CF9A6A052105DA1E1181406C34FC87AAC89D' WITH GRANT OPTION"),
		'GRANT ALL PRIVILEGES ON *.* TO `root`@`%` WITH GRANT OPTION'
	);
	assert.equal(redactGrant("GRANT USAGE ON *.* TO `x`@`%` IDENTIFIED VIA ed25519 USING 'abc'"), 'GRANT USAGE ON *.* TO `x`@`%`');
	assert.equal(redactGrant('GRANT SELECT ON `shop`.* TO `ro`@`%`'), 'GRANT SELECT ON `shop`.* TO `ro`@`%`');
});

test('grant summary: admin, writer, read-only', () => {
	const root = summarizeGrants(['GRANT ALL PRIVILEGES ON *.* TO `root`@`%` WITH GRANT OPTION']);
	assert.ok(root.superuser && root.canWrite && root.process);
	const app = summarizeGrants(['GRANT USAGE ON *.* TO `shop`@`%`', 'GRANT ALL PRIVILEGES ON `shop`.* TO `shop`@`%`']);
	assert.ok(!app.superuser && app.canWrite && !app.process);
	const ro = summarizeGrants(['GRANT USAGE ON *.* TO `ro`@`%`', 'GRANT SELECT, SHOW VIEW ON `shop`.* TO `ro`@`%`']);
	assert.ok(!ro.superuser && !ro.canWrite && !ro.canCreate);
	const ops = summarizeGrants(['GRANT PROCESS, CONNECTION_ADMIN ON *.* TO `ops`@`%`']);
	assert.ok(ops.process && ops.connectionAdmin && !ops.superuser);
});

test('result column type names and JSON-safe values', () => {
	const f = (columnType: number, extra: Partial<FieldPacket> = {}) => fieldTypeName({ columnType, flags: 0, characterSet: 45, ...extra } as FieldPacket);
	assert.equal(f(253), 'varchar');
	assert.equal(f(253, { characterSet: 63 }), 'varbinary');
	assert.equal(f(252, { columnLength: 65535, characterSet: 63 }), 'blob');
	assert.equal(f(252, { columnLength: 4294967295 }), 'longtext');
	assert.equal(f(3, { flags: 32 }), 'int unsigned');
	assert.equal(f(8), 'bigint');
	assert.equal(f(246), 'decimal');
	assert.equal(f(245), 'json');
	assert.equal(f(254, { flags: 256 }), 'enum');
	assert.equal(f(12), 'datetime');
	assert.equal(f(252, { extendedFormat: 'json' }), 'json');
	assert.equal(serializeValue(Buffer.from([0xde, 0xad])), '0xdead');
	assert.equal(serializeValue(12n), '12');
	assert.deepEqual(serializeValue({ a: 1 }), { a: 1 });
});
