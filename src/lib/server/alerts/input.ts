/** Validation of alert API request bodies. */
import { BadRequest } from '../http.ts';
import { getConnection } from '../store.ts';
import { cleanParams, type ChannelInput, type RuleInput } from './store.ts';
import { CHANNELS, isChannelKind, isRuleKind, type AlertSettings } from '#lib/alerts.ts';

function obj(body: unknown): Record<string, unknown> {
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('Expected a JSON object');
	return body as Record<string, unknown>;
}

const strings = (v: unknown): Record<string, string | undefined> =>
	v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, typeof x === 'string' ? x : undefined])) : {};

function checkUrl(label: string, v: string | undefined) {
	if (!v) return;
	let u: URL;
	try {
		u = new URL(v);
	} catch {
		throw new BadRequest(`${label} must be a URL`);
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BadRequest(`${label} must be an http(s) URL`);
}

export function parseChannelInput(body: unknown): ChannelInput {
	const b = obj(body);
	if (!isChannelKind(b.kind)) throw new BadRequest('Unknown channel type');
	const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : CHANNELS[b.kind].label;
	const config = Object.fromEntries(Object.entries(strings(b.config)).filter((e): e is [string, string] => e[1] !== undefined));
	// Only explicit non-empty strings replace a stored secret; '' with `clear` removes it.
	const raw = strings(b.secrets);
	const clear = Array.isArray(b.clearSecrets) ? (b.clearSecrets as unknown[]).filter((x): x is string => typeof x === 'string') : [];
	const secrets: Record<string, string | undefined> = {};
	for (const f of CHANNELS[b.kind].fields.filter((f) => f.secret)) {
		if (clear.includes(f.key)) secrets[f.key] = '';
		else if (raw[f.key]?.trim()) secrets[f.key] = raw[f.key]!.trim();
	}
	for (const f of CHANNELS[b.kind].fields) {
		if (f.key === 'url' || f.key === 'server') checkUrl(f.label, f.secret ? secrets[f.key] : config[f.key]?.trim());
	}
	return { name, kind: b.kind, enabled: b.enabled !== false, config, secrets };
}

export function parseRuleInput(body: unknown): RuleInput {
	const b = obj(body);
	if (!isRuleKind(b.kind)) throw new BadRequest('Unknown rule type');
	let connectionId: string | null = null;
	if (typeof b.connectionId === 'string' && b.connectionId) {
		if (!getConnection(b.connectionId)) throw new BadRequest('Unknown connection');
		connectionId = b.connectionId;
	}
	return {
		kind: b.kind,
		connectionId,
		enabled: b.enabled !== false,
		params: cleanParams(b.kind, b.params && typeof b.params === 'object' ? (b.params as Record<string, unknown>) : {}),
		notifyResolved: b.notifyResolved !== false
	};
}

export function parseSettings(body: unknown): AlertSettings {
	const b = obj(body);
	const interval = Number(b.intervalSeconds);
	const renotify = Number(b.renotifyHours);
	const publicUrl = typeof b.publicUrl === 'string' ? b.publicUrl.trim().replace(/\/+$/, '') : '';
	checkUrl('Public URL', publicUrl || undefined);
	return {
		intervalSeconds: Number.isFinite(interval) ? Math.min(3600, Math.max(30, Math.round(interval))) : 60,
		renotifyHours: Number.isFinite(renotify) ? Math.min(24 * 30, Math.max(0, renotify)) : 6,
		publicUrl
	};
}
