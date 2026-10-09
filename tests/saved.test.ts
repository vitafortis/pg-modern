import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PGM_DATA_DIR = mkdtempSync(join(tmpdir(), 'pgm-saved-test-'));
process.env.PGM_SECRET_KEY = 'test-key-for-saved-queries';
const store = await import('../src/lib/server/store.ts');
const { canEditSaved, parseSavedInput, visibleSavedQueries } = await import('../src/lib/server/saved.ts');

const conn = (name: string) => store.createConnection({ name, host: 'db', port: 5432, database: 'app', user: 'app', sslMode: 'prefer', readOnly: true });
const a = conn('a');
const b = conn('b');
const admin = store.createUser({ email: 'admin@x.io', role: 'admin' });
const alice = store.createUser({ email: 'alice@x.io', role: 'viewer' });
const bob = store.createUser({ email: 'bob@x.io', role: 'viewer' });

const save = (owner: typeof alice, name: string, connectionId: string | null, shared: boolean) =>
	store.createSavedQuery(owner, { name, description: null, sql: `select '${name}'`, connectionId, shared });

const mineA = save(alice, 'alice private on a', a.id, false);
const sharedA = save(alice, 'alice shared on a', a.id, true);
const sharedAny = save(alice, 'alice shared anywhere', null, true);
const sharedB = save(alice, 'alice shared on b', b.id, true);
save(bob, 'bob private anywhere', null, false);

const names = (qs: { name: string }[]) => qs.map((q) => q.name).sort();

test('own and shared queries for a connection, plus connection-less ones', () => {
	assert.deepEqual(names(visibleSavedQueries(alice, a.id)), ['alice private on a', 'alice shared anywhere', 'alice shared on a']);
	assert.deepEqual(names(visibleSavedQueries(bob, a.id)), ['alice shared anywhere', 'alice shared on a', 'bob private anywhere']);
	// Admins don't see other people's private queries either.
	assert.deepEqual(names(visibleSavedQueries(admin, a.id)), ['alice shared anywhere', 'alice shared on a']);
});

test('shared queries follow connection visibility', () => {
	store.updateUser(bob.id, { connectionAccess: 'selected' });
	store.setGrants(bob.id, [{ connectionId: a.id, canWrite: false }]);
	const limited = store.getUser(bob.id)!;
	assert.deepEqual(names(visibleSavedQueries(limited)), ['alice shared anywhere', 'alice shared on a', 'bob private anywhere']);
	assert.ok(!visibleSavedQueries(limited).some((q) => q.id === sharedB.id));
	assert.throws(() => parseSavedInput(limited, { name: 'x', sql: 'select 1', connectionId: b.id }), /Connection not found/);
});

test('only owners and admins can edit', () => {
	assert.ok(canEditSaved(alice, sharedA));
	assert.ok(canEditSaved(admin, sharedA));
	assert.ok(!canEditSaved(bob, sharedA));
	const forBob = visibleSavedQueries(bob, a.id).find((q) => q.id === sharedAny.id)!;
	assert.equal(forBob.mine, false);
	assert.equal(forBob.canEdit, false);
	assert.equal(visibleSavedQueries(alice, a.id).find((q) => q.id === mineA.id)!.mine, true);
});

test('validates input', () => {
	assert.throws(() => parseSavedInput(alice, { sql: 'select 1' }), /name/);
	assert.throws(() => parseSavedInput(alice, { name: 'x', sql: ' ' }), /sql/);
	assert.deepEqual(parseSavedInput(alice, { name: ' x ', sql: 'select 1 ', description: '', shared: true, connectionId: null }), {
		name: 'x',
		sql: 'select 1',
		description: null,
		connectionId: null,
		shared: true
	});
});

test('updates, deletes, and cascades with the connection', () => {
	const q = store.updateSavedQuery(mineA.id, { name: 'renamed', description: 'd', sql: 'select 2', connectionId: a.id, shared: true })!;
	assert.equal(q.name, 'renamed');
	assert.equal(q.shared, true);
	assert.ok(q.updatedAt >= mineA.updatedAt);
	assert.ok(store.deleteSavedQuery(sharedAny.id));
	assert.equal(store.getSavedQuery(sharedAny.id), undefined);
	store.deleteConnection(a.id);
	assert.equal(store.getSavedQuery(sharedA.id), undefined);
});
