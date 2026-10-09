import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrangeSessions, deadIsHigh, deadRatio, formatAge, lockTree, matchesSearch, sessionTone, summarize, type ActivitySession } from '../src/lib/activity.ts';

const session = (pid: number, over: Partial<ActivitySession> = {}): ActivitySession => ({
	pid,
	user: 'app',
	database: 'shop',
	app: 'psql',
	client: '10.0.0.5:51234',
	backendType: 'client backend',
	state: 'idle',
	waitEventType: null,
	waitEvent: null,
	backendStart: null,
	xactStart: null,
	queryStart: null,
	stateChange: null,
	querySeconds: null,
	xactSeconds: null,
	stateSeconds: 10,
	query: 'select 1',
	queryTruncated: false,
	xidAge: null,
	xminAge: null,
	blockedBy: [],
	pgModern: false,
	self: false,
	...over
});

test('formatAge', () => {
	assert.equal(formatAge(null), '—');
	assert.equal(formatAge(0.25), '250ms');
	assert.equal(formatAge(42.9), '42s');
	assert.equal(formatAge(187), '3m 07s');
	assert.equal(formatAge(7500), '2h 05m');
	assert.equal(formatAge(86400 * 3 + 3600 * 4 + 12), '3d 4h');
	assert.equal(formatAge(-5), '0ms');
});

test('sessionTone classifies states', () => {
	assert.equal(sessionTone(session(1, { state: 'active' })), 'active');
	assert.equal(sessionTone(session(1, { state: 'active', blockedBy: [2] })), 'waiting');
	assert.equal(sessionTone(session(1, { state: 'active', waitEventType: 'Lock' })), 'waiting');
	assert.equal(sessionTone(session(1, { state: 'idle in transaction' })), 'idle-txn');
	assert.equal(sessionTone(session(1, { state: 'idle in transaction (aborted)' })), 'idle-txn');
	assert.equal(sessionTone(session(1, { state: null, backendType: 'checkpointer' })), 'background');
	assert.equal(sessionTone(session(1)), 'idle');
});

test('lockTree nests chains under their root blocker', () => {
	// 10 blocks 11 and 12; 12 blocks 13. 20 is unrelated.
	const sessions = [session(13, { blockedBy: [12] }), session(20), session(12, { blockedBy: [10] }), session(11, { blockedBy: [10] }), session(10)];
	assert.deepEqual(lockTree(sessions), [
		{ pid: 10, depth: 0, blocks: [11, 12] },
		{ pid: 11, depth: 1, blocks: [] },
		{ pid: 12, depth: 1, blocks: [13] },
		{ pid: 13, depth: 2, blocks: [] }
	]);
});

test('lockTree ignores blockers that are not listed and survives cycles', () => {
	assert.deepEqual(lockTree([session(1, { blockedBy: [99] })]), []);
	const cycle = lockTree([session(1, { blockedBy: [2] }), session(2, { blockedBy: [1] })]);
	assert.deepEqual(
		cycle.map((n) => n.pid),
		[1, 2]
	);
	assert.deepEqual(
		cycle.map((n) => n.depth),
		[0, 1]
	);
});

test('lockTree lists a session waiting on two blockers once', () => {
	const tree = lockTree([session(1), session(2), session(3, { blockedBy: [1, 2] })]);
	assert.deepEqual(
		tree.map((n) => [n.pid, n.depth]),
		[
			[1, 0],
			[3, 1],
			[2, 0]
		]
	);
});

test('arrangeSessions puts chains first and keeps the rest in order', () => {
	const rows = arrangeSessions([session(5), session(7, { blockedBy: [9] }), session(6), session(9, { state: 'idle in transaction' })]);
	assert.deepEqual(
		rows.map((r) => [r.session.pid, r.depth]),
		[
			[9, 0],
			[7, 1],
			[5, 0],
			[6, 0]
		]
	);
	assert.deepEqual(rows[0].blocks, [7]);
});

test('summarize counts states, connections and long transactions', () => {
	const s = summarize([
		session(1, { state: 'active', xactSeconds: 2, querySeconds: 2 }),
		session(2, { state: 'active', blockedBy: [3], xactSeconds: 30 }),
		session(3, { state: 'idle in transaction', xactSeconds: 900 }),
		session(4),
		session(5, { state: null, backendType: 'autovacuum launcher' }),
		session(6, { state: 'active', self: true, xactSeconds: 5000 })
	]);
	assert.equal(s.active, 3);
	assert.equal(s.waiting, 1);
	assert.equal(s.idleInTransaction, 1);
	assert.equal(s.idle, 1);
	assert.equal(s.background, 1);
	assert.equal(s.clients, 5);
	assert.equal(s.oldestXactPid, 3);
	assert.equal(s.oldestXactSeconds, 900);
	assert.deepEqual(s.longTransactions, [3]);
});

test('dead tuple ratio and warning threshold', () => {
	assert.equal(deadRatio(0, 0), null);
	assert.equal(deadRatio(75, 25), 25);
	assert.equal(deadIsHigh(75, 25), false); // too few rows to matter
	assert.equal(deadIsHigh(7500, 2500), true);
	assert.equal(deadIsHigh(90000, 1000), false);
});

test('matchesSearch looks at pid prefix and text columns', () => {
	const s = session(4321, { query: 'SELECT * FROM orders', app: 'billing-worker' });
	assert.ok(matchesSearch(s, ''));
	assert.ok(matchesSearch(s, '432'));
	assert.ok(matchesSearch(s, 'ORDERS'));
	assert.ok(matchesSearch(s, 'billing'));
	assert.ok(!matchesSearch(s, 'invoices'));
});
