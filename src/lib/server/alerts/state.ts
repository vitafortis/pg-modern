/**
 * Pure alert logic: the per (rule, connection) state machine, which rule applies to a
 * connection, and how a monitoring snapshot turns into an observation per rule.
 */
import { RULES, type AlertRule, type AlertRuleKind, type AlertTransition } from '#lib/alerts.ts';
import type { Snapshot } from '../monitor.ts';

export type Status = 'ok' | 'pending' | 'firing';

export interface RuleState {
	status: Status;
	/** Consecutive breaching observations. */
	streak: number;
	/** When it started firing (epoch ms). */
	since: number | null;
	lastNotifiedAt: number | null;
	message: string | null;
	value: number | null;
}

export type Observation =
	| { kind: 'breach'; message: string; value?: number }
	| { kind: 'ok'; message?: string }
	/** The check couldn't tell (connection down, missing privilege, no history yet): keep the state. */
	| { kind: 'unknown' };

export interface StepOptions {
	now: number;
	/** Breaching observations in a row before it fires. */
	consecutive: number;
	/** Re-notify while still firing after this long; 0 never. */
	renotifyMs: number;
}

export const INITIAL_STATE: RuleState = { status: 'ok', streak: 0, since: null, lastNotifiedAt: null, message: null, value: null };

/**
 * Advances one state machine. Notifications only happen on transitions: ok/pending →
 * firing ("fired"), firing → ok ("resolved"), and a reminder while firing once the
 * re-notify interval has passed since the last notification ("renotified").
 */
export function step(prev: RuleState | undefined, obs: Observation, opts: StepOptions): { state: RuleState; transition: AlertTransition | null } {
	const s = prev ?? INITIAL_STATE;
	if (obs.kind === 'unknown') return { state: s, transition: null };

	if (obs.kind === 'ok') {
		if (s.status === 'firing') {
			return {
				state: { ...INITIAL_STATE, lastNotifiedAt: opts.now, message: obs.message ?? s.message },
				transition: 'resolved'
			};
		}
		return { state: { ...INITIAL_STATE, lastNotifiedAt: s.lastNotifiedAt }, transition: null };
	}

	const streak = s.streak + 1;
	const value = obs.value ?? null;
	if (s.status === 'firing') {
		const due = opts.renotifyMs > 0 && s.lastNotifiedAt != null && opts.now - s.lastNotifiedAt >= opts.renotifyMs;
		return {
			state: { ...s, streak, message: obs.message, value, lastNotifiedAt: due ? opts.now : s.lastNotifiedAt },
			transition: due ? 'renotified' : null
		};
	}
	if (streak >= Math.max(1, opts.consecutive)) {
		return { state: { status: 'firing', streak, since: opts.now, lastNotifiedAt: opts.now, message: obs.message, value }, transition: 'fired' };
	}
	return { state: { ...s, status: 'pending', streak, message: obs.message, value }, transition: null };
}

/**
 * The rule of each kind that applies to a connection: its own rule if it has one
 * (a disabled one switches that kind off for it), otherwise the global rule.
 */
export function effectiveRules(rules: AlertRule[], connectionId: string, engine: string): Map<AlertRuleKind, AlertRule> {
	const out = new Map<AlertRuleKind, AlertRule>();
	const own = new Set<AlertRuleKind>();
	for (const r of rules) {
		if (r.connectionId !== connectionId) continue;
		own.add(r.kind);
		if (r.enabled) out.set(r.kind, r);
	}
	for (const r of rules) {
		if (r.connectionId !== null || own.has(r.kind) || !r.enabled || out.has(r.kind)) continue;
		out.set(r.kind, r);
	}
	for (const kind of [...out.keys()]) if (RULES[kind].postgresOnly && engine !== 'postgres') out.delete(kind);
	return out;
}

const GB = 1024 ** 3;
export const XID_LIMIT = 2 ** 31;

export function formatBytes(n: number): string {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let i = 0;
	let v = n;
	while (Math.abs(v) >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${Math.abs(v) < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
	if (seconds < 90) return `${Math.round(seconds)} s`;
	if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
	if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} h`;
	return `${Math.round(seconds / 86400)} days`;
}

export interface EvalContext {
	/** The check reached the database. */
	reachable: boolean;
	error?: string;
	snapshot?: Snapshot;
	/** Database size about 24 hours ago, from size history. */
	sizeDayAgo?: number | null;
}

/** Turns what a check saw into an observation for one rule. */
export function evaluate(kind: AlertRuleKind, params: Record<string, number>, ctx: EvalContext): Observation {
	const p = (key: string) => params[key] ?? RULES[kind].params.find((x) => x.key === key)!.default;
	if (kind === 'unreachable') {
		return ctx.reachable ? { kind: 'ok', message: 'Reachable again.' } : { kind: 'breach', message: `Can’t connect: ${ctx.error ?? 'unknown error'}` };
	}
	const s = ctx.snapshot;
	if (!ctx.reachable || !s) return { kind: 'unknown' };

	switch (kind) {
		case 'connections': {
			if (!s.maxConnections || s.usedConnections == null) return { kind: 'unknown' };
			const pct = (100 * s.usedConnections) / s.maxConnections;
			const text = `${s.usedConnections} of ${s.maxConnections} connections in use (${Math.round(pct)}%).`;
			return pct > p('percent') ? { kind: 'breach', message: text, value: pct } : { kind: 'ok', message: text };
		}
		case 'long_query': {
			if (!s.longQueries) return { kind: 'unknown' };
			const minSeconds = p('minutes') * 60;
			const long = s.longQueries.filter((q) => q.seconds >= minSeconds);
			if (!long.length) return { kind: 'ok', message: `No query running longer than ${p('minutes')} min.` };
			const q = long[0];
			const more = long.length > 1 ? ` (+${long.length - 1} more)` : '';
			const sql = q.query ? `: ${q.query.replace(/\s+/g, ' ').trim().slice(0, 160)}` : '';
			return { kind: 'breach', message: `Query running for ${formatDuration(q.seconds)} (pid ${q.pid}${q.user ? `, ${q.user}` : ''})${more}${sql}`, value: q.seconds };
		}
		case 'size_above': {
			if (s.dbBytes == null) return { kind: 'unknown' };
			const text = `Database is ${formatBytes(s.dbBytes)} (limit ${p('gb')} GB).`;
			return s.dbBytes > p('gb') * GB ? { kind: 'breach', message: text, value: s.dbBytes } : { kind: 'ok', message: text };
		}
		case 'size_growth': {
			if (s.dbBytes == null || !ctx.sizeDayAgo) return { kind: 'unknown' };
			const pct = (100 * (s.dbBytes - ctx.sizeDayAgo)) / ctx.sizeDayAgo;
			const text = `Grew ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% in 24 h (${formatBytes(ctx.sizeDayAgo)} → ${formatBytes(s.dbBytes)}).`;
			return pct > p('percent') ? { kind: 'breach', message: text, value: pct } : { kind: 'ok', message: text };
		}
		case 'wraparound': {
			if (s.xidAge == null) return { kind: 'unknown' };
			const pct = (100 * s.xidAge) / XID_LIMIT;
			const text = `Oldest unfrozen transaction ID is ${s.xidAge.toLocaleString('en-US')} old (${pct.toFixed(1)}% of 2³¹). Make sure (auto)vacuum can freeze old rows.`;
			return pct > p('percent') ? { kind: 'breach', message: text, value: pct } : { kind: 'ok', message: text };
		}
		case 'replication_lag': {
			if (s.replicationLagSeconds == null) return { kind: 'unknown' };
			const text = `Replication lag is ${formatDuration(s.replicationLagSeconds)}.`;
			return s.replicationLagSeconds > p('seconds') ? { kind: 'breach', message: text, value: s.replicationLagSeconds } : { kind: 'ok', message: text };
		}
	}
	return { kind: 'unknown' };
}

/** Consecutive breaching checks needed before a rule fires. */
export function consecutiveFor(rule: AlertRule): number {
	return rule.kind === 'unreachable' ? Math.max(1, Math.round(rule.params.failures ?? 2)) : 1;
}
