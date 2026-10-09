import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	GB,
	HEALTH_CHECKS,
	MB,
	XID_LIMIT,
	bloatSeverity,
	cacheHitSeverity,
	checksFor,
	connectionSeverity,
	fkHasIndex,
	fragmentationSeverity,
	healthSupported,
	humanBytes,
	integerTypeMax,
	missingIndexSeverity,
	redundantIndexes,
	sequenceSeverity,
	sequenceUsage,
	sortChecks,
	summarizeHealth,
	transactionAgeSeverity,
	unusedIndexSeverity,
	vacuumIssue,
	worst,
	wraparoundSeverity,
	type CheckResult,
	type IndexShape
} from '../src/lib/health.ts';

const idx = (name: string, columns: string[], over: Partial<IndexShape> = {}): IndexShape => ({
	schema: 'public',
	table: 't',
	name,
	columns,
	unique: false,
	primary: false,
	method: 'btree',
	predicate: null,
	...over
});

test('catalog: every check names its engines; unknown engines get nothing', () => {
	assert.ok(HEALTH_CHECKS.every((c) => c.engines.length > 0));
	assert.equal(new Set(HEALTH_CHECKS.map((c) => c.id)).size, HEALTH_CHECKS.length);
	assert.ok(checksFor('postgres').some((c) => c.id === 'bloat'));
	assert.ok(!checksFor('mysql').some((c) => c.id === 'bloat'));
	assert.ok(checksFor('mysql').some((c) => c.id === 'storage-engines'));
	assert.ok(healthSupported('postgres') && healthSupported('mysql'));
	assert.ok(!healthSupported('sqlite') && !healthSupported(undefined));
});

test('redundantIndexes: exact duplicates keep the constraint-backed index', () => {
	const r = redundantIndexes([idx('t_pkey', ['id'], { primary: true, unique: true }), idx('t_id_idx', ['id'])]);
	assert.equal(r.length, 1);
	assert.equal(r[0].index.name, 't_id_idx');
	assert.equal(r[0].coveredBy.name, 't_pkey');
	assert.equal(r[0].exact, true);
});

test('redundantIndexes: two plain duplicates flag only one (alphabetically later)', () => {
	const r = redundantIndexes([idx('b_idx', ['a', 'b']), idx('a_idx', ['a', 'b'])]);
	assert.equal(r.length, 1);
	assert.equal(r[0].index.name, 'b_idx');
});

test('redundantIndexes: leading prefix of a btree is redundant, unique prefixes are not', () => {
	const r = redundantIndexes([idx('ab', ['a', 'b']), idx('a', ['a']), idx('b', ['b'])]);
	assert.deepEqual(
		r.map((x) => [x.index.name, x.coveredBy.name, x.exact]),
		[['a', 'ab', false]]
	);
	assert.equal(redundantIndexes([idx('ab', ['a', 'b']), idx('a_uniq', ['a'], { unique: true })]).length, 0);
	// Different column order isn't a prefix.
	assert.equal(redundantIndexes([idx('ab', ['a', 'b']), idx('b', ['b'])]).length, 0);
});

test('redundantIndexes: different methods, predicates or tables never compare', () => {
	assert.equal(redundantIndexes([idx('g', ['a'], { method: 'gin' }), idx('b', ['a'])]).length, 0);
	assert.equal(redundantIndexes([idx('p', ['a'], { predicate: 'deleted_at IS NULL' }), idx('b', ['a', 'b'])]).length, 0);
	assert.equal(redundantIndexes([idx('x', ['a']), idx('y', ['a'], { table: 'other' })]).length, 0);
	assert.equal(redundantIndexes([idx('x', ['a desc']), idx('y', ['a'])]).length, 0);
	// Hash indexes aren't usable for prefixes.
	assert.equal(redundantIndexes([idx('h', ['a'], { method: 'hash' }), idx('hab', ['a', 'b'], { method: 'hash' })]).length, 0);
});

test('fkHasIndex: key columns must lead an index, in any order', () => {
	assert.ok(fkHasIndex(['customer_id'], [idx('i', ['customer_id', 'created_at'])]));
	assert.ok(fkHasIndex(['a', 'b'], [idx('i', ['b', 'a', 'c'])]));
	assert.ok(!fkHasIndex(['customer_id'], [idx('i', ['created_at', 'customer_id'])]));
	assert.ok(!fkHasIndex(['a', 'b'], [idx('i', ['a'])]));
	assert.ok(!fkHasIndex(['a'], [idx('p', ['a'], { predicate: 'a > 0' })]));
	assert.ok(!fkHasIndex(['a'], []));
});

test('sequenceUsage counts the narrower column type', () => {
	assert.equal(sequenceUsage({ last: 50, min: 1, max: 101, increment: 1 }), 0.49);
	const intCol = sequenceUsage({ last: 2_000_000_000, min: 1, max: 9223372036854775807, increment: 1, columnType: 'integer' });
	assert.ok(intCol > 0.93 && intCol < 0.94);
	assert.ok(sequenceUsage({ last: 2_000_000_000, min: 1, max: 9223372036854775807, increment: 1, columnType: 'bigint' }) < 0.001);
	// Descending sequences run toward min.
	assert.equal(sequenceUsage({ last: -90, min: -101, max: -1, increment: -1 }), 0.89);
	assert.equal(integerTypeMax('smallint'), 32767);
	assert.equal(integerTypeMax('text'), null);
	assert.equal(sequenceSeverity(0.95), 'critical');
	assert.equal(sequenceSeverity(0.8), 'warn');
	assert.equal(sequenceSeverity(0.5), null);
});

test('wraparoundSeverity thresholds', () => {
	assert.equal(wraparoundSeverity(200_000_000), null);
	assert.equal(wraparoundSeverity(XID_LIMIT * 0.35), 'warn');
	assert.equal(wraparoundSeverity(XID_LIMIT * 0.7), 'critical');
});

test('unused index severity: tiny ignored, recent stats softened', () => {
	assert.equal(unusedIndexSeverity(100 * 1024, 30), null);
	assert.equal(unusedIndexSeverity(5 * MB, 30), 'info');
	assert.equal(unusedIndexSeverity(500 * MB, 30), 'warn');
	assert.equal(unusedIndexSeverity(500 * MB, 2), 'info');
	assert.equal(unusedIndexSeverity(500 * MB, null), 'warn');
});

test('cache, connection and transaction-age severities', () => {
	assert.equal(cacheHitSeverity(0.5, 100), null, 'too little traffic');
	assert.equal(cacheHitSeverity(0.85, 1e6), 'warn');
	assert.equal(cacheHitSeverity(0.95, 1e6), 'info');
	assert.equal(cacheHitSeverity(0.999, 1e6), null);
	assert.equal(cacheHitSeverity(null, 1e6), null);
	assert.equal(connectionSeverity(95, 100), 'critical');
	assert.equal(connectionSeverity(80, 100), 'warn');
	assert.equal(connectionSeverity(10, 100), null);
	assert.equal(connectionSeverity(1, 0), null);
	assert.equal(transactionAgeSeverity(30), null);
	assert.equal(transactionAgeSeverity(90), 'info');
	assert.equal(transactionAgeSeverity(600), 'warn');
	assert.equal(transactionAgeSeverity(7200), 'critical');
});

test('vacuumIssue combines dead tuples and stale maintenance', () => {
	assert.equal(vacuumIssue({ live: 100_000, dead: 100, vacuumAgeDays: 1, analyzeAgeDays: 1, modsSinceAnalyze: 0 }), null);
	const dead = vacuumIssue({ live: 10_000, dead: 5_000, vacuumAgeDays: 1, analyzeAgeDays: 1, modsSinceAnalyze: 0 });
	assert.equal(dead?.severity, 'warn');
	assert.deepEqual(dead?.reasons, ['33% dead rows']);
	assert.equal(vacuumIssue({ live: 100_000, dead: 400_000, vacuumAgeDays: 1, analyzeAgeDays: 1, modsSinceAnalyze: 0 })?.severity, 'critical');
	const never = vacuumIssue({ live: 50_000, dead: 2_000, vacuumAgeDays: null, analyzeAgeDays: null, modsSinceAnalyze: 50_000 });
	assert.equal(never?.severity, 'info');
	assert.deepEqual(never?.reasons, ['never analyzed', 'never vacuumed']);
	assert.deepEqual(vacuumIssue({ live: 50_000, dead: 2_000, vacuumAgeDays: 45, analyzeAgeDays: 45, modsSinceAnalyze: 10_000 })?.reasons, ['not analyzed in 45 days', 'not vacuumed in 45 days']);
	// Small tables don't nag.
	assert.equal(vacuumIssue({ live: 10, dead: 0, vacuumAgeDays: null, analyzeAgeDays: null, modsSinceAnalyze: 10 }), null);
});

test('bloat, fragmentation and missing-index heuristics', () => {
	assert.equal(bloatSeverity(4 * MB, 0.9), null);
	assert.equal(bloatSeverity(20 * MB, 0.2), null);
	assert.equal(bloatSeverity(20 * MB, 0.6), 'info');
	assert.equal(bloatSeverity(100 * MB, 0.6), 'warn');
	assert.equal(bloatSeverity(2 * GB, 0.9), 'critical');
	assert.equal(fragmentationSeverity(10 * MB, 10 * MB), null);
	assert.equal(fragmentationSeverity(100 * MB, 1000 * MB), null);
	assert.equal(fragmentationSeverity(100 * MB, 100 * MB), 'info');
	assert.equal(fragmentationSeverity(3 * GB, 1 * GB), 'warn');
	assert.equal(missingIndexSeverity({ seqScan: 100, seqTupRead: 100 * 50_000, idxScan: 0, liveRows: 1000 }), null, 'small table');
	assert.equal(missingIndexSeverity({ seqScan: 100, seqTupRead: 100 * 50_000, idxScan: 0, liveRows: 50_000 }), 'info');
	assert.equal(missingIndexSeverity({ seqScan: 5000, seqTupRead: 5000 * 100_000, idxScan: 10, liveRows: 100_000 }), 'warn');
	assert.equal(missingIndexSeverity({ seqScan: 100, seqTupRead: 100 * 50_000, idxScan: 100_000, liveRows: 50_000 }), null, 'mostly index scans');
	assert.equal(missingIndexSeverity({ seqScan: 100, seqTupRead: 100 * 10, idxScan: 0, liveRows: 50_000 }), null, 'scans stop early');
});

test('summarizeHealth and sortChecks', () => {
	const c = (id: string, status: CheckResult['status'], sevs: ('info' | 'warn' | 'critical')[] = []): CheckResult => ({
		id,
		title: id,
		status,
		findings: sevs.map((s) => ({ severity: s, title: s, explanation: '', objects: [] })),
		durationMs: 1
	});
	const checks = [c('settings', 'ok'), c('bloat', 'findings', ['info', 'warn']), c('vacuum', 'error'), c('wraparound', 'findings', ['critical']), c('unused-indexes', 'skipped')];
	assert.deepEqual(summarizeHealth(checks), { critical: 1, warn: 1, info: 1, errors: 1, passed: 1, skipped: 1 });
	assert.deepEqual(
		sortChecks(checks).map((x) => x.id),
		['wraparound', 'bloat', 'vacuum', 'unused-indexes', 'settings']
	);
	assert.equal(worst('info', 'warn'), 'warn');
	assert.equal(worst(null, 'info'), 'info');
	assert.equal(humanBytes(1536), '1.5 kB');
	assert.equal(humanBytes(200 * MB), '200 MB');
});
