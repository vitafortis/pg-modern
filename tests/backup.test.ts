import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupFilename, decodeBackup, encodeBackup, parseEnvelope, WRONG_PASSPHRASE } from '../src/lib/server/backup.ts';

const FAST = { N: 1024, r: 8, p: 1, appVersion: '1.2.3' };
const PASS = 'a long enough passphrase';

test('roundtrip: encode then decode returns the payload', async () => {
	const payload = { connections: [{ id: 'c1', password: 'pw' }], n: 1 };
	const env = await encodeBackup(payload, PASS, FAST);
	assert.equal(env.format, 'pg-modern-backup');
	assert.equal(env.version, 1);
	assert.equal(env.cipher, 'aes-256-gcm');
	assert.equal(env.kdf.name, 'scrypt');
	assert.equal(env.appVersion, '1.2.3');
	assert.ok(!JSON.stringify(env).includes('"pw"'), 'payload is not in the clear');
	const { payload: back } = await decodeBackup(JSON.stringify(env), PASS);
	assert.deepEqual(back, payload);
});

test('short passphrases are refused', async () => {
	await assert.rejects(encodeBackup({}, 'short', FAST), /at least 12/);
});

test('wrong passphrase is a clear error', async () => {
	const env = await encodeBackup({ a: 1 }, PASS, FAST);
	await assert.rejects(decodeBackup(env, 'not the passphrase'), { message: WRONG_PASSPHRASE });
});

test('tampered ciphertext, tag or header fails', async () => {
	const env = await encodeBackup({ a: 'some data to flip' }, PASS, FAST);
	const data = Buffer.from(env.data, 'base64');
	data[0] ^= 1;
	await assert.rejects(decodeBackup({ ...env, data: data.toString('base64') }, PASS), { message: WRONG_PASSPHRASE });
	const tag = Buffer.from(env.tag, 'base64');
	tag[3] ^= 1;
	await assert.rejects(decodeBackup({ ...env, tag: tag.toString('base64') }, PASS), { message: WRONG_PASSPHRASE });
	await assert.rejects(decodeBackup({ ...env, createdAt: '2000-01-01T00:00:00.000Z' }, PASS), { message: WRONG_PASSPHRASE });
});

test('non-backups and absurd scrypt costs are rejected before decrypting', () => {
	assert.throws(() => parseEnvelope('{"hello":1}'), /Not a pg·modern backup/);
	assert.throws(() => parseEnvelope('nope'), /Not a pg·modern backup/);
	assert.throws(
		() => parseEnvelope({ format: 'pg-modern-backup', version: 1, createdAt: '', appVersion: '', cipher: 'aes-256-gcm', iv: '', tag: '', data: '', kdf: { name: 'scrypt', N: 1 << 20, r: 32, p: 1, salt: '' } }),
		/Damaged/
	);
});

test('filename is dated', () => {
	assert.equal(backupFilename(new Date('2026-10-08T12:00:00Z')), 'pg-modern-backup-2026-10-08.pgmbackup');
});

test('store export restores on a fresh install with a different master key', () => {
	const helper = join(import.meta.dirname, 'helpers', 'backup-store.ts');
	const file = join(mkdtempSync(join(tmpdir(), 'pgm-backup-file-')), 'b.pgmbackup');
	const run = (role: string, key: string) =>
		execFileSync(process.execPath, ['--no-warnings', '--experimental-strip-types', helper, role, mkdtempSync(join(tmpdir(), `pgm-backup-${role}-`)), key, file], {
			encoding: 'utf8'
		});
	run('export', 'master-key-one');
	const out = JSON.parse(run('import', 'master-key-two'));

	assert.deepEqual(out.preview.connections.map((c: { status: string }) => c.status), ['new', 'new']);
	assert.equal(out.preview.users.find((u: { email: string }) => u.email === 'admin@x.io').status, 'self');

	assert.match(out.zeroAdminError, /no enabled admin/);
	assert.equal(out.afterRollback, 0, 'failed restore is rolled back');

	// Passwords were re-sealed with the new install's key.
	assert.deepEqual(out.passwords, { app: 's3cret-app', nopw: null });
	assert.deepEqual(out.result.connections, { added: 2, updated: 0 });
	assert.deepEqual(out.result.users, { added: 2, updated: 0, skipped: 1 });

	// The signed-in admin is untouched even though the backup says disabled viewer.
	assert.deepEqual(out.me, { role: 'admin', disabled: false, keepsPassword: true });
	assert.equal(out.owner.role, 'admin');
	assert.ok(out.ownerPassword);
	assert.equal(out.viewer.connectionAccess, 'selected');
	assert.equal(out.viewerGrants.length, 1);
	assert.equal(out.viewerGrants[0].canWrite, true);

	assert.deepEqual(out.settings.scanPaths, ['/srv']);
	assert.equal(out.settings.managers[0].url, 'https://arcane.local');
	assert.equal(out.managerKey, 'arc-api-key');
	assert.equal(out.sso.clientSecret, 'sso-secret-value');
	assert.equal(out.sso.issuer, 'https://id.example');
	assert.equal(out.localLogin, true);
});
