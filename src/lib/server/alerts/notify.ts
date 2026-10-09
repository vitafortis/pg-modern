/**
 * Notification channels: how an alert is formatted for each service, and sending it.
 * `buildRequest` is pure (tested); `deliver` does the HTTP call.
 */
import type { AlertRuleKind, AlertTransition, ChannelKind, Severity } from '#lib/alerts.ts';

export interface Notification {
	event: AlertTransition | 'test';
	severity: Severity;
	/** e.g. "Database unreachable" */
	title: string;
	message: string;
	connection: { id: string; name: string; engine: string } | null;
	rule: { id: string; kind: AlertRuleKind } | null;
	value: number | null;
	/** When the alert started firing (ISO). */
	since: string | null;
	at: string;
	/** Link to the connection in pg·modern, when a public URL is configured. */
	url: string | null;
}

export interface OutgoingRequest {
	url: string;
	headers: Record<string, string>;
	body: string;
}

const LABEL: Record<Notification['event'], string> = {
	fired: 'FIRING',
	resolved: 'RESOLVED',
	renotified: 'STILL FIRING',
	test: 'TEST'
};

/** One-line subject, e.g. "[FIRING] nextcloud-db: Database unreachable". */
export function subject(n: Notification): string {
	return `[${LABEL[n.event]}] ${n.connection ? `${n.connection.name}: ` : ''}${n.title}`;
}

const tone = (n: Notification): 'ok' | 'critical' | 'warning' | 'info' =>
	n.event === 'resolved' ? 'ok' : n.event === 'test' ? 'info' : n.severity;

const trimSlash = (s: string) => s.replace(/\/+$/, '');

/**
 * The JSON body POSTed to generic webhooks. Documented in the README; `version`
 * changes only if the shape does.
 */
export function webhookPayload(n: Notification) {
	return {
		source: 'pg-modern',
		version: 1,
		event: n.event,
		severity: n.severity,
		status: n.event === 'resolved' ? 'resolved' : n.event === 'test' ? 'test' : 'firing',
		title: subject(n),
		alert: n.title,
		message: n.message,
		rule: n.rule,
		connection: n.connection,
		value: n.value,
		since: n.since,
		at: n.at,
		url: n.url
	};
}

const DISCORD_COLORS = { ok: 0x22c55e, critical: 0xef4444, warning: 0xf59e0b, info: 0x8b5cf6 };
const SLACK_COLORS = { ok: '#22c55e', critical: '#ef4444', warning: '#f59e0b', info: '#8b5cf6' };

export function buildRequest(kind: ChannelKind, config: Record<string, string>, secrets: Record<string, string>, n: Notification): OutgoingRequest {
	const json = { 'content-type': 'application/json' };
	const t = tone(n);
	switch (kind) {
		case 'ntfy': {
			// JSON publishing: POST to the server root with the topic in the body.
			const headers: Record<string, string> = { ...json };
			if (secrets.token) headers.authorization = `Bearer ${secrets.token}`;
			return {
				url: trimSlash(config.server || 'https://ntfy.sh'),
				headers,
				body: JSON.stringify({
					topic: config.topic,
					title: subject(n),
					message: n.message,
					priority: t === 'critical' ? 5 : t === 'warning' ? 4 : 3,
					tags: [t === 'ok' ? 'white_check_mark' : t === 'critical' ? 'rotating_light' : t === 'warning' ? 'warning' : 'bell', 'pg-modern'],
					...(n.url ? { click: n.url } : {})
				})
			};
		}
		case 'gotify':
			return {
				url: `${trimSlash(config.url)}/message`,
				headers: { ...json, 'x-gotify-key': secrets.token ?? '' },
				body: JSON.stringify({
					title: subject(n),
					message: n.message,
					priority: t === 'critical' ? 8 : t === 'warning' ? 5 : 2,
					...(n.url ? { extras: { 'client::notification': { click: { url: n.url } } } } : {})
				})
			};
		case 'discord':
			return {
				url: secrets.url,
				headers: json,
				body: JSON.stringify({
					username: 'pg·modern',
					embeds: [
						{
							title: subject(n).slice(0, 256),
							description: n.message.slice(0, 4000),
							color: DISCORD_COLORS[t],
							timestamp: n.at,
							...(n.url ? { url: n.url } : {}),
							...(n.connection ? { footer: { text: `${n.connection.name} · ${n.connection.engine}` } } : {})
						}
					]
				})
			};
		case 'slack':
			return {
				url: secrets.url,
				headers: json,
				body: JSON.stringify({
					text: subject(n),
					attachments: [
						{
							color: SLACK_COLORS[t],
							title: n.title,
							...(n.url ? { title_link: n.url } : {}),
							text: n.message,
							footer: n.connection ? `pg·modern · ${n.connection.name}` : 'pg·modern',
							ts: Math.floor(new Date(n.at).getTime() / 1000)
						}
					]
				})
			};
		case 'webhook': {
			const headers: Record<string, string> = { ...json, 'user-agent': 'pg-modern' };
			if (secrets.authorization) headers.authorization = secrets.authorization;
			return { url: secrets.url, headers, body: JSON.stringify(webhookPayload(n)) };
		}
		case 'apprise':
			return {
				url: secrets.url,
				headers: json,
				body: JSON.stringify({
					title: subject(n),
					body: n.url ? `${n.message}\n${n.url}` : n.message,
					type: t === 'ok' ? 'success' : t === 'critical' ? 'failure' : t === 'warning' ? 'warning' : 'info',
					...(config.tag ? { tag: config.tag } : {})
				})
			};
	}
}

/** Sends a notification; throws with the service's answer on failure. */
export async function deliver(kind: ChannelKind, config: Record<string, string>, secrets: Record<string, string>, n: Notification): Promise<void> {
	const req = buildRequest(kind, config, secrets, n);
	if (!/^https?:\/\//i.test(req.url ?? '')) throw new Error('The channel has no valid http(s) URL');
	let res: Response;
	try {
		res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(10_000), redirect: 'error' });
	} catch (err) {
		const cause = (err as { cause?: { code?: string; message?: string } }).cause;
		throw new Error(cause?.code ?? cause?.message ?? (err as Error).message);
	}
	if (!res.ok) {
		const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
		throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ''}`);
	}
}

/** A safe-to-show hint for a secret: the host of a URL, or that a token is set. */
export function secretHint(value: string): string {
	try {
		const u = new URL(value);
		return `${u.host}/…`;
	} catch {
		return '••••••';
	}
}
