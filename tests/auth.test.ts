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
	assert.equal(admin?.needsProfile, true);
	assert.ok(store.legacyAdminPending());
	rmSync(dir, { recursive: true, force: true });
});

test('accounts migrated before needs_profile existed are flagged too', async () => {
	const dir2 = mkdtempSync(join(tmpdir(), 'pgm-auth-test2-'));
	// Shape of a store written by the first users release: users table without needs_profile.
	const db = new DatabaseSync(join(dir2, 'pg-modern.db'));
	db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT, role TEXT NOT NULL DEFAULT 'viewer',
			password_hash TEXT, oidc_sub TEXT UNIQUE, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_login_at TEXT);
		CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);`);
	db.prepare(`INSERT INTO users (id, email, role, password_hash, created_at) VALUES ('a', 'admin', 'admin', 'x', 'now')`).run();
	db.prepare(`INSERT INTO users (id, email, role, password_hash, created_at) VALUES ('b', 'jo@example.com', 'viewer', 'x', 'now')`).run();
	// Also cover stores where an earlier build already added the column without backfilling.
	db.exec('ALTER TABLE users ADD COLUMN needs_profile INTEGER NOT NULL DEFAULT 0');
	db.close();
	const { execFileSync } = await import('node:child_process');
	const out = execFileSync(
		process.execPath,
		['--no-warnings', '--experimental-strip-types', '--input-type=module', '-e',
			`const s = await import(${JSON.stringify(new URL('../src/lib/server/store.ts', import.meta.url).href)}); console.log(JSON.stringify(s.listUsers().map(u => [u.email, u.needsProfile])))`],
		{ env: { ...process.env, PGM_DATA_DIR: dir2 } }
	).toString();
	assert.deepEqual(JSON.parse(out), [['admin', true], ['jo@example.com', false]]);
	rmSync(dir2, { recursive: true, force: true });
});
