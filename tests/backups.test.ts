import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

process.env.PGM_DATA_DIR = mkdtempSync(join(tmpdir(), 'pgm-backups-test-'));
process.env.PGM_SECRET_KEY = 'test-key-for-backups';
const { nextRunAt, isDue, selectForPruning, dumpFileName, isSafeKey, slug, describeTiming, describeRetention } = await import('../src/lib/backups.ts');
const { mergeSecrets, createDestination, getDestination, getDestinationSecrets, updateDestination, listDestinations } = await import('../src/lib/server/backups/store.ts');
const { driverFor, fingerprint } = await import('../src/lib/server/backups/destinations.ts');
const { objectUrl, fullKey, s3Put } = await import('../src/lib/server/backups/s3.ts');
const { pgDumpCommand, mysqlDumpCommand, mysqlSslArgs, pgRestoreCommand } = await import('../src/lib/server/backups/tools.ts');
const { parseScheduleInput, parseDestinationInput } = await import('../src/lib/server/backups/input.ts');

// Dates are built in local time, like the scheduler, so these pass in any TZ.
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s);

test('hourly schedules fire at the next matching minute', () => {
	const t = { frequency: 'hourly' as const, minute: 15, hour: 0, weekday: 0 };
	assert.deepEqual(nextRunAt(t, at(2026, 10, 9, 10, 0)), at(2026, 10, 9, 10, 15));
	assert.deepEqual(nextRunAt(t, at(2026, 10, 9, 10, 15)), at(2026, 10, 9, 11, 15), 'strictly after');
	assert.deepEqual(nextRunAt(t, at(2026, 10, 9, 10, 16)), at(2026, 10, 9, 11, 15));
	assert.deepEqual(nextRunAt(t, at(2026, 10, 9, 23, 30)), at(2026, 10, 10, 0, 15), 'rolls over midnight');
	assert.deepEqual(nextRunAt({ ...t, minute: 0 }, at(2026, 10, 9, 10, 0, 30)), at(2026, 10, 9, 11, 0));
});

test('daily schedules fire at HH:MM today or tomorrow', () => {
	const t = { frequency: 'daily' as const, minute: 30, hour: 3, weekday: 0 };
	assert.deepEqual(nextRunAt(t, at(2026, 10, 9, 1, 0)), at(2026, 10, 9, 3, 30));
	assert.deepEqual(nextRunAt(t, at(2026, 10, 9, 3, 30)), at(2026, 10, 10, 3, 30));
	assert.deepEqual(nextRunAt(t, at(2026, 10, 9, 12, 0)), at(2026, 10, 10, 3, 30));
	assert.deepEqual(nextRunAt(t, at(2026, 12, 31, 23, 59)), at(2027, 1, 1, 3, 30), 'rolls over the year');
	assert.deepEqual(nextRunAt(t, at(2026, 2, 28, 4, 0)), at(2026, 3, 1, 3, 30), 'rolls over the month');
});

test('weekly schedules fire on the weekday at HH:MM', () => {
	// 2026-10-09 is a Friday (5).
	assert.equal(at(2026, 10, 9).getDay(), 5);
	const sunday = { frequency: 'weekly' as const, minute: 0, hour: 2, weekday: 0 };
	assert.deepEqual(nextRunAt(sunday, at(2026, 10, 9, 12, 0)), at(2026, 10, 11, 2, 0));
	const friday = { frequency: 'weekly' as const, minute: 0, hour: 18, weekday: 5 };
	assert.deepEqual(nextRunAt(friday, at(2026, 10, 9, 12, 0)), at(2026, 10, 9, 18, 0), 'later today');
	assert.deepEqual(nextRunAt(friday, at(2026, 10, 9, 18, 0)), at(2026, 10, 16, 18, 0), 'a week later once passed');
	assert.deepEqual(nextRunAt(friday, at(2026, 10, 9, 19, 0)), at(2026, 10, 16, 18, 0));
	const thursday = { ...friday, weekday: 4 };
	assert.deepEqual(nextRunAt(thursday, at(2026, 10, 9, 12, 0)), at(2026, 10, 15, 18, 0));
});

test('isDue: enabled schedules whose next run has passed (missed runs fire once)', () => {
	const now = at(2026, 10, 9, 3, 0, 20);
	assert.ok(isDue({ enabled: true, nextRunAt: at(2026, 10, 9, 3, 0).toISOString() }, now));
	assert.ok(isDue({ enabled: true, nextRunAt: at(2026, 10, 1, 3, 0).toISOString() }, now), 'missed while down');
	assert.ok(!isDue({ enabled: true, nextRunAt: at(2026, 10, 9, 3, 1).toISOString() }, now));
	assert.ok(!isDue({ enabled: false, nextRunAt: at(2026, 10, 9, 3, 0).toISOString() }, now));
	assert.ok(!isDue({ enabled: true, nextRunAt: null }, now));
});

test('descriptions', () => {
	assert.equal(describeTiming({ frequency: 'hourly', minute: 0, hour: 0, weekday: 0 }), 'Every hour, on the hour');
	assert.equal(describeTiming({ frequency: 'hourly', minute: 5, hour: 0, weekday: 0 }), 'Every hour at :05');
	assert.equal(describeTiming({ frequency: 'daily', minute: 5, hour: 3, weekday: 0 }), 'Daily at 03:05');
	assert.equal(describeTiming({ frequency: 'weekly', minute: 0, hour: 23, weekday: 1 }), 'Mondays at 23:00');
	assert.equal(describeRetention({ keepLast: 7, keepDays: 30 }), 'Keep last 7 + 30 days');
	assert.equal(describeRetention({ keepLast: null, keepDays: null }), 'Keep everything');
});

// --- retention ---------------------------------------------------------------------

const now = at(2026, 10, 9, 12, 0);
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
/** One successful backup per day, newest first: r0 (today) … r9 (9 days ago). */
const runs = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, status: 'success' as const, startedAt: daysAgo(i) }));
const ids = (rs: { id: string }[]) => rs.map((r) => r.id).sort();

test('retention: keep last N', () => {
	assert.deepEqual(ids(selectForPruning(runs, { keepLast: 3, keepDays: null }, now)), ['r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']);
	assert.deepEqual(selectForPruning(runs, { keepLast: 20, keepDays: null }, now), []);
});

test('retention: keep N days', () => {
	assert.deepEqual(ids(selectForPruning(runs, { keepLast: null, keepDays: 5 }, now)), ['r6', 'r7', 'r8', 'r9']);
});

test('retention: a backup is kept if either rule keeps it', () => {
	assert.deepEqual(ids(selectForPruning(runs, { keepLast: 7, keepDays: 2 }, now)), ['r7', 'r8', 'r9']);
	assert.deepEqual(ids(selectForPruning(runs, { keepLast: 2, keepDays: 7 }, now)), ['r8', 'r9']);
});

test('retention: no rules keeps everything; the newest good backup always stays', () => {
	assert.deepEqual(selectForPruning(runs, { keepLast: null, keepDays: null }, now), []);
	assert.deepEqual(selectForPruning(runs, { keepLast: 0, keepDays: 0 }, now), []);
	const old = runs.map((r) => ({ ...r, startedAt: new Date(new Date(r.startedAt).getTime() - 100 * 86_400_000).toISOString() }));
	const pruned = selectForPruning(old, { keepLast: null, keepDays: 30 }, now);
	assert.equal(pruned.length, 9);
	assert.ok(!pruned.some((r) => r.id === 'r0'));
});

test('retention ignores failed runs and sorts by time', () => {
	const mixed = [
		{ id: 'f1', status: 'failed' as const, startedAt: daysAgo(0) },
		{ id: 'old', status: 'success' as const, startedAt: daysAgo(3) },
		{ id: 'new', status: 'success' as const, startedAt: daysAgo(1) },
		{ id: 'f2', status: 'failed' as const, startedAt: daysAgo(9) }
	];
	assert.deepEqual(ids(selectForPruning(mixed, { keepLast: 1, keepDays: null }, now)), ['old']);
});

// --- names -------------------------------------------------------------------------

test('dump file names are safe keys, one folder per connection', () => {
	assert.equal(slug('Nextcloud DB (prod)'), 'nextcloud-db-prod');
	assert.equal(slug('Café/../../etc'), 'cafe-..-..-etc');
	assert.equal(slug('***'), 'connection');
	const name = dumpFileName('Nextcloud DB', 'mysql-sql-gz', at(2026, 10, 9, 3, 0, 5));
	assert.equal(name, 'nextcloud-db/nextcloud-db-20261009-030005.sql.gz');
	assert.equal(dumpFileName('immich', 'pg-custom', at(2026, 1, 2, 3, 4, 5)), 'immich/immich-20260102-030405.dump');
	assert.ok(isSafeKey(name));
	for (const bad of ['../x', 'a/../b', '/abs', 'a//b', 'a/./b', 'a b', '']) assert.ok(!isSafeKey(bad), bad);
});

// --- destinations ------------------------------------------------------------------

test('secrets: undefined keeps, empty clears, value replaces', () => {
	const cur = { password: 'old', privateKey: 'KEY' };
	assert.deepEqual(mergeSecrets(cur, { password: undefined, privateKey: '' }), { password: 'old' });
	assert.deepEqual(mergeSecrets(cur, { password: 'new' }), { password: 'new', privateKey: 'KEY' });
});

test('destination secrets are sealed and never listed', () => {
	const d = createDestination('nas', { kind: 'sftp', config: { host: 'nas', port: 22, user: 'backup', path: 'dumps', hostKey: '' } }, { password: 'hunter2' });
	assert.equal(d.hasPassword, true);
	assert.equal(d.hasPrivateKey, false);
	assert.ok(!JSON.stringify(listDestinations()).includes('hunter2'));
	assert.deepEqual(getDestinationSecrets(d.id), { password: 'hunter2' });
	updateDestination(d.id, 'nas', d, { privateKey: 'PEM' });
	assert.deepEqual(getDestinationSecrets(d.id), { password: 'hunter2', privateKey: 'PEM' });
	updateDestination(d.id, 'nas2', d, { password: '' });
	assert.deepEqual(getDestinationSecrets(d.id), { privateKey: 'PEM' });
	assert.equal(getDestination(d.id)!.name, 'nas2');
});

test('local destination: round trip, partial files cleaned, no escaping the folder', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'pgm-backups-local-'));
	const drv = driverFor({ kind: 'local', config: { path: dir } }, {});
	const size = await drv.put('db/db-1.sql', Readable.from([Buffer.from('hello '), Buffer.from('world')]));
	assert.equal(size, 11);
	assert.deepEqual(readdirSync(join(dir, 'db')), ['db-1.sql']);
	const { stream, size: got } = await drv.get('db/db-1.sql');
	let text = '';
	for await (const c of stream) text += c;
	assert.equal(text, 'hello world');
	assert.equal(got, 11);
	await drv.delete('db/db-1.sql');
	assert.deepEqual(readdirSync(join(dir, 'db')), []);
	await assert.rejects(drv.put('../escape', Readable.from(['x'])), /Invalid backup file name/);
	const failing = new Readable({ read() { this.destroy(new Error('dump died')); } });
	await assert.rejects(drv.put('db/broken.sql', failing), /dump died/);
	assert.deepEqual(readdirSync(join(dir, 'db')), [], 'no .partial left behind');
	assert.throws(() => driverFor({ kind: 'local', config: { path: 'relative' } }, {}), /absolute/);
});

test('sftp host key fingerprints look like ssh-keygen -l', () => {
	assert.match(fingerprint(Buffer.from('key')), /^SHA256:[A-Za-z0-9+/]{43}$/);
});

// --- S3 ----------------------------------------------------------------------------

const s3 = { endpoint: 'http://minio.lan:9000', region: 'us-east-1', bucket: 'backups', prefix: 'pg-modern', accessKeyId: 'AK', pathStyle: true };

test('S3 object URLs, path-style and virtual-hosted', () => {
	assert.equal(fullKey(s3, 'a/b.dump'), 'pg-modern/a/b.dump');
	assert.equal(fullKey({ ...s3, prefix: '' }, 'a/b.dump'), 'a/b.dump');
	assert.equal(fullKey({ ...s3, prefix: '/x/' }, 'a'), 'x/a');
	assert.equal(objectUrl(s3, 'pg-modern/a.dump').href, 'http://minio.lan:9000/backups/pg-modern/a.dump');
	assert.equal(objectUrl({ ...s3, endpoint: 'https://s3.example.com', pathStyle: false }, 'k').href, 'https://backups.s3.example.com/k');
	assert.equal(objectUrl({ ...s3, endpoint: 's3.example.com' }, 'k').href, 'https://s3.example.com/backups/k');
});

test('S3 uploads: one PUT when small, multipart when large, abort on failure', async () => {
	const calls: { method: string; url: string; size: number }[] = [];
	const realFetch = globalThis.fetch;
	let failPart = 0;
	globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
		const req = input instanceof Request ? input : new Request(input, init);
		const body = req.body ? Buffer.from(await req.arrayBuffer()) : Buffer.alloc(0);
		const url = new URL(req.url);
		calls.push({ method: req.method, url: url.pathname + url.search, size: body.length });
		assert.ok(req.headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256'));
		if (url.searchParams.has('uploads')) return new Response('<InitiateMultipartUploadResult><UploadId>U1</UploadId></InitiateMultipartUploadResult>');
		const part = Number(url.searchParams.get('partNumber'));
		if (part && part === failPart) return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
		if (part) return new Response('', { headers: { etag: `"e${part}"` } });
		return new Response('<CompleteMultipartUploadResult/>');
	}) as typeof fetch;
	try {
		const t = { ...s3, secretAccessKey: 'SK' };
		assert.equal(await s3Put(t, 'small.sql', Readable.from([Buffer.alloc(10)]), 64), 10);
		assert.deepEqual(calls.map((c) => c.method), ['PUT']);

		calls.length = 0;
		const chunks = Array.from({ length: 10 }, () => Buffer.alloc(30, 1)); // 300 bytes in 64-byte parts
		assert.equal(await s3Put(t, 'big.sql', Readable.from(chunks), 64), 300);
		assert.deepEqual(calls.map((c) => c.method), ['POST', 'PUT', 'PUT', 'PUT', 'PUT', 'PUT', 'POST']);
		assert.deepEqual(calls.filter((c) => c.method === 'PUT').map((c) => c.size), [64, 64, 64, 64, 44]);

		calls.length = 0;
		failPart = 2;
		await assert.rejects(s3Put(t, 'big.sql', Readable.from(chunks), 64), /part 2 failed: 403 AccessDenied/);
		assert.equal(calls.at(-1)!.method, 'DELETE', 'aborts the multipart upload');
	} finally {
		globalThis.fetch = realFetch;
	}
});

// --- commands ----------------------------------------------------------------------

test('dump commands never put the password on the command line', () => {
	const target = { host: 'db', port: 5432, user: 'app', database: 'shop', password: 's3cret!', sslMode: 'require' as const };
	const pg = pgDumpCommand({ bin: 'pg_dump', version: '18' }, target, true);
	assert.ok(!pg.args.join(' ').includes('s3cret'));
	assert.equal(pg.env.PGPASSWORD, 's3cret!');
	assert.equal(pg.env.PGSSLMODE, 'require');
	assert.ok(pg.args.includes('--format=custom') && pg.args.includes('--dbname=shop'));
	assert.ok(pgDumpCommand({ bin: 'pg_dump', version: '18' }, target, false).args.includes('--compress=0'));
	assert.deepEqual(pgRestoreCommand({ bin: 'pg_restore', version: '18' }, target).args.slice(0, 3), ['--clean', '--if-exists', '--no-owner']);

	const maria = { bin: 'mariadb-dump', version: 'mariadb-dump from 11.8.3-MariaDB', mariadb: true };
	const my = mysqlDumpCommand(maria, { ...target, port: 3306 }, ['shop'], false);
	assert.ok(!my.args.join(' ').includes('s3cret'));
	assert.equal(my.env.MYSQL_PWD, 's3cret!');
	for (const flag of ['--single-transaction', '--routines', '--triggers', '--events']) assert.ok(my.args.includes(flag), flag);
	assert.deepEqual(my.args.slice(-2), ['--', 'shop']);
	const all = mysqlDumpCommand(maria, { ...target, database: '' }, ['a', 'b'], false);
	assert.deepEqual(all.args.slice(-4), ['--databases', '--', 'a', 'b']);
	assert.deepEqual(mysqlSslArgs(maria, 'disable'), ['--skip-ssl']);
	assert.deepEqual(mysqlSslArgs(maria, 'verify-full'), ['--ssl', '--ssl-verify-server-cert']);
	assert.deepEqual(mysqlSslArgs({ bin: 'mysqldump', version: '8.4' }, 'require'), ['--ssl-mode=REQUIRED']);
});

test('schedule and destination input validation', () => {
	const s = parseScheduleInput({ name: 'Nightly', destinationId: 'd1', frequency: 'daily', hour: '3', minute: 30, keepLast: '7', keepDays: '' });
	assert.equal(s.hour, 3);
	assert.equal(s.keepLast, 7);
	assert.equal(s.keepDays, null);
	assert.equal(s.connectionId, null);
	assert.equal(s.compress, true);
	assert.throws(() => parseScheduleInput({ name: 'x', destinationId: 'd', frequency: 'monthly' }), /Frequency/);
	assert.throws(() => parseScheduleInput({ name: 'x', destinationId: 'd', frequency: 'daily', hour: 24 }), /Hour/);
	assert.throws(() => parseDestinationInput({ name: 'x', kind: 'local', config: { path: 'backups' } }), /absolute/);
	assert.throws(() => parseDestinationInput({ name: 'x', kind: 's3', config: { endpoint: 'ftp://x', bucket: 'b', accessKeyId: 'a' } }), /endpoint/);
	const d = parseDestinationInput({ name: 'm', kind: 's3', config: { endpoint: 'http://minio:9000', bucket: 'pgm', accessKeyId: 'a' }, secrets: { secretAccessKey: 'k' } });
	assert.equal(d.dest.kind === 's3' && d.dest.config.pathStyle, true);
	assert.equal(d.secrets.secretAccessKey, 'k');
	assert.equal(d.secrets.password, undefined);
});
