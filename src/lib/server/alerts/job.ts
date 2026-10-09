/**
 * The alert job: checks every connection that has rules, advances each (rule,
 * connection) state machine and notifies every enabled channel on transitions.
 */
import { defineJob } from '../jobs.ts';
import { getConnection, listConnections } from '../store.ts';
import { toQueryError } from '../engine.ts';
import { monitorable, snapshot, type Snapshot } from '../monitor.ts';
import { DAY, sizeNear } from '../size-history.ts';
import { consecutiveFor, effectiveRules, evaluate, step, type EvalContext } from './state.ts';
import { deliver, type Notification } from './notify.ts';
import {
	addEvent,
	alertSettings,
	channelWithSecrets,
	deleteState,
	listChannels,
	listRules,
	listStates,
	recordDelivery,
	recordEventDelivery,
	saveState
} from './store.ts';
import { RULES, type AlertRule, type AlertRuleKind, type AlertTransition } from '#lib/alerts.ts';
import type { Connection } from '#lib/types.ts';

export const ALERT_JOB = 'alerts';
const CONCURRENCY = 4;
let lastRunAt = 0;

export function notificationFor(
	rule: { id: string; kind: AlertRuleKind } | null,
	conn: Pick<Connection, 'id' | 'name' | 'engine'> | null,
	event: Notification['event'],
	message: string,
	extra: { value?: number | null; since?: number | null } = {}
): Notification {
	const { publicUrl } = alertSettings();
	const kind = rule?.kind;
	return {
		event,
		severity: kind ? RULES[kind].severity : 'warning',
		title: kind ? RULES[kind].label : 'Test notification',
		message,
		connection: conn ? { id: conn.id, name: conn.name, engine: conn.engine } : null,
		rule: rule ? { id: rule.id, kind: rule.kind } : null,
		value: extra.value ?? null,
		since: extra.since ? new Date(extra.since).toISOString() : null,
		at: new Date().toISOString(),
		url: publicUrl ? `${publicUrl.replace(/\/+$/, '')}${conn ? `/c/${encodeURIComponent(conn.id)}` : '/alerts'}` : null
	};
}

/** Sends to every enabled channel; returns how many succeeded and the errors. */
export async function broadcast(n: Notification): Promise<{ delivered: number; errors: string[] }> {
	const channels = listChannels().filter((c) => c.enabled);
	const results = await Promise.allSettled(
		channels.map(async (c) => {
			const full = channelWithSecrets(c.id);
			if (!full) return;
			try {
				await deliver(c.kind, full.channel.config, full.secrets, n);
				recordDelivery(c.id, null);
			} catch (err) {
				recordDelivery(c.id, (err as Error).message);
				throw new Error(`${c.name}: ${(err as Error).message}`);
			}
		})
	);
	const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => (r.reason as Error).message);
	return { delivered: results.length - errors.length, errors };
}

async function emit(rule: AlertRule, conn: Connection, transition: AlertTransition, message: string, value: number | null, since: number | null) {
	const id = addEvent({
		ruleId: rule.id,
		ruleKind: rule.kind,
		connectionId: conn.id,
		connectionName: conn.name,
		event: transition,
		severity: RULES[rule.kind].severity,
		message
	});
	if (transition === 'resolved' && !rule.notifyResolved) return;
	const { delivered, errors } = await broadcast(notificationFor(rule, conn, transition, message, { value, since }));
	recordEventDelivery(id, delivered, errors);
}

async function checkConnection(conn: Connection, rules: Map<AlertRuleKind, AlertRule>, now: number, renotifyMs: number) {
	if (!rules.size) return;
	const ctx: EvalContext = { reachable: false };
	try {
		const snap: Snapshot = await snapshot(conn.id, {
			longQueryMinutes: rules.get('long_query')?.params.minutes,
			replication: rules.has('replication_lag'),
			xid: rules.has('wraparound')
		});
		ctx.reachable = true;
		ctx.snapshot = snap;
		if (rules.has('size_growth')) ctx.sizeDayAgo = sizeNear(conn.id, now - DAY)?.bytes ?? null;
	} catch (err) {
		ctx.error = toQueryError(err).message;
	}

	const states = new Map(listStates().filter((s) => s.connectionId === conn.id).map((s) => [s.ruleId, s]));
	for (const rule of rules.values()) {
		const obs = evaluate(rule.kind, rule.params, ctx);
		const prev = states.get(rule.id);
		const { state, transition } = step(prev, obs, { now, consecutive: consecutiveFor(rule), renotifyMs });
		if (state !== prev) saveState(rule.id, conn.id, state);
		if (!transition) continue;
		const message =
			transition === 'resolved'
				? `Resolved after ${minutes(now - (prev?.since ?? now))}. ${state.message ?? ''}`.trim()
				: (state.message ?? RULES[rule.kind].label);
		await emit(rule, conn, transition, message, state.value, transition === 'resolved' ? (prev?.since ?? null) : state.since).catch((err) =>
			console.error('[alerts] notify failed', err)
		);
	}
}

function minutes(ms: number): string {
	const m = Math.max(1, Math.round(ms / 60_000));
	return m < 120 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
}

/** One pass over every connection. */
export async function runChecks(now = Date.now()) {
	lastRunAt = now;
	const settings = alertSettings();
	const renotifyMs = Math.max(0, settings.renotifyHours) * 3_600_000;
	const rules = listRules();
	const conns = listConnections().filter(monitorable);
	const plan = conns.map((c) => ({ conn: c, rules: effectiveRules(rules, c.id, c.engine) }));

	// States whose rule no longer applies (disabled, overridden, kind changed) go away
	// quietly; firing ones are closed in the history.
	const applies = new Set(plan.flatMap((p) => [...p.rules.values()].map((r) => `${r.id}:${p.conn.id}`)));
	const byId = new Map(rules.map((r) => [r.id, r]));
	for (const s of listStates()) {
		if (applies.has(`${s.ruleId}:${s.connectionId}`)) continue;
		deleteState(s.ruleId, s.connectionId);
		const rule = byId.get(s.ruleId);
		const conn = getConnection(s.connectionId);
		if (s.status === 'firing' && rule) {
			addEvent({
				ruleId: rule.id,
				ruleKind: rule.kind,
				connectionId: s.connectionId,
				connectionName: conn?.name ?? null,
				event: 'resolved',
				severity: RULES[rule.kind].severity,
				message: 'Rule disabled or no longer applies to this connection.'
			});
		}
	}

	const work = plan.filter((p) => p.rules.size > 0);
	let i = 0;
	const worker = async () => {
		while (i < work.length) {
			const { conn, rules: r } = work[i++];
			await checkConnection(conn, r, now, renotifyMs).catch((err) => console.error(`[alerts] check of ${conn.name} failed`, err));
		}
	};
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

/** Ticks often and runs when the configured interval has passed. */
defineJob({
	name: ALERT_JOB,
	everyMs: 15_000,
	initialDelayMs: 45_000,
	run: async () => {
		const interval = Math.max(30, alertSettings().intervalSeconds) * 1000;
		if (Date.now() - lastRunAt < interval - 2_000) return;
		await runChecks();
	}
});
