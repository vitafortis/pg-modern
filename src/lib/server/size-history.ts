/**
 * Size history: hourly samples of each connection's database size and its largest
 * tables, rolled up to one sample per UTC day after 14 days and kept for a year.
 */
import { sqlite } from './store.ts';
import type { GrowthData, GrowthRange, SizePoint, TableGrowth } from '#lib/alerts.ts';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** Hourly samples are kept this long, then rolled up to daily ones. */
export const RAW_RETENTION_MS = 14 * DAY;
export const DAILY_RETENTION_MS = 366 * DAY;
export const TOP_TABLES = 50;

export const hourOf = (t: number) => Math.floor(t / HOUR) * HOUR;
export const dayOf = (t: number) => Math.floor(t / DAY) * DAY;

const RANGE_MS: Record<GrowthRange, number> = { '7d': 7 * DAY, '30d': 30 * DAY, '1y': 365 * DAY };

export interface TableSample {
	schema: string;
	name: string;
	bytes: number;
}

// --- pure helpers (tested) -----------------------------------------------------------

/** One point per UTC day: the day's last sample (sizes are levels, not counters). */
export function rollupDaily(points: SizePoint[]): SizePoint[] {
	const byDay = new Map<number, SizePoint>();
	for (const p of points) {
		const day = dayOf(p.at);
		const cur = byDay.get(day);
		if (!cur || p.at >= cur.at) byDay.set(day, p);
	}
	return [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([day, p]) => ({ at: day, bytes: p.bytes }));
}

/**
 * Merges daily rollups and hourly samples into one series over [from, now]. Short
 * ranges keep hourly resolution; longer ones are reduced to daily points so the
 * chart has an even density.
 */
export function mergeSeries(daily: SizePoint[], hourly: SizePoint[], from: number, hourlyResolution: boolean): SizePoint[] {
	const firstHourly = hourly.length ? hourly[0].at : Infinity;
	const older = daily.filter((p) => p.at >= dayOf(from) && p.at + DAY <= firstHourly);
	const recent = hourly.filter((p) => p.at >= from);
	if (hourlyResolution) return [...older, ...recent].sort((a, b) => a.at - b.at);
	return rollupDaily([...older, ...recent]);
}

/**
 * Growth per table between the first and last sample in a range, for tables in the
 * latest sample. A table first seen inside the range grows from zero (deltaPct null).
 */
export function tableGrowth(samples: { at: number; schema: string; name: string; bytes: number }[], limit = 15): TableGrowth[] {
	if (!samples.length) return [];
	const last = Math.max(...samples.map((s) => s.at));
	const first = Math.min(...samples.map((s) => s.at));
	const key = (s: { schema: string; name: string }) => `${s.schema}\u0000${s.name}`;
	const earliest = new Map<string, { at: number; bytes: number }>();
	for (const s of samples) {
		const e = earliest.get(key(s));
		if (!e || s.at < e.at) earliest.set(key(s), { at: s.at, bytes: s.bytes });
	}
	return samples
		.filter((s) => s.at === last)
		.map((s) => {
			const e = earliest.get(key(s))!;
			const existedAtStart = e.at === first;
			const base = existedAtStart ? e.bytes : 0;
			return {
				schema: s.schema,
				name: s.name,
				bytes: s.bytes,
				delta: s.bytes - base,
				deltaPct: existedAtStart && base > 0 ? Math.round(((s.bytes - base) / base) * 1000) / 10 : null
			};
		})
		.sort((a, b) => b.delta - a.delta || b.bytes - a.bytes)
		.slice(0, limit);
}

// --- store ---------------------------------------------------------------------------

/** Whether this connection already has a sample for the hour containing `now`. */
export function sampledThisHour(connectionId: string, now = Date.now()): boolean {
	return !!sqlite().prepare(`SELECT 1 FROM size_samples WHERE connection_id = ? AND resolution = 'h' AND at = ?`).get(connectionId, hourOf(now));
}

/** Stores one sample (at most one per hour: a second one in the same hour replaces the first). */
export function recordSample(connectionId: string, dbBytes: number, tables: TableSample[], now = Date.now()) {
	const h = sqlite();
	const at = hourOf(now);
	h.exec('BEGIN');
	try {
		h.prepare(`INSERT OR REPLACE INTO size_samples (connection_id, resolution, at, bytes) VALUES (?, 'h', ?, ?)`).run(connectionId, at, Math.round(dbBytes));
		h.prepare(`DELETE FROM table_size_samples WHERE connection_id = ? AND resolution = 'h' AND at = ?`).run(connectionId, at);
		const ins = h.prepare(
			`INSERT OR REPLACE INTO table_size_samples (connection_id, resolution, at, schema_name, table_name, bytes) VALUES (?, 'h', ?, ?, ?, ?)`
		);
		for (const t of tables.slice(0, TOP_TABLES)) ins.run(connectionId, at, t.schema, t.name, Math.round(t.bytes));
		h.exec('COMMIT');
	} catch (err) {
		h.exec('ROLLBACK');
		throw err;
	}
}

/**
 * Rolls hourly samples older than 14 days into daily ones (the day's last sample) and
 * drops daily samples older than a year. Only whole days are rolled up, so a day is
 * never split between the two resolutions.
 */
export function rollup(now = Date.now()) {
	const h = sqlite();
	const cutoff = dayOf(now - RAW_RETENTION_MS);
	h.exec('BEGIN');
	try {
		const rows = h
			.prepare(`SELECT connection_id, at, bytes FROM size_samples WHERE resolution = 'h' AND at < ? ORDER BY connection_id, at`)
			.all(cutoff) as { connection_id: string; at: number; bytes: number }[];
		const byConn = new Map<string, SizePoint[]>();
		for (const r of rows) {
			if (!byConn.has(r.connection_id)) byConn.set(r.connection_id, []);
			byConn.get(r.connection_id)!.push({ at: r.at, bytes: r.bytes });
		}
		const putDay = h.prepare(`INSERT OR REPLACE INTO size_samples (connection_id, resolution, at, bytes) VALUES (?, 'd', ?, ?)`);
		for (const [conn, points] of byConn) for (const p of rollupDaily(points)) putDay.run(conn, p.at, p.bytes);

		// Tables: keep each day's last hourly sample as that day's.
		const lastPerDay = h
			.prepare(
				`SELECT connection_id, max(at) AS at FROM table_size_samples WHERE resolution = 'h' AND at < ?
				 GROUP BY connection_id, (at / ${DAY})`
			)
			.all(cutoff) as { connection_id: string; at: number }[];
		const copy = h.prepare(
			`INSERT OR REPLACE INTO table_size_samples (connection_id, resolution, at, schema_name, table_name, bytes)
			 SELECT connection_id, 'd', ?, schema_name, table_name, bytes FROM table_size_samples WHERE connection_id = ? AND resolution = 'h' AND at = ?`
		);
		for (const r of lastPerDay) copy.run(dayOf(r.at), r.connection_id, r.at);

		h.prepare(`DELETE FROM size_samples WHERE resolution = 'h' AND at < ?`).run(cutoff);
		h.prepare(`DELETE FROM table_size_samples WHERE resolution = 'h' AND at < ?`).run(cutoff);
		h.prepare(`DELETE FROM size_samples WHERE resolution = 'd' AND at < ?`).run(now - DAILY_RETENTION_MS);
		h.prepare(`DELETE FROM table_size_samples WHERE resolution = 'd' AND at < ?`).run(now - DAILY_RETENTION_MS);
		h.exec('COMMIT');
	} catch (err) {
		h.exec('ROLLBACK');
		throw err;
	}
}

function points(connectionId: string, resolution: 'h' | 'd', from: number): SizePoint[] {
	return sqlite()
		.prepare(`SELECT at, bytes FROM size_samples WHERE connection_id = ? AND resolution = ? AND at >= ? ORDER BY at`)
		.all(connectionId, resolution, resolution === 'd' ? dayOf(from) : from) as unknown as SizePoint[];
}

/** The size sample closest to `at` (within `toleranceMs`), for growth alerts. */
export function sizeNear(connectionId: string, at: number, toleranceMs = 3 * HOUR): SizePoint | null {
	const row = sqlite()
		.prepare(
			`SELECT at, bytes FROM size_samples WHERE connection_id = ? AND at BETWEEN ? AND ?
			 ORDER BY abs(at - ?), resolution = 'd' LIMIT 1`
		)
		.get(connectionId, at - toleranceMs, at + toleranceMs, at) as SizePoint | undefined;
	return row ? { at: row.at, bytes: row.bytes } : null;
}

export function growth(connectionId: string, range: GrowthRange, now = Date.now()): GrowthData {
	const from = now - RANGE_MS[range];
	const hourly = points(connectionId, 'h', from);
	const daily = points(connectionId, 'd', from);
	const series = mergeSeries(daily, hourly, from, range === '7d');

	const h = sqlite();
	const firstHourly = hourly[0]?.at ?? Infinity;
	// Table samples: daily rollups before the hourly window, then hourly ones.
	const tableRows = h
		.prepare(
			`SELECT at, schema_name AS schema, table_name AS name, bytes FROM table_size_samples
			 WHERE connection_id = ? AND ((resolution = 'd' AND at >= ? AND at + ${DAY} <= ?) OR (resolution = 'h' AND at >= ?))`
		)
		.all(connectionId, dayOf(from), firstHourly === Infinity ? Number.MAX_SAFE_INTEGER : firstHourly, from) as {
		at: number;
		schema: string;
		name: string;
		bytes: number;
	}[];
	const last = h.prepare(`SELECT max(at) AS at FROM size_samples WHERE connection_id = ? AND resolution = 'h'`).get(connectionId) as {
		at: number | null;
	};
	return { range, series, tables: tableGrowth(tableRows), lastSampleAt: last?.at ?? series.at(-1)?.at ?? null };
}
