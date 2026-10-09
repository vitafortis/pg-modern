import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, normalizeSchema, type SchemaSnapshotData, type SnapshotTable } from '../src/lib/schema/model.ts';
import { diffSchemas, migrationSql } from '../src/lib/schema/diff.ts';
import { lineDiff } from '../src/lib/schema/text-diff.ts';

process.env.PGM_DATA_DIR = mkdtempSync(join(tmpdir(), 'pgm-snap-test-'));
process.env.PGM_SECRET_KEY = 'test-key-for-snapshots';
const { schemaHash } = await import('../src/lib/server/schema-capture.ts');
const snaps = await import('../src/lib/server/schema-snapshots.ts');
const store = await import('../src/lib/server/store.ts');

const users = (): SnapshotTable => ({
	schema: 'public',
	name: 'users',
	kind: 'table',
	columns: [
		{ name: 'id', type: 'integer', nullable: false, default: null, extra: 'GENERATED ALWAYS AS IDENTITY' },
		{ name: 'email', type: 'text', nullable: false, default: null },
		{ name: 'created_at', type: 'timestamp with time zone', nullable: true, default: 'now()' }
	],
	primaryKey: { name: 'users_pkey', columns: ['id'] },
	constraints: [{ name: 'users_email_check', type: 'check', definition: "CHECK (email ~ '@')" }],
	indexes: [{ name: 'users_email_idx', definition: 'CREATE INDEX users_email_idx ON public.users USING btree (email)', unique: false }]
});

const base = (): SchemaSnapshotData => ({
	format: 1,
	engine: 'postgres',
	schemas: ['public'],
	tables: [users()],
	views: [{ schema: 'public', name: 'active_users', materialized: false, definition: ' SELECT id,\n    email\n   FROM users;' }],
	routines: [{ schema: 'public', name: 'touch', kind: 'function', args: '', returns: 'trigger', language: 'plpgsql', bodyHash: 'h1', body: 'CREATE FUNCTION touch() …\nBEGIN\n  RETURN NEW;\nEND' }],
	triggers: [{ schema: 'public', table: 'users', name: 'users_touch', definition: 'CREATE TRIGGER users_touch BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION touch()' }],
	types: [{ schema: 'public', name: 'mood', kind: 'enum', definition: "'happy', 'sad'" }],
	extensions: [{ name: 'plpgsql', version: '1.0' }]
});

const clone = <T>(x: T): T => structuredClone(x);

test('identical schemas have no differences', () => {
	const d = diffSchemas(normalizeSchema(base()), normalizeSchema(base()));
	assert.equal(d.identical, true);
	assert.deepEqual(d.total, { added: 0, removed: 0, changed: 0 });
});

test('added, removed and changed columns', () => {
	const to = clone(base());
	const t = to.tables[0];
	t.columns.push({ name: 'name', type: 'text', nullable: true, default: null });
	t.columns = t.columns.filter((c) => c.name !== 'created_at');
	t.columns.find((c) => c.name === 'email')!.type = 'varchar(320)';
	const d = diffSchemas(normalizeSchema(base()), normalizeSchema(to));
	assert.equal(d.items.length, 1);
	const item = d.items[0];
	assert.equal(item.type, 'table');
	assert.equal(item.change, 'changed');
	const byName = Object.fromEntries(item.details.map((x) => [x.name, x]));
	assert.equal(byName.name.change, 'added');
	assert.equal(byName.name.after, 'text');
	assert.equal(byName.created_at.change, 'removed');
	assert.equal(byName.email.change, 'changed');
	assert.deepEqual(byName.email.fields, [{ field: 'type', before: 'text', after: 'varchar(320)' }]);
	assert.deepEqual(d.summary.table, { added: 0, removed: 0, changed: 1 });
});

test('nullability and default changes are column-level fields', () => {
	const to = clone(base());
	const c = to.tables[0].columns.find((x) => x.name === 'created_at')!;
	c.nullable = false;
	c.default = 'CURRENT_TIMESTAMP';
	const d = diffSchemas(normalizeSchema(base()), normalizeSchema(to));
	const detail = d.items[0].details[0];
	assert.deepEqual(detail.fields?.map((f) => f.field), ['nullable', 'default']);
	const sql = migrationSql(d, normalizeSchema(to));
	assert.match(sql, /ALTER TABLE "public"\."users" ALTER COLUMN "created_at" SET NOT NULL;/);
	assert.match(sql, /ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP;/);
});

test('index definition changes, additions and drops', () => {
	const to = clone(base());
	to.tables[0].indexes = [
		{ name: 'users_email_idx', definition: 'CREATE UNIQUE INDEX users_email_idx ON public.users USING btree (lower(email))', unique: true },
		{ name: 'users_created_idx', definition: 'CREATE INDEX users_created_idx ON public.users USING btree (created_at)', unique: false }
	];
	const d = diffSchemas(normalizeSchema(base()), normalizeSchema(to));
	const idx = d.items[0].details.filter((x) => x.kind === 'index');
	assert.deepEqual(idx.map((x) => [x.name, x.change]).sort(), [['users_created_idx', 'added'], ['users_email_idx', 'changed']]);
	const sql = migrationSql(d, normalizeSchema(to));
	assert.match(sql, /DROP INDEX IF EXISTS "public"\."users_email_idx";\nCREATE UNIQUE INDEX users_email_idx ON public\.users USING btree \(lower\(email\)\);/);
	assert.match(sql, /CREATE INDEX users_created_idx ON public\.users USING btree \(created_at\);/);
});

test('a renamed table or column is a removal plus an addition', () => {
	const to = clone(base());
	to.tables[0].name = 'accounts';
	to.tables[0].columns[1].name = 'mail';
	const d = diffSchemas(normalizeSchema(base()), normalizeSchema(to));
	assert.deepEqual(d.items.filter((i) => i.type === 'table').map((i) => [i.key, i.change]), [['public.users', 'removed'], ['public.accounts', 'added']]);

	const to2 = clone(base());
	to2.tables[0].columns[1].name = 'mail';
	const d2 = diffSchemas(normalizeSchema(base()), normalizeSchema(to2));
	assert.deepEqual(d2.items[0].details.map((x) => [x.name, x.change]), [['email', 'removed'], ['mail', 'added']]);
	const sql = migrationSql(d2, normalizeSchema(to2));
	assert.match(sql, /ADD COLUMN "mail" text NOT NULL;/);
	assert.match(sql, /-- ALTER TABLE "public"\."users" DROP COLUMN "email";/, 'drops stay commented out');
});

test('views, functions, triggers, types and extensions', () => {
	const to = clone(base());
	to.views[0].definition = ' SELECT id,\n    email,\n    name\n   FROM users;';
	to.routines[0].bodyHash = 'h2';
	to.routines[0].body = 'CREATE FUNCTION touch() …\nBEGIN\n  NEW.updated_at := now();\n  RETURN NEW;\nEND';
	to.routines.push({ schema: 'public', name: 'touch', kind: 'function', args: 'x integer', returns: 'void', language: 'sql', bodyHash: 'h3', body: 'x' });
	to.triggers = [];
	to.types[0].definition = "'happy', 'sad', 'meh'";
	to.extensions[0].version = '1.1';
	to.extensions.push({ name: 'pg_trgm', version: '1.6' });
	const d = diffSchemas(normalizeSchema(base()), normalizeSchema(to));
	const s = d.summary;
	assert.deepEqual(s.view, { added: 0, removed: 0, changed: 1 });
	assert.deepEqual(s.routine, { added: 1, removed: 0, changed: 1 }, 'overloads are separate routines');
	assert.deepEqual(s.trigger, { added: 0, removed: 1, changed: 0 });
	assert.deepEqual(s.type, { added: 0, removed: 0, changed: 1 });
	assert.deepEqual(s.extension, { added: 1, removed: 0, changed: 1 });
	const view = d.items.find((i) => i.type === 'view')!;
	const lines = lineDiff(view.before, view.after);
	assert.deepEqual(lines.filter((l) => l.op !== 'same'), [
		{ op: 'del', text: '    email' },
		{ op: 'add', text: '    email,' },
		{ op: 'add', text: '    name' }
	]);
});

test('a changed body without stored text is still flagged', () => {
	const from = clone(base());
	from.routines[0].body = null;
	const to = clone(base());
	to.routines[0].bodyHash = 'other';
	const d = diffSchemas(normalizeSchema(from), normalizeSchema(to));
	assert.equal(d.items[0].type, 'routine');
	assert.equal(d.items[0].bodyUnavailable, true);
});

test('normalization is independent of catalog order', () => {
	const a = base();
	a.tables.push({ ...users(), name: 'zeta', indexes: [] }, { ...users(), schema: 'audit', name: 'log' });
	a.schemas.push('audit');
	const b = clone(a);
	b.tables.reverse();
	b.schemas.reverse();
	b.tables[0].constraints.reverse();
	b.tables.forEach((t) => t.indexes.reverse());
	b.extensions.reverse();
	// Trailing whitespace and CRLFs don't count either.
	b.views[0].definition = b.views[0].definition.replace(/\n/g, '  \r\n');
	assert.equal(canonicalJson(normalizeSchema(a)), canonicalJson(normalizeSchema(b)));
	assert.equal(schemaHash(a), schemaHash(b));
	// Column order is part of the schema, so it isn't sorted away.
	const c = clone(a);
	c.tables[0].columns.reverse();
	assert.notEqual(schemaHash(a), schemaHash(c));
	// Hashes cover bodies through bodyHash, so a slimmed snapshot hashes the same.
	const slim = { ...clone(a), bodiesOmitted: true, routines: a.routines.map((r) => ({ ...r, body: null })) };
	assert.equal(schemaHash(a), schemaHash(slim));
	assert.equal(normalizeSchema(a).tables.map((t) => `${t.schema}.${t.name}`).join(), 'audit.log,public.users,public.zeta');
});

test('mysql migration uses MODIFY and CREATE INDEX … ON', () => {
	const from: SchemaSnapshotData = {
		...base(),
		engine: 'mysql',
		views: [],
		routines: [],
		triggers: [],
		types: [],
		extensions: [],
		tables: [{ schema: 'app', name: 't', kind: 'table', columns: [{ name: 'a', type: 'int(11)', nullable: true, default: null }], primaryKey: null, constraints: [], indexes: [] }],
		schemas: ['app']
	};
	const to = clone(from);
	to.tables[0].columns[0].nullable = false;
	to.tables[0].indexes.push({ name: 'a_idx', definition: 'INDEX `a_idx` (`a`)', unique: false });
	const sql = migrationSql(diffSchemas(normalizeSchema(from), normalizeSchema(to)), normalizeSchema(to));
	assert.match(sql, /ALTER TABLE `app`\.`t` MODIFY COLUMN `a` int\(11\) NOT NULL;/);
	assert.match(sql, /CREATE INDEX `a_idx` ON `app`\.`t` \(`a`\);/);
});

test('storing snapshots: size cap, retention and hashes', () => {
	const conn = store.createConnection({ name: 'c', host: 'db', port: 5432, database: 'app', user: 'app', sslMode: 'prefer', readOnly: true });
	const data = normalizeSchema(base());
	const meta = snaps.saveSnapshot(conn.id, data, { label: 'first', user: { id: 'u1', email: 'a@x.io' } });
	assert.equal(meta.hash, schemaHash(data));
	assert.deepEqual(snaps.getSnapshotData(meta.id), data);
	assert.equal(meta.stats.tables, 1);

	// Over the cap: bodies go first, and the hash doesn't change.
	const big = clone(data);
	big.routines[0].body = 'x'.repeat(2000);
	const enc = snaps.encodeSnapshot(big, 1500);
	assert.equal(enc.data.bodiesOmitted, true);
	assert.equal(enc.data.routines[0].body, null);
	assert.equal(schemaHash(enc.data), schemaHash(big));
	assert.throws(() => snaps.encodeSnapshot(big, 100), /too large/);

	for (let i = 0; i < snaps.KEEP_PER_CONNECTION + 3; i++) snaps.saveSnapshot(conn.id, data, { label: `n${i}`, auto: true });
	const list = snaps.listSnapshots(conn.id);
	assert.equal(list.length, snaps.KEEP_PER_CONNECTION);
	assert.equal(list[0].label, `n${snaps.KEEP_PER_CONNECTION + 2}`);
	assert.ok(!list.some((s) => s.label === 'first'));

	assert.ok(snaps.canDeleteSnapshot({ id: 'u1', role: 'viewer' } as never, { createdById: 'u1' }));
	assert.ok(!snaps.canDeleteSnapshot({ id: 'u2', role: 'viewer' } as never, { createdById: 'u1' }));
	assert.ok(snaps.canDeleteSnapshot({ id: 'u2', role: 'admin' } as never, { createdById: null }));
});

test('cross-connection sources respect visibility', async () => {
	const a = store.createConnection({ name: 'a', host: 'db', port: 5432, database: 'app', user: 'app', sslMode: 'prefer', readOnly: true });
	const b = store.createConnection({ name: 'b', host: 'db', port: 5432, database: 'app', user: 'app', sslMode: 'prefer', readOnly: true });
	const snapB = snaps.saveSnapshot(b.id, normalizeSchema(base()), { label: 'b1' });
	const viewer = store.createUser({ email: 'v@x.io', role: 'viewer' });
	store.updateUser(viewer.id, { connectionAccess: 'selected' });
	store.setGrants(viewer.id, [{ connectionId: a.id, canWrite: false }]);
	const limited = store.getUser(viewer.id)!;
	await assert.rejects(snaps.resolveSource(limited, { kind: 'snapshot', connectionId: b.id, snapshotId: snapB.id }), /Connection not found/);
	// A snapshot id from another connection can't be smuggled in through a visible one.
	await assert.rejects(snaps.resolveSource(limited, { kind: 'snapshot', connectionId: a.id, snapshotId: snapB.id }), /Snapshot not found/);
	assert.throws(() => snaps.parseSource({ kind: 'other', connectionId: a.id }), /kind/);
});
