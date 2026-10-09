/**
 * Health checks: the API shape, the catalog of checks per engine, and the pure
 * classification helpers shared by the server (which runs the checks) and the
 * Health tab. Nothing here talks to a database.
 */

export type Severity = 'info' | 'warn' | 'critical';

/** Engines the Health tab knows about; other engines (e.g. SQLite) don't get the tab. */
export type HealthEngine = 'postgres' | 'mysql';

export function healthSupported(engine: string | null | undefined): engine is HealthEngine {
	return engine === 'postgres' || engine === 'mysql';
}

export interface Finding {
	severity: Severity;
	title: string;
	/** Plain-language explanation of why this matters. */
	explanation: string;
	/** Tables, indexes, sessions … this is about (display names). */
	objects: string[];
	/** Suggested SQL — never run automatically. */
	fix?: string;
}

export interface CheckResult {
	id: string;
	title: string;
	/** `ok`: ran and found nothing; `skipped`: couldn't apply here (e.g. statistics are off). */
	status: 'ok' | 'findings' | 'error' | 'skipped';
	findings: Finding[];
	/** Why the check failed (permission denied, timeout …); the other checks still ran. */
	error?: string;
	/** A short summary for passing checks, or context (e.g. when statistics were reset). */
	note?: string;
	/** More findings existed than were returned. */
	truncated?: boolean;
	durationMs: number;
}

export interface HealthReport {
	engine: HealthEngine;
	ranAt: string;
	durationMs: number;
	checks: CheckResult[];
}

export interface CheckInfo {
	id: string;
	title: string;
	description: string;
	engines: HealthEngine[];
}

/** Every check, with the engines it runs on (also the order the tab shows them in). */
export const HEALTH_CHECKS: CheckInfo[] = [
	{ id: 'wraparound', title: 'Transaction ID wraparound', description: 'How close databases and tables are to the 2-billion transaction ID limit.', engines: ['postgres'] },
	{ id: 'sequences', title: 'Sequences near exhaustion', description: 'Sequences (and the columns they fill) about to run out of values.', engines: ['postgres'] },
	{ id: 'invalid-indexes', title: 'Invalid indexes', description: 'Indexes left behind by a failed CREATE INDEX CONCURRENTLY.', engines: ['postgres'] },
	{ id: 'idle-in-transaction', title: 'Idle in transaction', description: 'Sessions holding a transaction open while doing nothing.', engines: ['postgres'] },
	{ id: 'long-transactions', title: 'Long-running transactions', description: 'InnoDB transactions open for minutes or more.', engines: ['mysql'] },
	{ id: 'connections', title: 'Connection usage', description: 'Client connections compared to max_connections.', engines: ['postgres', 'mysql'] },
	{ id: 'cache-hit', title: 'Cache hit ratio', description: 'How often reads are served from memory instead of disk.', engines: ['postgres', 'mysql'] },
	{ id: 'vacuum', title: 'Vacuum and analyze', description: 'Tables with many dead rows, or never/long-not vacuumed or analyzed.', engines: ['postgres'] },
	{ id: 'bloat', title: 'Table bloat (estimate)', description: 'Space tables use beyond what their rows need, estimated from statistics.', engines: ['postgres'] },
	{ id: 'fragmentation', title: 'Fragmentation', description: 'Free space inside table files (data_free).', engines: ['mysql'] },
	{ id: 'unused-indexes', title: 'Unused indexes', description: 'Indexes never used for a scan since statistics were last reset.', engines: ['postgres', 'mysql'] },
	{ id: 'duplicate-indexes', title: 'Duplicate and overlapping indexes', description: 'Indexes whose columns are the same as, or a prefix of, another index.', engines: ['postgres', 'mysql'] },
	{ id: 'missing-indexes', title: 'Possibly missing indexes', description: 'Large tables read mostly by sequential scans.', engines: ['postgres'] },
	{ id: 'fk-indexes', title: 'Foreign keys without an index', description: 'Foreign keys whose referencing columns have no supporting index.', engines: ['postgres'] },
	{ id: 'primary-keys', title: 'Tables without a primary key', description: 'Tables without a primary key.', engines: ['postgres', 'mysql'] },
	{ id: 'storage-engines', title: 'Non-InnoDB tables', description: 'Tables using MyISAM, Aria, MEMORY or other non-transactional engines.', engines: ['mysql'] },
	{ id: 'settings', title: 'Settings sanity', description: 'Defaults that are often worth revisiting.', engines: ['postgres'] }
];

export function checksFor(engine: HealthEngine): CheckInfo[] {
	return HEALTH_CHECKS.filter((c) => c.engines.includes(engine));
}

export function checkInfo(id: string): CheckInfo | undefined {
	return HEALTH_CHECKS.find((c) => c.id === id);
}

const RANK: Record<Severity, number> = { critical: 3, warn: 2, info: 1 };

export function severityRank(s: Severity | null | undefined): number {
	return s ? RANK[s] : 0;
}

/** The more severe of two (null = no problem). */
export function worst(a: Severity | null, b: Severity | null): Severity | null {
	return severityRank(a) >= severityRank(b) ? a : b;
}

export interface HealthSummary {
	critical: number;
	warn: number;
	info: number;
	/** Checks that failed to run. */
	errors: number;
	/** Checks that ran and found nothing. */
	passed: number;
	skipped: number;
}

export function summarizeHealth(checks: CheckResult[]): HealthSummary {
	const s: HealthSummary = { critical: 0, warn: 0, info: 0, errors: 0, passed: 0, skipped: 0 };
	for (const c of checks) {
		if (c.status === 'error') s.errors++;
		else if (c.status === 'skipped') s.skipped++;
		else if (c.status === 'ok' || c.findings.length === 0) s.passed++;
		for (const f of c.findings) s[f.severity]++;
	}
	return s;
}

/** Worst severity among a check's findings. */
export function checkSeverity(c: CheckResult): Severity | null {
	return c.findings.reduce<Severity | null>((acc, f) => worst(acc, f.severity), null);
}

/** Checks ordered for display: errors and the most severe findings first, passing checks last. */
export function sortChecks(checks: CheckResult[]): CheckResult[] {
	const order = new Map(HEALTH_CHECKS.map((c, i) => [c.id, i]));
	const weight = (c: CheckResult) => (c.status === 'findings' ? 10 + severityRank(checkSeverity(c)) : c.status === 'error' ? 5 : c.status === 'skipped' ? 1 : 0);
	return [...checks].sort((a, b) => weight(b) - weight(a) || (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
}

// --- thresholds and classification ------------------------------------------------

export const MB = 1024 * 1024;
export const GB = 1024 * MB;
/** Transaction IDs Postgres can hand out before it must stop to avoid wraparound. */
export const XID_LIMIT = 2 ** 31;

/** Unused indexes smaller than this aren't worth a finding. */
export const UNUSED_INDEX_MIN_BYTES = 1 * MB;

/** Unused index: bigger ones cost more on every write. Recently reset statistics make it a softer hint. */
export function unusedIndexSeverity(bytes: number, statsAgeDays: number | null): Severity | null {
	if (bytes < UNUSED_INDEX_MIN_BYTES) return null;
	if (statsAgeDays != null && statsAgeDays < 7) return 'info';
	return bytes >= 100 * MB ? 'warn' : 'info';
}

/** age(datfrozenxid) / relfrozenxid: share of the ~2.1 billion limit used. */
export function wraparoundSeverity(age: number): Severity | null {
	const used = age / XID_LIMIT;
	if (used >= 0.6) return 'critical';
	if (used >= 0.3) return 'warn';
	return null;
}

export interface SequenceState {
	last: number;
	min: number;
	max: number;
	increment: number;
	/** Type of the column the sequence fills, which may be narrower than the sequence. */
	columnType?: string | null;
}

const TYPE_MAX: Record<string, number> = { smallint: 32767, integer: 2147483647, bigint: 9223372036854775807 };

/** Upper bound for values a column of this type accepts (null when not an integer type). */
export function integerTypeMax(type: string | null | undefined): number | null {
	if (!type) return null;
	const t = type.toLowerCase().trim();
	if (t === 'smallint' || t === 'int2' || t === 'smallserial') return TYPE_MAX.smallint;
	if (t === 'integer' || t === 'int' || t === 'int4' || t === 'serial') return TYPE_MAX.integer;
	if (t === 'bigint' || t === 'int8' || t === 'bigserial') return TYPE_MAX.bigint;
	return null;
}

/** Share of a sequence's range used (0–1), counting the column's type limit when it's lower. */
export function sequenceUsage(s: SequenceState): number {
	const colMax = integerTypeMax(s.columnType);
	if (s.increment < 0) {
		const colMin = colMax == null ? null : -colMax - 1;
		const min = colMin == null ? s.min : Math.max(s.min, colMin);
		const span = s.max - min;
		return span > 0 ? Math.min(1, Math.max(0, (s.max - s.last) / span)) : 1;
	}
	const max = colMax == null ? s.max : Math.min(s.max, colMax);
	const span = max - s.min;
	return span > 0 ? Math.min(1, Math.max(0, (s.last - s.min) / span)) : 1;
}

export function sequenceSeverity(usage: number): Severity | null {
	if (usage >= 0.9) return 'critical';
	if (usage >= 0.75) return 'warn';
	return null;
}

/** Cache hit ratio (0–1); null when there's too little traffic to judge. */
export function cacheHitSeverity(ratio: number | null, totalReads: number): Severity | null {
	if (ratio == null || totalReads < 10_000) return null;
	if (ratio < 0.9) return 'warn';
	if (ratio < 0.99) return 'info';
	return null;
}

export function connectionSeverity(used: number, max: number): Severity | null {
	if (max <= 0) return null;
	const r = used / max;
	if (r >= 0.9) return 'critical';
	if (r >= 0.75) return 'warn';
	return null;
}

/** Seconds a session has sat idle in a transaction (Postgres) or a transaction has run (InnoDB). */
export function transactionAgeSeverity(seconds: number, warnAfter = 300): Severity | null {
	if (seconds >= 3600) return 'critical';
	if (seconds >= warnAfter) return 'warn';
	if (seconds >= 60) return 'info';
	return null;
}

export interface VacuumState {
	live: number;
	dead: number;
	/** Days since the most recent manual or auto vacuum / analyze (null = never). */
	vacuumAgeDays: number | null;
	analyzeAgeDays: number | null;
	modsSinceAnalyze: number;
}

export interface VacuumIssue {
	severity: Severity;
	reasons: string[];
}

/** Dead tuple share, and tables never/long-not vacuumed or analyzed, as one verdict. */
export function vacuumIssue(v: VacuumState): VacuumIssue | null {
	const reasons: string[] = [];
	let sev: Severity | null = null;
	const total = v.live + v.dead;
	const ratio = total > 0 ? v.dead / total : 0;
	if (v.dead >= 1000 && ratio >= 0.2) {
		sev = worst(sev, ratio >= 0.5 && v.dead >= 100_000 ? 'critical' : 'warn');
		reasons.push(`${Math.round(ratio * 100)}% dead rows`);
	}
	const busy = v.live + v.dead >= 1000;
	if (busy && v.analyzeAgeDays == null) {
		sev = worst(sev, 'info');
		reasons.push('never analyzed');
	} else if (busy && v.analyzeAgeDays != null && v.analyzeAgeDays > 30 && v.modsSinceAnalyze > Math.max(1000, v.live * 0.1)) {
		sev = worst(sev, 'info');
		reasons.push(`not analyzed in ${Math.floor(v.analyzeAgeDays)} days`);
	}
	if (v.dead >= 1000 && v.vacuumAgeDays == null) {
		sev = worst(sev, 'info');
		reasons.push('never vacuumed');
	} else if (v.dead >= 1000 && v.vacuumAgeDays != null && v.vacuumAgeDays > 30) {
		sev = worst(sev, 'info');
		reasons.push(`not vacuumed in ${Math.floor(v.vacuumAgeDays)} days`);
	}
	return sev ? { severity: sev, reasons } : null;
}

/** Estimated bloat: wasted bytes and share of the table. Small tables are never worth it. */
export function bloatSeverity(wastedBytes: number, ratio: number): Severity | null {
	if (wastedBytes < 8 * MB || ratio < 0.3) return null;
	if (ratio >= 0.8 && wastedBytes >= 1 * GB) return 'critical';
	if (ratio >= 0.5 && wastedBytes >= 64 * MB) return 'warn';
	return 'info';
}

/** MySQL data_free: reclaimable space inside a table's file. */
export function fragmentationSeverity(freeBytes: number, usedBytes: number): Severity | null {
	if (freeBytes < 32 * MB) return null;
	const ratio = freeBytes / Math.max(1, usedBytes + freeBytes);
	if (ratio < 0.25) return null;
	return ratio >= 0.5 && freeBytes >= 1 * GB ? 'warn' : 'info';
}

export interface ScanStats {
	seqScan: number;
	seqTupRead: number;
	idxScan: number;
	liveRows: number;
}

/** Big tables read mostly by full scans — a hint, never more than a warning. */
export function missingIndexSeverity(s: ScanStats): Severity | null {
	if (s.liveRows < 10_000 || s.seqScan < 50) return null;
	const perScan = s.seqTupRead / s.seqScan;
	if (perScan < 5000) return null;
	if (s.idxScan >= s.seqScan * 10) return null;
	return s.seqScan >= 1000 && perScan >= 50_000 && s.idxScan < s.seqScan ? 'warn' : 'info';
}

// --- index comparisons ------------------------------------------------------------

export interface IndexShape {
	schema: string;
	table: string;
	name: string;
	/** Key columns in order (expressions spelled out, prefix lengths included). */
	columns: string[];
	unique: boolean;
	primary: boolean;
	/** Access method (btree, hash, gin …); only like methods are compared. */
	method: string;
	/** Partial-index predicate; indexes only compare when predicates match. */
	predicate?: string | null;
	bytes?: number;
}

export interface RedundantIndex {
	index: IndexShape;
	/** The index that makes it unnecessary. */
	coveredBy: IndexShape;
	/** Same key columns (a true duplicate) rather than a leading prefix. */
	exact: boolean;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const isPrefix = (a: string[], b: string[]) => a.length < b.length && a.every((v, i) => v === b[i]);

/**
 * Indexes made redundant by another on the same table: identical key columns, or a
 * leading prefix of a longer btree index. Unique and primary-key indexes enforce
 * something, so they're never the redundant one of a prefix pair; of two exact
 * duplicates the constraint-backed (or alphabetically first) one is kept.
 */
export function redundantIndexes(indexes: IndexShape[]): RedundantIndex[] {
	const out: RedundantIndex[] = [];
	const flagged = new Set<string>();
	const key = (i: IndexShape) => `${i.schema}\u0000${i.table}\u0000${i.name}`;
	const byTable = new Map<string, IndexShape[]>();
	for (const i of indexes) {
		const t = `${i.schema}\u0000${i.table}`;
		if (!byTable.has(t)) byTable.set(t, []);
		byTable.get(t)!.push(i);
	}
	const keepRank = (i: IndexShape) => (i.primary ? 2 : i.unique ? 1 : 0);
	// Exact duplicates first, so a duplicate is reported as such rather than as covered by a wider index.
	for (const pass of ['exact', 'prefix'] as const) {
		for (const list of byTable.values()) {
			for (const a of list) {
				if (!a.columns.length) continue;
				for (const b of list) {
					if (a === b || flagged.has(key(a)) || flagged.has(key(b))) continue;
					if (a.method !== b.method || (a.predicate ?? null) !== (b.predicate ?? null)) continue;
					if (pass === 'exact' && sameList(a.columns, b.columns)) {
						// Keep the stronger one; on a tie, keep the alphabetically first name.
						const aLoses = keepRank(a) < keepRank(b) || (keepRank(a) === keepRank(b) && a.name > b.name);
						if (!aLoses) continue;
						flagged.add(key(a));
						out.push({ index: a, coveredBy: b, exact: true });
					} else if (pass === 'prefix' && isPrefix(a.columns, b.columns) && !a.unique && !a.primary && a.method === 'btree') {
						flagged.add(key(a));
						out.push({ index: a, coveredBy: b, exact: false });
					}
				}
			}
		}
	}
	return out;
}

/**
 * Whether some index can serve lookups on a foreign key's columns: the key columns
 * must be the leading columns of the index, in any order.
 */
export function fkHasIndex(fkColumns: string[], indexes: Pick<IndexShape, 'columns' | 'predicate' | 'method'>[]): boolean {
	const want = new Set(fkColumns);
	return indexes.some((i) => {
		if (i.predicate) return false;
		if (i.method !== 'btree' && i.method !== 'BTREE' && fkColumns.length > 1) return false;
		const lead = i.columns.slice(0, fkColumns.length);
		return lead.length === fkColumns.length && lead.every((c) => want.has(c));
	});
}

/** "3 days", "5 hours", "12 minutes" — for explanations. */
export function humanDuration(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	if (s < 120) return `${s} seconds`;
	if (s < 7200) return `${Math.round(s / 60)} minutes`;
	if (s < 172_800) return `${Math.round(s / 3600)} hours`;
	return `${Math.round(s / 86_400)} days`;
}

/** Bytes in a compact unit, for explanations generated on the server. */
export function humanBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	const units = ['kB', 'MB', 'GB', 'TB'];
	let v = n;
	let u = -1;
	do {
		v /= 1024;
		u++;
	} while (v >= 1024 && u < units.length - 1);
	return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

export function percent(r: number, digits = 0): string {
	return `${(r * 100).toFixed(digits)}%`;
}
