import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PGM_DATA_DIR = mkdtempSync(join(tmpdir(), 'pgm-size-test-'));
process.env.PGM_SECRET_KEY = 'test-key-for-size-history';
const store = await import('../src/lib/server/store.ts');
const sh = await import('../src/lib/server/size-history.ts');
const { HOUR, DAY } = sh;

test('rollupDaily keeps each UTC day’s last sample, at the start of the day', () => {
	const d0 = Date.UTC(2026, 0, 10);
	const out = sh.rollupDaily([
		{ at: d0 + 23 * HOUR, bytes: 300 },
		{ at: d0 + 1 * HOUR, bytes: 100 },
		{ at: d0 + DAY + 2 * HOUR, bytes: 400 },
		{ at: d0 + 5 * HOUR, bytes: 200 }
	]);
	assert.deepEqual(out, [
		{ at: d0, bytes: 300 },
		{ at: d0 + DAY, bytes: 400 }
	]);
});

test('mergeSeries: daily before the hourly window, hourly (or daily-reduced) after', () => {
	const now = Date.UTC(2026, 0, 31, 12);
	const firstHourly = sh.dayOf(now) - 13 * DAY;
	const hourly = Array.from({ length: 24 * 13 }, (_, i) => ({ at: firstHourly + i * HOUR, bytes: 1000 + i }));
	const daily = Array.from({ length: 30 }, (_, i) => ({ at: sh.dayOf(now) - (30 - i) * DAY, bytes: 500 + i }));
	const week = sh.mergeSeries(daily, hourly, now - 7 * DAY, true);
	assert.ok(week.every((p) => p.at >= now - 7 * DAY));
	assert.ok(week.length > 100, 'hourly resolution');
	const month = sh.mergeSeries(daily, hourly, now - 30 * DAY, false);
	const days = month.map((p) => p.at);
	assert.equal(new Set(days).size, days.length, 'one point per day');
	assert.ok(days.every((t) => t % DAY === 0));
	assert.ok(!month.some((p) => p.at >= firstHourly && p.bytes < 1000), 'no daily rollup inside the hourly window');
	assert.deepEqual(days, [...days].sort((a, b) => a - b));
});

test('tableGrowth: delta from the first sample; new tables grow from zero', () => {
	const g = sh.tableGrowth([
		{ at: 1, schema: 'public', name: 'events', bytes: 100 },
		{ at: 2, schema: 'public', name: 'events', bytes: 300 },
		{ at: 1, schema: 'public', name: 'users', bytes: 50 },
		{ at: 2, schema: 'public', name: 'users', bytes: 40 },
		{ at: 2, schema: 'public', name: 'new_table', bytes: 80 },
		{ at: 1, schema: 'public', name: 'dropped', bytes: 999 }
	]);
	assert.deepEqual(
		g.map((t) => [t.name, t.delta, t.deltaPct]),
		[
			['events', 200, 200],
			['new_table', 80, null],
			['users', -10, -20]
		]
	);
});

test('store: at most one sample per hour, rollup after 14 days, daily kept a year', () => {
	const c = store.createConnection({ name: 'a', host: 'db', port: 5432, database: 'app', user: 'app', sslMode: 'prefer', readOnly: true });
	const now = Date.UTC(2026, 5, 1, 12, 30);
	// 20 days of hourly samples, growing 1 MB/h, plus one ancient daily sample.
	const start = sh.dayOf(now) - 20 * DAY;
	for (let t = start, i = 0; t <= now; t += HOUR, i++) {
		sh.recordSample(c.id, 1e9 + i * 1e6, [{ schema: 'public', name: 'events', bytes: 1e8 + i * 1e5 }, { schema: 'public', name: 'static', bytes: 5e7 }], t);
	}
	assert.ok(sh.sampledThisHour(c.id, now));
	assert.ok(!sh.sampledThisHour(c.id, now + HOUR));
	// A second sample in the same hour replaces the first.
	sh.recordSample(c.id, 42, [], now + 60_000);
	const h = store.sqlite();
	assert.equal((h.prepare(`SELECT bytes FROM size_samples WHERE connection_id = ? AND resolution = 'h' AND at = ?`).get(c.id, sh.hourOf(now)) as { bytes: number }).bytes, 42);
	h.prepare(`INSERT INTO size_samples (connection_id, resolution, at, bytes) VALUES (?, 'd', ?, 1)`).run(c.id, now - 400 * DAY);

	sh.rollup(now);
	const cutoff = sh.dayOf(now - sh.RAW_RETENTION_MS);
	const oldestHourly = (h.prepare(`SELECT min(at) AS at FROM size_samples WHERE connection_id = ? AND resolution = 'h'`).get(c.id) as { at: number }).at;
	assert.equal(oldestHourly, cutoff);
	const daily = h.prepare(`SELECT at, bytes FROM size_samples WHERE connection_id = ? AND resolution = 'd' ORDER BY at`).all(c.id) as { at: number; bytes: number }[];
	assert.equal(daily.length, (cutoff - start) / DAY, 'one per rolled-up day; the 400-day-old one is gone');
	assert.equal(daily[0].at, start);
	assert.equal(daily[0].bytes, 1e9 + 23 * 1e6, 'the day’s last hourly sample');
	const tableDays = h.prepare(`SELECT count(DISTINCT at) AS n FROM table_size_samples WHERE connection_id = ? AND resolution = 'd'`).get(c.id) as { n: number };
	assert.equal(tableDays.n, daily.length);
	// Rolling up again is a no-op.
	sh.rollup(now);
	assert.equal((h.prepare(`SELECT count(*) AS n FROM size_samples WHERE connection_id = ? AND resolution = 'd'`).get(c.id) as { n: number }).n, daily.length);

	const g = sh.growth(c.id, '30d', now);
	assert.ok(g.series.length >= 20 && g.series.length <= 22);
	assert.equal(g.tables[0].name, 'events');
	assert.ok(g.tables[0].delta > 0);
	assert.equal(g.tables.find((t) => t.name === 'static')!.delta, 0);
	assert.equal(sh.growth(c.id, '7d', now).series.length, 7 * 24, 'hourly samples after now - 7d');
	const dayAgo = sh.hourOf(now - DAY); // 12:00 the day before; ask for 12:20
	assert.equal(sh.sizeNear(c.id, dayAgo + 20 * 60_000)!.bytes, 1e9 + ((dayAgo - start) / HOUR) * 1e6);
	assert.equal(sh.sizeNear(c.id, now - 100 * DAY), null);
	store.deleteConnection(c.id);
	assert.equal((h.prepare('SELECT count(*) AS n FROM size_samples').get() as { n: number }).n, 0, 'history goes with the connection');
});
