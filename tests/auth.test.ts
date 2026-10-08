import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(join(tmpdir(), 'pgm-auth-test-'));
process.env.PGM_DATA_DIR = dir;
const { emailMatches } = await import('../src/lib/server/auth.ts');
const { hashPassword, verifyPassword } = await import('../src/lib/server/crypto.ts');

test('email patterns', () => {
	const patterns = ['*@example.com', 'bob@gmail.com', '@corp.io'];
	assert.ok(emailMatches('Alice@Example.com', patterns));
	assert.ok(emailMatches('bob@gmail.com', patterns));
	assert.ok(emailMatches('x@corp.io', patterns));
	assert.ok(!emailMatches('alice@example.com.evil.org', patterns));
	assert.ok(!emailMatches('alice@notexample.com', patterns));
	assert.ok(!emailMatches('eve@gmail.com', patterns));
	assert.ok(emailMatches('anyone@anywhere', ['*']));
	assert.ok(!emailMatches('anyone@anywhere', []));
});

test('v1 admin password migrates to an "admin" user', async () => {
	// Simulate a v1 store: single admin password in kv, sessions without users.
	const legacy = new DatabaseSync(join(dir, 'pg-modern.db'));
	legacy.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);`);
	legacy.prepare('INSERT INTO kv VALUES (?, ?)').run('admin_password', JSON.stringify(hashPassword('old-password')));
	legacy.close();

	const store = await import('../src/lib/server/store.ts');
	const admin = store.findUserByEmail('admin');
	assert.equal(admin?.role, 'admin');
	assert.ok(verifyPassword('old-password', store.getPasswordHash(admin!.id)!));
	assert.equal(store.countUsers(), 1);
	rmSync(dir, { recursive: true, force: true });
});
