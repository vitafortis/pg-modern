import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PGM_DATA_DIR = mkdtempSync(join(tmpdir(), 'pgm-alerts-test-'));
process.env.PGM_SECRET_KEY = 'test-key-for-alerts';
const { step, effectiveRules, evaluate, consecutiveFor, INITIAL_STATE } = await import('../src/lib/server/alerts/state.ts');
const store = await import('../src/lib/server/store.ts');
const alerts = await import('../src/lib/server/alerts/store.ts');
const { parseChannelInput } = await import('../src/lib/server/alerts/input.ts');
import type { AlertRule } from '../src/lib/alerts.ts';
import type { Snapshot } from '../src/lib/server/monitor.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const breach = { kind: 'breach' as const, message: 'bad' };
const ok = { kind: 'ok' as const };
const unknown = { kind: 'unknown' as const };

test('fires only after N consecutive breaches, then resolves once', () => {
	const opts = (now: number) => ({ now, consecutive: 2, renotifyMs: 6 * HOUR });
	let r = step(undefined, breach, opts(0));
	assert.equal(r.transition, null);
	assert.equal(r.state.status, 'pending');
	r = step(r.state, breach, opts(MIN));
	assert.equal(r.transition, 'fired');
	assert.equal(r.state.status, 'firing');
	assert.equal(r.state.since, MIN);
	// Still firing: no repeat notification within the re-notify interval.
	r = step(r.state, breach, opts(2 * MIN));
	assert.equal(r.transition, null);
	r = step(r.state, ok, opts(3 * MIN));
	assert.equal(r.transition, 'resolved');
	assert.equal(r.state.status, 'ok');
	r = step(r.state, ok, opts(4 * MIN));
	assert.equal(r.transition, null);
});

test('a single breach between successes never fires (pending resets)', () => {
	const o = { now: 0, consecutive: 2, renotifyMs: 0 };
	let r = step(undefined, breach, o);
	r = step(r.state, ok, o);
	assert.equal(r.transition, null);
	assert.equal(r.state.streak, 0);
	r = step(r.state, breach, o);
	assert.equal(r.state.status, 'pending');
});

test('re-notifies after the cooldown while still firing, and never with 0', () => {
	let r = step(undefined, breach, { now: 0, consecutive: 1, renotifyMs: 6 * HOUR });
	assert.equal(r.transition, 'fired');
	r = step(r.state, breach, { now: 5 * HOUR, consecutive: 1, renotifyMs: 6 * HOUR });
	assert.equal(r.transition, null);
	r = step(r.state, breach, { now: 6 * HOUR, consecutive: 1, renotifyMs: 6 * HOUR });
	assert.equal(r.transition, 'renotified');
	assert.equal(r.state.lastNotifiedAt, 6 * HOUR);
	assert.equal(r.state.since, 0, 'since stays at the first firing');
	r = step(r.state, breach, { now: 11 * HOUR, consecutive: 1, renotifyMs: 6 * HOUR });
	assert.equal(r.transition, null, 'the cooldown counts from the last notification');

	let q = step(undefined, breach, { now: 0, consecutive: 1, renotifyMs: 0 });
	q = step(q.state, breach, { now: 100 * HOUR, consecutive: 1, renotifyMs: 0 });
	assert.equal(q.transition, null);
});

test('unknown observations keep the state as is', () => {
	const firing = step(undefined, breach, { now: 0, consecutive: 1, renotifyMs: 0 }).state;
	const r = step(firing, unknown, { now: 10 * HOUR, consecutive: 1, renotifyMs: HOUR });
	assert.equal(r.transition, null);
	assert.equal(r.state, firing);
	assert.equal(step(undefined, unknown, { now: 0, consecutive: 1, renotifyMs: 0 }).state, INITIAL_STATE);
});

const rule = (over: Partial<AlertRule>): AlertRule => ({
	id: Math.random().toString(36).slice(2),
	kind: 'connections',
	connectionId: null,
	enabled: true,
	params: { percent: 80 },
	notifyResolved: true,
	createdAt: '',
	updatedAt: '',
	...over
});

test('a connection rule overrides the global one; a disabled override switches the kind off', () => {
	const global = rule({ kind: 'connections' });
	const specific = rule({ kind: 'connections', connectionId: 'a', params: { percent: 95 } });
	const off = rule({ kind: 'long_query', connectionId: 'b', enabled: false });
	const globalLong = rule({ kind: 'long_query', params: { minutes: 15 } });
	const wrap = rule({ kind: 'wraparound', params: { percent: 50 } });
	const all = [global, specific, off, globalLong, wrap];
	assert.equal(effectiveRules(all, 'a', 'postgres').get('connections'), specific);
	assert.equal(effectiveRules(all, 'b', 'postgres').get('connections'), global);
	assert.equal(effectiveRules(all, 'b', 'postgres').has('long_query'), false);
	assert.equal(effectiveRules(all, 'a', 'postgres').get('long_query'), globalLong);
	assert.equal(effectiveRules(all, 'a', 'mysql').has('wraparound'), false, 'Postgres-only rules skip MySQL');
	assert.equal(effectiveRules([rule({ enabled: false })], 'a', 'postgres').size, 0);
});

const snap = (over: Partial<Snapshot>): Snapshot => ({
	maxConnections: 100,
	usedConnections: 10,
	dbBytes: 1024 ** 3,
	xidAge: 1_000_000,
	longQueries: [],
	replicationLagSeconds: null,
	...over
});

test('evaluate: thresholds per rule kind', () => {
	assert.equal(evaluate('unreachable', { failures: 2 }, { reachable: false, error: 'ECONNREFUSED' }).kind, 'breach');
	assert.equal(evaluate('unreachable', { failures: 2 }, { reachable: true, snapshot: snap({}) }).kind, 'ok');
	assert.equal(evaluate('connections', { percent: 80 }, { reachable: false }).kind, 'unknown', 'other rules wait while down');
	assert.equal(evaluate('connections', { percent: 80 }, { reachable: true, snapshot: snap({ usedConnections: 81 }) }).kind, 'breach');
	assert.equal(evaluate('connections', { percent: 80 }, { reachable: true, snapshot: snap({ usedConnections: 80 }) }).kind, 'ok');
	const lq = evaluate('long_query', { minutes: 15 }, { reachable: true, snapshot: snap({ longQueries: [{ pid: 7, user: 'app', seconds: 20 * 60, query: 'select  pg_sleep(9999)' }] }) });
	assert.equal(lq.kind, 'breach');
	assert.match(lq.kind === 'breach' ? lq.message : '', /20 min \(pid 7, app\): select pg_sleep/);
	assert.equal(evaluate('long_query', { minutes: 15 }, { reachable: true, snapshot: snap({ longQueries: null }) }).kind, 'unknown');
	assert.equal(evaluate('size_above', { gb: 0.5 }, { reachable: true, snapshot: snap({}) }).kind, 'breach');
	assert.equal(evaluate('size_above', { gb: 2 }, { reachable: true, snapshot: snap({}) }).kind, 'ok');
	assert.equal(evaluate('size_growth', { percent: 25 }, { reachable: true, snapshot: snap({}), sizeDayAgo: null }).kind, 'unknown', 'needs history');
	assert.equal(evaluate('size_growth', { percent: 25 }, { reachable: true, snapshot: snap({}), sizeDayAgo: 0.7 * 1024 ** 3 }).kind, 'breach');
	assert.equal(evaluate('size_growth', { percent: 25 }, { reachable: true, snapshot: snap({}), sizeDayAgo: 0.9 * 1024 ** 3 }).kind, 'ok');
	assert.equal(evaluate('wraparound', { percent: 50 }, { reachable: true, snapshot: snap({ xidAge: 1_200_000_000 }) }).kind, 'breach');
	assert.equal(evaluate('wraparound', { percent: 50 }, { reachable: true, snapshot: snap({}) }).kind, 'ok');
	assert.equal(evaluate('replication_lag', { seconds: 60 }, { reachable: true, snapshot: snap({}) }).kind, 'unknown', 'no replicas, no opinion');
	assert.equal(evaluate('replication_lag', { seconds: 60 }, { reachable: true, snapshot: snap({ replicationLagSeconds: 90 }) }).kind, 'breach');
	assert.equal(consecutiveFor(rule({ kind: 'unreachable', params: { failures: 3 } })), 3);
	assert.equal(consecutiveFor(rule({ kind: 'connections' })), 1);
});

test('channel secrets are encrypted, kept on edit, and never returned', () => {
	const input = parseChannelInput({ kind: 'discord', name: 'Ops', config: {}, secrets: { url: 'https://discord.com/api/webhooks/1/s3cret-token' } });
	const c = alerts.createChannel(input);
	assert.deepEqual(c.secrets, { url: 'discord.com/…' });
	assert.ok(!JSON.stringify(c).includes('s3cret-token'));
	const raw = store.sqlite().prepare('SELECT secret FROM alert_channels WHERE id = ?').get(c.id) as { secret: string };
	assert.ok(!raw.secret.includes('s3cret-token'));
	// Blank secret on edit keeps the stored one.
	alerts.updateChannel(c.id, parseChannelInput({ kind: 'discord', name: 'Ops 2', config: {}, secrets: { url: '' } }));
	assert.equal(alerts.channelWithSecrets(c.id)!.secrets.url, 'https://discord.com/api/webhooks/1/s3cret-token');
	assert.equal(alerts.getChannel(c.id)!.name, 'Ops 2');
	assert.throws(() => parseChannelInput({ kind: 'webhook', secrets: { url: 'file:///etc/passwd' } }), /http/);
});

test('the first channel seeds the default rules once', () => {
	alerts.deleteRule; // module loaded
	const before = alerts.listRules().length;
	assert.equal(before, 0);
	const seeded = alerts.seedDefaultRulesOnce();
	assert.ok(seeded.length >= 6);
	assert.ok(seeded.find((r) => r.kind === 'unreachable')!.enabled);
	assert.equal(seeded.find((r) => r.kind === 'unreachable')!.params.failures, 2);
	assert.equal(seeded.find((r) => r.kind === 'size_above')!.enabled, false);
	for (const r of seeded) alerts.deleteRule(r.id);
	assert.equal(alerts.seedDefaultRulesOnce().length, 0, 'not re-added after the admin deleted them');
});

test('firing summary only includes visible connections', () => {
	const a = store.createConnection({ name: 'a', host: 'db', port: 5432, database: 'app', user: 'app', sslMode: 'prefer', readOnly: true });
	const b = store.createConnection({ name: 'b', host: 'db', port: 5432, database: 'app', user: 'app', sslMode: 'prefer', readOnly: true });
	const r = alerts.createRule({ kind: 'unreachable', connectionId: null, enabled: true, params: { failures: 2 }, notifyResolved: true });
	const firing = step(undefined, breach, { now: Date.now(), consecutive: 1, renotifyMs: 0 }).state;
	alerts.saveState(r.id, a.id, firing);
	alerts.saveState(r.id, b.id, firing);
	assert.deepEqual(Object.keys(alerts.firingSummary([a.id])), [a.id]);
	assert.equal(alerts.firingSummary([a.id, b.id])[b.id].critical, true);
	assert.equal(alerts.activeAlerts().length, 2);
	store.deleteConnection(b.id);
	assert.equal(alerts.activeAlerts().length, 1, 'state goes with the connection');
});
