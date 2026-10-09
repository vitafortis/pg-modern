import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = mkdtempSync(join(tmpdir(), 'pgm-sqlite-test-'));
process.env.PGM_DATA_DIR = join(root, 'data');
process.env.PGM_SECRET_KEY = 'test-key-for-sqlite';
process.env.PGM_STATEMENT_TIMEOUT_MS = '4000';

const { readOnlyProblem, isDestructiveSqlite, sqliteExplainProblem, firstKeyword } = await import('../src/lib/server/sqlite/classify.ts');
const { splitRanges } = await import('../src/lib/sql-split.ts');
const files = await import('../src/lib/server/sqlite/files.ts');
const { tarReader, buildTar, headSink, parsePax } = await import('../src/lib/server/sqlite/tar.ts');
const client = await import('../src/lib/server/sqlite/client.ts');
const introspect = await import('../src/lib/server/sqlite/introspect.ts');
const { findSqliteFiles } = await import('../src/lib/server/sqlite/discover.ts');
const archive = await import('../src/lib/server/sqlite/archive.ts');
const store = await import('../src/lib/server/store.ts');
const { accessFor } = await import('../src/lib/server/permissions.ts');
const { parseConnectionInput } = await import('../src/lib/server/http.ts');

// --- classifier ------------------------------------------------------------------

test('read-only allowlist: reads pass, writes and file-touching statements are blocked', () => {
	for (const ok of [
		'SELECT * FROM t',
		'with x as (select 1) select * from x',
		'VALUES (1), (2)',
		'EXPLAIN QUERY PLAN SELECT * FROM t',
		'PRAGMA table_info(users)',
		'pragma main.journal_mode',
		'PRAGMA integrity_check',
		"SELECT replace(name, 'a', 'b') FROM t",
		"SELECT 'delete from t' AS s",
		'SELECT "update" FROM t',
		'-- just a comment'
	]) {
		assert.equal(readOnlyProblem(ok), null, ok);
	}
	for (const bad of [
		'INSERT INTO t VALUES (1)',
		'update t set x = 1',
		'DELETE FROM t',
		'REPLACE INTO t VALUES (1)',
		'WITH x AS (SELECT 1) DELETE FROM t',
		"VACUUM INTO '/tmp/copy.db'",
		'VACUUM',
		"ATTACH 'other.db' AS o",
		'DETACH o',
		'BEGIN',
		'COMMIT',
		'CREATE TABLE x (a)',
		'DROP TABLE t',
		'ALTER TABLE t ADD COLUMN b',
		'PRAGMA journal_mode = DELETE',
		'PRAGMA journal_mode(wal)',
		'PRAGMA query_only = 0',
		'PRAGMA wal_checkpoint',
		'PRAGMA optimize',
		'REINDEX',
		'ANALYZE',
		"SELECT load_extension('evil')",
		'EXPLAIN DELETE FROM t'
	]) {
		assert.ok(readOnlyProblem(bad), bad);
	}
});

test('destructive statements need confirmation', () => {
	assert.ok(isDestructiveSqlite('DROP TABLE t'));
	assert.ok(isDestructiveSqlite('delete from t'));
	assert.ok(isDestructiveSqlite('UPDATE t SET a = 1'));
	assert.ok(isDestructiveSqlite('WITH x AS (SELECT 1) DELETE FROM t'));
	assert.ok(isDestructiveSqlite('ALTER TABLE t DROP COLUMN b'));
	assert.ok(!isDestructiveSqlite('DELETE FROM t WHERE id = 1'));
	assert.ok(!isDestructiveSqlite("SELECT 'drop table t'"));
	assert.ok(!isDestructiveSqlite('INSERT INTO t VALUES (1)'));
});

test('explain: one statement, no ANALYZE', () => {
	assert.equal(sqliteExplainProblem(['SELECT 1'], false), null);
	assert.match(sqliteExplainProblem(['SELECT 1'], true)!, /no EXPLAIN ANALYZE/);
	assert.ok(sqliteExplainProblem(['SELECT 1', 'SELECT 2'], false));
	assert.ok(sqliteExplainProblem(['DROP TABLE t'], false));
	assert.equal(firstKeyword('/* c */ (select 1)'), '(');
});

test('splitter keeps trigger bodies and bracketed identifiers together', () => {
	const sql = `CREATE TRIGGER tr AFTER INSERT ON t BEGIN
		UPDATE t SET x = CASE WHEN 1 THEN 2 ELSE 3 END;
		INSERT INTO log VALUES (';');
	END;
	SELECT [a;b] FROM "x;y"; SELECT 2`;
	const parts = splitRanges(sql, 'sqlite').map((r) => r.text);
	assert.equal(parts.length, 3);
	assert.match(parts[0], /^CREATE TRIGGER[\s\S]*END$/);
	assert.equal(parts[1], 'SELECT [a;b] FROM "x;y"');
});

// --- file recognition ------------------------------------------------------------

test('magic header, names and app guessing', () => {
	assert.ok(files.isSqliteHeader(Buffer.from('SQLite format 3\0rest-of-header')));
	assert.ok(!files.isSqliteHeader(Buffer.from('SQLite format 2\0')));
	assert.ok(!files.isSqliteHeader(Buffer.from('short')));
	assert.ok(!files.isSqliteHeader(null));
	const wal = Buffer.alloc(100);
	files.SQLITE_MAGIC.copy(wal);
	wal[18] = 2;
	wal[19] = 2;
	assert.ok(files.headerSaysWal(wal));

	for (const n of ['sonarr.db', 'db.sqlite3', 'library.SQLITE', 'x.db3', 'home-assistant_v2.db', 'absdatabase.sqlite']) assert.ok(files.isSqliteCandidateName(n), n);
	for (const n of ['sonarr.db-wal', 'x.db-shm', 'x.db-journal', 'notes.txt', 'sonarr.db.bak', 'logs.db.1']) assert.ok(!files.isSqliteCandidateName(n), n);

	assert.equal(files.guessApp('/appdata/jellyfin/config/data/jellyfin.db'), 'Jellyfin');
	assert.equal(files.guessApp('/data/db.sqlite3'), undefined);
	assert.equal(files.guessApp('/srv/vaultwarden/data/db.sqlite3'), 'Vaultwarden');
	assert.equal(files.guessApp('/config/home-assistant_v2.db'), 'Home Assistant');
	assert.equal(files.guessApp('/app/data/kuma.db'), 'Uptime Kuma');
	assert.equal(files.guessApp('/opt/stacks/sonarr/config/sonarr.db'), 'Sonarr');
	assert.equal(files.guessApp('/opt/radarr/radarr.db'), 'Radarr');
	assert.equal(files.guessApp('/opt/prowlarr/prowlarr.db'), 'Prowlarr');
	assert.equal(files.candidateLabel('/x/sonarr.db'), 'Sonarr · sonarr.db');
	assert.equal(files.candidateLabel('/data/db.sqlite3', 'vaultwarden'), 'Vaultwarden · db.sqlite3');

	assert.ok(files.isNoiseDatabase('/config/profile/cert9.db'));
	assert.ok(files.isNoiseDatabase('/config/.mozilla/firefox/x/a169c491.sqlite'));
	assert.ok(files.isNoiseDatabase('/data/places.sqlite'));
	assert.ok(!files.isNoiseDatabase('/config/data/jellyfin.db'));

	assert.ok(files.isBulkMount('/media'));
	assert.ok(files.isBulkMount('/downloads/complete'));
	assert.ok(files.isBulkMount('/var/run/docker.sock'));
	assert.ok(!files.isBulkMount('/config'));
	assert.ok(!files.isBulkMount('/app/data'));
});

// --- tar -------------------------------------------------------------------------

function readAll(buf: Buffer, chunk: number) {
	const out: { name: string; size: number; type: string; data: Buffer }[] = [];
	const reader = tarReader((e) => {
		const parts: Buffer[] = [];
		return { data: (c) => parts.push(Buffer.from(c)), end: () => out.push({ name: e.name, size: e.size, type: e.type, data: Buffer.concat(parts) }) };
	});
	for (let i = 0; i < buf.length; i += chunk) reader.write(buf.subarray(i, i + chunk));
	return { out, done: reader.done };
}

test('tar reader: entries, data across chunk boundaries, PAX long names', () => {
	const big = Buffer.alloc(5000, 7);
	const longName = `config/${'deep/'.repeat(30)}app.db`;
	const tar = buildTar([
		{ name: 'config', type: 'directory' },
		{ name: 'config/sonarr.db', data: 'SQLite format 3\0hello' },
		{ name: 'config/big.bin', data: big },
		{ name: longName, data: 'x' },
		{ name: 'config/empty', data: '' }
	]);
	for (const chunk of [1, 7, 511, 512, 513, 4096, tar.length]) {
		const { out, done } = readAll(tar, chunk);
		assert.ok(done, `done at chunk ${chunk}`);
		assert.deepEqual(
			out.map((e) => [e.name, e.type, e.size]),
			[
				['config', 'directory', 0],
				['config/sonarr.db', 'file', 21],
				['config/big.bin', 'file', 5000],
				[longName, 'file', 1],
				['config/empty', 'file', 0]
			]
		);
		assert.ok(out[2].data.equals(big));
		assert.equal(out[1].data.toString(), 'SQLite format 3\0hello');
	}
});

test('tar reader: head sink, PAX records and bad checksums', () => {
	let head: Buffer | null = null;
	const reader = tarReader(() => headSink(16, (h) => (head = h)));
	reader.write(buildTar([{ name: 'a.db', data: Buffer.concat([files.SQLITE_MAGIC, Buffer.alloc(2000)]) }]));
	assert.ok(files.isSqliteHeader(head));
	assert.deepEqual(parsePax(Buffer.from('18 path=some/name\n11 size=42\n')), { path: 'some/name', size: '42' });
	const bad = buildTar([{ name: 'a', data: 'x' }]);
	bad[0] = 'z'.charCodeAt(0);
	assert.throws(() => tarReader(() => null).write(bad), /checksum/);
});

// --- a real database ---------------------------------------------------------------

const dbDir = join(root, 'files', 'sonarr');
mkdirSync(dbDir, { recursive: true });
const dbPath = join(dbDir, 'sonarr.db');
{
	const d = new DatabaseSync(dbPath);
	d.exec(`
		PRAGMA journal_mode = WAL;
		CREATE TABLE series (id INTEGER PRIMARY KEY, title TEXT NOT NULL UNIQUE, year INT CHECK (year > 1900), data BLOB);
		CREATE TABLE episodes (id INTEGER PRIMARY KEY, series_id INT NOT NULL REFERENCES series ON DELETE CASCADE, title TEXT, big INT);
		CREATE INDEX episodes_series ON episodes(series_id);
		CREATE VIEW recent AS SELECT * FROM series WHERE year > 2020;
		CREATE TRIGGER series_log AFTER INSERT ON series BEGIN SELECT 1; END;
		INSERT INTO series (title, year, data) VALUES ('Severance', 2022, x'cafe'), ('The Wire', 2002, NULL), ('Andor', 2022, NULL);
		INSERT INTO episodes (series_id, title, big) VALUES (1, 'Good News About Hell', 9007199254740993), (1, 'Half Loop', 2), (2, 'The Target', 3);
	`);
	d.close();
}

const conn = store.createConnection(parseConnectionInput({ engine: 'sqlite', path: dbPath, readOnly: true, name: 'sonarr' }), 'sqlite');
const admin = store.createUser({ email: 'admin@x.io', role: 'admin' });

test('connection input: SQLite is a path; the data dir is off limits', () => {
	assert.equal(conn.engine, 'sqlite');
	assert.equal(conn.database, dbPath);
	assert.equal(conn.port, 0);
	assert.throws(() => parseConnectionInput({ engine: 'sqlite', path: 'relative.db' }), /absolute/);
	assert.throws(() => parseConnectionInput({ engine: 'sqlite', path: join(process.env.PGM_DATA_DIR!, 'pg-modern.db') }), /data folder/);
});

test('read-only scripts: reads run, writes are rejected before anything runs', async () => {
	const ok = await client.runScript(conn.id, "SELECT title, data FROM series ORDER BY id; SELECT big FROM episodes WHERE id = 1; PRAGMA table_info('series')", { readOnly: true });
	assert.equal(ok.error, undefined);
	assert.equal(ok.results.length, 3);
	assert.deepEqual(ok.results[0].rows[0], ['Severance', '0xcafe']);
	assert.equal(ok.results[0].fields[0].type, 'text');
	assert.equal(ok.results[1].rows[0][0], '9007199254740993', 'big integers keep their precision');
	assert.ok(ok.results[0].readOnly);

	for (const sql of ["INSERT INTO series (title) VALUES ('x')", "VACUUM INTO '/tmp/pgm-escape.db'", "ATTACH '/tmp/x.db' AS x", 'SELECT 1; DELETE FROM series']) {
		const r = await client.runScript(conn.id, sql, { readOnly: true });
		assert.ok(r.error, sql);
		assert.equal(r.results.length, 0, `${sql}: nothing ran`);
	}
	assert.ok(!existsSync('/tmp/pgm-escape.db'));
	const count = await client.runScript(conn.id, 'SELECT count(*) FROM series', { readOnly: true });
	assert.equal(count.results[0].rows[0][0], 3);
});

test('row caps, errors and cancel', async () => {
	const capped = await client.runScript(conn.id, 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT 100) SELECT i FROM n', { readOnly: true, maxRows: 10 });
	assert.equal(capped.results[0].rows.length, 10);
	assert.ok(capped.results[0].truncated);
	assert.equal(capped.results[0].rowCount, null);

	const bad = await client.runScript(conn.id, 'SELECT 1; SELECT nope FROM series', { readOnly: true });
	assert.equal(bad.results.length, 1);
	assert.equal(bad.error?.statementIndex, 1);
	assert.match(bad.error!.message, /no such column/);

	const runId = 'run-1';
	const slow = client.runScript(conn.id, 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n WHERE i % 2 = 0 AND i < 0', { readOnly: true, runId });
	await new Promise((r) => setTimeout(r, 150));
	// count(*) runs in one step; termination lands when it yields, or the statement timeout stops it.
	assert.ok(await client.cancelRun(conn.id, runId));
	const out = await slow;
	assert.ok(out.error);
	assert.match(out.error!.message, /Cancelled|timed out/);
});

test('writes with write access; transactions left open are rolled back', async () => {
	const w = await client.runScript(conn.id, "INSERT INTO series (title, year) VALUES ('Dark', 2017); BEGIN; INSERT INTO series (title, year) VALUES ('Lost', 2004)", { readOnly: false });
	assert.equal(w.error, undefined);
	assert.equal(w.results[0].rowCount, 1);
	const r = await client.runScript(conn.id, 'SELECT title FROM series ORDER BY id', { readOnly: true });
	assert.deepEqual(
		r.results[0].rows.map((x) => x[0]),
		['Severance', 'The Wire', 'Andor', 'Dark']
	);
	const fk = await client.runScript(conn.id, 'INSERT INTO episodes (series_id, title) VALUES (999, ?)', { readOnly: false });
	assert.ok(fk.error, 'foreign keys are enforced');
});

test('introspection: tree, structure, browse, diagram, overview, completion', async () => {
	client.closePool(conn.id);
	const tree = await introspect.schemaTree(conn.id);
	assert.equal(tree.schemas[0].name, 'main');
	const rels = Object.fromEntries(tree.schemas[0].relations.map((r) => [r.name, r]));
	assert.equal(rels.series.estimatedRows, 4);
	assert.equal(rels.recent.kind, 'view');
	assert.ok((rels.series.sizeBytes ?? 0) > 0);

	const s = await introspect.structure(conn.id, 'main', 'episodes');
	assert.deepEqual(
		s.columns.map((c) => [c.name, c.isPrimaryKey]),
		[
			['id', true],
			['series_id', false],
			['title', false],
			['big', false]
		]
	);
	assert.ok(s.indexes.some((i) => i.name === 'episodes_series'));
	assert.ok(s.constraints.some((c) => c.type === 'foreign key' && /REFERENCES "series"/.test(c.def) && /ON DELETE CASCADE/.test(c.def)));
	const series = await introspect.structure(conn.id, 'main', 'series');
	assert.ok(series.referencedBy.some((r) => r.from_table === 'episodes'));
	assert.ok(series.triggers.some((t) => t.name === 'series_log'));
	assert.ok(series.constraints.some((c) => c.type === 'check'));
	assert.ok(series.constraints.some((c) => c.type === 'unique'));

	const page = await introspect.browse(conn.id, { schema: 'main', table: 'series', limit: 2, offset: 0, sort: 'title', dir: 'desc', filters: [{ column: 'year', op: '>=', value: '2017' }] });
	assert.deepEqual(
		page.rows.map((r) => r[1]),
		['Severance', 'Dark']
	);
	assert.equal(page.total, 3);
	const search = await introspect.browse(conn.id, { schema: 'main', table: 'series', limit: 10, offset: 0, filters: [], search: 'wire' });
	assert.equal(search.total, 1);

	const d = await introspect.diagram(conn.id, 'main');
	assert.deepEqual(
		d.foreignKeys.map((f) => [f.fromTable, f.fromColumns, f.toTable, f.toColumns]),
		[['episodes', ['series_id'], 'series', ['id']]]
	);
	const o = await introspect.overview(conn.id);
	assert.equal(o.journalMode, 'wal');
	assert.equal(o.counts.tables, 2);
	assert.equal(o.counts.views, 1);
	assert.equal(o.app, 'Sonarr');
	assert.ok(o.pageSize > 0);
	const comp = await introspect.completionSchema(conn.id);
	assert.ok(comp.some((t) => t.table === 'episodes' && t.columns.includes('series_id')));

	const plan = await client.explainSqlite(conn.id, 'SELECT * FROM episodes WHERE series_id = 1', { analyze: false, readOnly: true });
	assert.match(plan.plan, /QUERY PLAN\n`--SEARCH episodes USING INDEX episodes_series/);
});

test('plan text renders the tree like the sqlite3 shell', () => {
	assert.equal(
		client.planText([
			{ id: 2, parent: 0, detail: 'SCAN a' },
			{ id: 5, parent: 0, detail: 'CORRELATED SUBQUERY 1' },
			{ id: 7, parent: 5, detail: 'SEARCH b' }
		]),
		'QUERY PLAN\n|--SCAN a\n`--CORRELATED SUBQUERY 1\n   `--SEARCH b'
	);
});

test('WAL database in a read-only folder without -shm explains itself', async () => {
	const dir = join(root, 'ro-wal');
	mkdirSync(dir);
	const p = join(dir, 'app.db');
	const d = new DatabaseSync(p);
	d.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1);');
	d.close();
	chmodSync(dir, 0o555);
	try {
		const c = store.createConnection(parseConnectionInput({ engine: 'sqlite', path: p }), 'sqlite');
		const r = await client.runScript(c.id, 'SELECT * FROM t', { readOnly: true });
		assert.ok(r.error);
		assert.match(r.error!.hint ?? '', /WAL mode/);
		assert.match(client.openHint('SQLITE_NOTADB', null)!, /isn’t a SQLite database/);
	} finally {
		chmodSync(dir, 0o755);
	}
});

test('discovery walks folders and confirms the header', async () => {
	writeFileSync(join(dbDir, 'fake.db'), 'not a database at all, just text');
	const found = await findSqliteFiles(join(root, 'files'), 3);
	assert.deepEqual(
		found.map((f) => f.path),
		[dbPath]
	);
	assert.ok(found[0].wal);
});

// --- Docker archive API (against a fake engine) -----------------------------------

function fakeDocker(fsMap: Record<string, Buffer>, seen: string[]): Promise<{ server: Server; endpoint: string }> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			const url = new URL(req.url!, 'http://docker');
			seen.push(`${req.method} ${url.pathname}${url.searchParams.get('path') ? ` ${url.searchParams.get('path')}` : ''}`);
			if (url.pathname === '/containers/kuma/json') return res.end(JSON.stringify({ Id: 'abc123' }));
			const m = /^\/containers\/([^/]+)\/archive$/.exec(url.pathname);
			if (!m) return res.writeHead(404).end('{}');
			const path = url.searchParams.get('path')!;
			const isDir = Object.keys(fsMap).some((k) => k.startsWith(`${path}/`));
			const file = fsMap[path];
			if (!isDir && !file) return res.writeHead(404).end('{"message":"no such file"}');
			const stat = { name: path.split('/').pop(), size: file?.length ?? 4096, mode: isDir ? 2 ** 31 + 0o755 : 0o644, mtime: '2026-10-09T00:00:00Z', linkTarget: '' };
			res.setHeader('X-Docker-Container-Path-Stat', Buffer.from(JSON.stringify(stat)).toString('base64'));
			if (req.method === 'HEAD') return res.end();
			const base = path.split('/').pop()!;
			const entries = isDir
				? Object.entries(fsMap)
						.filter(([k]) => k.startsWith(`${path}/`))
						.map(([k, data]) => ({ name: `${base}/${k.slice(path.length + 1)}`, data }))
				: [{ name: base, data: file }];
			res.setHeader('Content-Type', 'application/x-tar');
			res.end(buildTar(entries));
		});
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as { port: number }).port;
			resolve({ server, endpoint: `tcp://127.0.0.1:${port}` });
		});
	});
}

test('archive discovery and snapshots through the Docker API', async () => {
	// A live WAL database: some rows only exist in the -wal file.
	const src = join(root, 'kuma-src');
	mkdirSync(src);
	const live = new DatabaseSync(join(src, 'kuma.db'));
	live.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE monitor (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO monitor (name) VALUES (\'home\'), (\'nas\');');
	const fsMap: Record<string, Buffer> = {
		'/app/data/kuma.db': readFileSync(join(src, 'kuma.db')),
		'/app/data/kuma.db-wal': readFileSync(join(src, 'kuma.db-wal')),
		'/app/data/notes.txt': Buffer.from('hello'),
		'/app/data/upload/logo.db': Buffer.from('not sqlite')
	};
	live.close();
	const seen: string[] = [];
	const { server, endpoint } = await fakeDocker(fsMap, seen);
	try {
		const listed = await archive.listDatabases(endpoint, 'abc123', '/app/data', { maxBytes: 1e7, maxEntries: 100, timeoutMs: 5000, maxDepth: 5 });
		assert.deepEqual(
			listed.found.map((f) => [f.path, f.wal]),
			[['/app/data/kuma.db', true]]
		);

		store.saveSettings({ ...store.getSettings(), sqliteArchive: false });
		const off = await archive.discoverArchive(endpoint, { id: 'abc123', name: 'kuma', label: 'kuma', state: 'running', mounts: [{ Type: 'volume', Source: '/var/lib/docker/volumes/kuma/_data', Destination: '/app/data' }] });
		assert.equal(off.candidates.length, 1, 'discoverArchive itself does not check the setting; containerSqlite does');
		assert.ok(seen.includes('HEAD /containers/abc123/archive /app/data/kuma.db'), 'known paths are stat-ed with HEAD');
		assert.ok(seen.every((s) => s.startsWith('GET') || s.startsWith('HEAD')), 'only GET/HEAD requests');
		const cand = off.candidates[0];
		assert.equal(cand.sqlite?.via, 'archive');
		assert.equal(cand.name, 'Uptime Kuma · kuma.db');

		const c = store.createConnection({ engine: 'sqlite', name: 'kuma', host: '', port: 0, database: '', user: '', sslMode: 'disable', readOnly: true }, 'sqlite');
		store.setSqliteSnapshot(c.id, { endpoint, container: 'kuma', containerId: 'old', containerPath: '/app/data/kuma.db', takenAt: null, bytes: null, wal: false, error: null });
		await assert.rejects(archive.refreshSnapshot(c.id), /turned off/);
		store.saveSettings({ ...store.getSettings(), sqliteArchive: true, sqliteSnapshotMaxMb: 512 });
		const snap = await archive.refreshSnapshot(c.id);
		assert.ok(snap.takenAt);
		assert.ok(snap.wal);
		assert.equal(snap.containerId, 'abc123', 'resolved by container name');
		const saved = store.getConnection(c.id)!;
		assert.ok(saved.database.startsWith(join(process.env.PGM_DATA_DIR!, 'sqlite-snapshots')));
		assert.ok(!existsSync(`${saved.database}-wal`), 'the -wal was merged into the copy');
		assert.deepEqual(accessFor(admin, saved), { write: 'never', unlockedUntil: null, readOnly: true });

		const rows = await client.runScript(c.id, 'SELECT name FROM monitor ORDER BY id', { readOnly: true });
		assert.deepEqual(
			rows.results[0].rows.map((r) => r[0]),
			['home', 'nas'],
			'rows that were only in the -wal are in the snapshot'
		);
		const write = await client.runScript(c.id, "INSERT INTO monitor (name) VALUES ('x')", { readOnly: false });
		assert.ok(write.error, 'snapshots are read-only even when asked for writes');

		store.saveSettings({ ...store.getSettings(), sqliteSnapshotMaxMb: 1 });
		fsMap['/app/data/kuma.db'] = Buffer.concat([fsMap['/app/data/kuma.db'], Buffer.alloc(2 * 1024 * 1024)]);
		await assert.rejects(archive.refreshSnapshot(c.id), /over the 1 MB snapshot limit/);
		assert.match(store.getSqliteSnapshot(c.id)!.error!, /snapshot limit/);
		assert.ok(store.getSqliteSnapshot(c.id)!.takenAt, 'the previous snapshot stays usable');
		await assert.rejects(client.writeTransaction(c.id, [{ sql: 'DELETE FROM monitor' }]), /read-only snapshot/);
	} finally {
		server.close();
	}
});

test('write transactions commit all or nothing', async () => {
	const ok = await client.writeTransaction(conn.id, [
		{ sql: 'INSERT INTO series (title, year) VALUES (?, ?)', params: ['Slow Horses', 2022] },
		{ sql: 'UPDATE series SET year = ? WHERE title = ?', params: [2023, 'Slow Horses'] }
	]);
	assert.deepEqual(ok.changes, [1, 1]);
	await assert.rejects(
		client.writeTransaction(conn.id, [
			{ sql: 'INSERT INTO series (title) VALUES (?)', params: ['Ripley'] },
			{ sql: 'INSERT INTO series (title) VALUES (?)', params: ['Ripley'] }
		]),
		/UNIQUE/
	);
	const r = await client.runScript(conn.id, "SELECT count(*) FROM series WHERE title IN ('Slow Horses', 'Ripley')", { readOnly: true });
	assert.equal(r.results[0].rows[0][0], 1);
});
