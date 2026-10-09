import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PGM_DATA_DIR = mkdtempSync(join(tmpdir(), 'pgm-perm-test-'));
process.env.PGM_SECRET_KEY = 'test-key-for-permissions';
const store = await import('../src/lib/server/store.ts');
const { accessFor, canSee, visibleConnections } = await import('../src/lib/server/permissions.ts');

const conn = (name: string, readOnly: boolean) =>
	store.createConnection({ name, host: 'db', port: 5432, database: 'app', user: 'app', sslMode: 'prefer', readOnly });

const ro = conn('ro', true);
const rw = conn('rw', false);
const admin = store.createUser({ email: 'admin@x.io', role: 'admin' });
const viewer = store.createUser({ email: 'viewer@x.io', role: 'viewer' });

test('admins see everything; writable connections are writable, read-only ones unlockable', () => {
	assert.equal(visibleConnections(admin).length, 2);
	assert.deepEqual(accessFor(admin, rw), { write: 'always', unlockedUntil: null, readOnly: false });
	assert.deepEqual(accessFor(admin, ro), { write: 'unlock', unlockedUntil: null, readOnly: true });
});

test('viewers are read-only everywhere, even on writable connections', () => {
	assert.ok(canSee(viewer, rw));
	assert.equal(accessFor(viewer, rw).write, 'never');
	assert.equal(accessFor(viewer, rw).readOnly, true);
});

test('selected access hides other connections; write grants allow unlocking only', () => {
	store.updateUser(viewer.id, { connectionAccess: 'selected' });
	store.setGrants(viewer.id, [{ connectionId: ro.id, canWrite: true }]);
	const v = store.getUser(viewer.id)!;
	assert.deepEqual(visibleConnections(v).map((c) => c.name), ['ro']);
	assert.ok(!canSee(v, rw));
	// A write grant on a writable connection still needs an unlock for viewers.
	assert.equal(accessFor(v, ro).write, 'unlock');
	assert.equal(accessFor(v, ro).readOnly, true);
});

test('unlocks are temporary', () => {
	const v = store.getUser(viewer.id)!;
	store.setUnlock(v.id, ro.id, Date.now() + 60_000, 'fix data');
	assert.equal(accessFor(v, ro).readOnly, false);
	store.setUnlock(v.id, ro.id, Date.now() - 1, null);
	assert.equal(accessFor(v, ro).readOnly, true);
	assert.equal(accessFor(v, ro).unlockedUntil, null);
});

test('history is attributed and searchable; audit events outlive connections', () => {
	store.addHistory({ connectionId: ro.id, sql: 'select 1', ok: true, rowCount: 1, durationMs: 2, error: null, userId: viewer.id, userEmail: viewer.email, readOnly: true });
	store.addHistory({ connectionId: ro.id, sql: 'delete from t where id = 1', ok: true, rowCount: 1, durationMs: 2, error: null, userId: admin.id, userEmail: admin.email, readOnly: false });
	assert.equal(store.listHistory(ro.id, 10, viewer.id).length, 1);
	assert.equal(store.listHistory(ro.id, 10).length, 2);
	const writes = store.searchHistory({ writes: true });
	assert.equal(writes.length, 1);
	assert.equal(writes[0].connectionName, 'ro');
	store.addAudit({ userId: admin.id, userEmail: admin.email, action: 'connection.delete', connectionId: rw.id, connectionName: 'rw', detail: null, ip: null });
	store.deleteConnection(rw.id);
	assert.equal(store.searchAudit({ action: 'connection.' })[0].connectionName, 'rw');
});
