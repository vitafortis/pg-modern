/**
 * Alert rules, channels and size history: shapes shared by the server and the browser.
 * Kept out of types.ts so the feature stays self-contained.
 */

export type AlertRuleKind = 'unreachable' | 'connections' | 'long_query' | 'size_above' | 'size_growth' | 'wraparound' | 'replication_lag';
export type Severity = 'critical' | 'warning';

export interface RuleParam {
	key: string;
	label: string;
	unit: string;
	min: number;
	max: number;
	default: number;
}

export interface RuleDef {
	label: string;
	description: string;
	severity: Severity;
	params: RuleParam[];
	/** Created enabled with the default rule set. */
	defaultEnabled: boolean;
	/** Only evaluated on Postgres connections. */
	postgresOnly?: boolean;
}

export const RULE_KINDS: AlertRuleKind[] = ['unreachable', 'connections', 'long_query', 'size_above', 'size_growth', 'wraparound', 'replication_lag'];

export const RULES: Record<AlertRuleKind, RuleDef> = {
	unreachable: {
		label: 'Database unreachable',
		description: 'pg·modern can’t connect for several checks in a row. Resolves (and notifies "recovered") once it answers again.',
		severity: 'critical',
		params: [{ key: 'failures', label: 'Consecutive failed checks', unit: 'checks', min: 1, max: 60, default: 2 }],
		defaultEnabled: true
	},
	connections: {
		label: 'Connections near the limit',
		description: 'Client connections in use, as a share of max_connections.',
		severity: 'warning',
		params: [{ key: 'percent', label: 'Used above', unit: '%', min: 1, max: 100, default: 80 }],
		defaultEnabled: true
	},
	long_query: {
		label: 'Long-running query',
		description: 'An active query has run longer than this. Idle sessions, replication and autovacuum are ignored.',
		severity: 'warning',
		params: [{ key: 'minutes', label: 'Running longer than', unit: 'min', min: 1, max: 1440, default: 15 }],
		defaultEnabled: true
	},
	size_above: {
		label: 'Database size above',
		description: 'The connection’s database (all user databases on a MySQL login without a default database) grows past a fixed size.',
		severity: 'warning',
		params: [{ key: 'gb', label: 'Size above', unit: 'GB', min: 0.1, max: 100000, default: 50 }],
		defaultEnabled: false
	},
	size_growth: {
		label: 'Fast database growth',
		description: 'The database grew by more than this in the last 24 hours (needs a day of size history).',
		severity: 'warning',
		params: [{ key: 'percent', label: 'Grew more than', unit: '% / 24h', min: 1, max: 10000, default: 25 }],
		defaultEnabled: true
	},
	wraparound: {
		label: 'Transaction ID wraparound',
		description: 'The oldest unfrozen transaction ID, age(datfrozenxid), as a share of the 2³¹ limit. Postgres only.',
		severity: 'critical',
		params: [{ key: 'percent', label: 'Age above', unit: '% of 2³¹', min: 1, max: 99, default: 50 }],
		defaultEnabled: true,
		postgresOnly: true
	},
	replication_lag: {
		label: 'Replication lag',
		description: 'Replay lag of any replica (on a primary) or of this server (on a replica). Skipped when there is no replication.',
		severity: 'warning',
		params: [{ key: 'seconds', label: 'Lag above', unit: 's', min: 1, max: 86400, default: 300 }],
		defaultEnabled: true
	}
};

export function isRuleKind(v: unknown): v is AlertRuleKind {
	return typeof v === 'string' && (RULE_KINDS as string[]).includes(v);
}

/** Default parameter values for a rule kind. */
export function defaultParams(kind: AlertRuleKind): Record<string, number> {
	return Object.fromEntries(RULES[kind].params.map((p) => [p.key, p.default]));
}

export interface AlertRule {
	id: string;
	kind: AlertRuleKind;
	/** null: every connection (unless a connection has its own rule of this kind). */
	connectionId: string | null;
	enabled: boolean;
	params: Record<string, number>;
	/** Also notify when the alert resolves ("recovered"). */
	notifyResolved: boolean;
	createdAt: string;
	updatedAt: string;
}

export type ChannelKind = 'ntfy' | 'gotify' | 'discord' | 'slack' | 'webhook' | 'apprise';

export interface ChannelField {
	key: string;
	label: string;
	placeholder?: string;
	/** Stored encrypted and never sent back to the browser. */
	secret?: boolean;
	required?: boolean;
	help?: string;
}

export const CHANNEL_KINDS: ChannelKind[] = ['ntfy', 'gotify', 'discord', 'slack', 'webhook', 'apprise'];

export const CHANNELS: Record<ChannelKind, { label: string; description: string; fields: ChannelField[] }> = {
	ntfy: {
		label: 'ntfy',
		description: 'Push notifications through ntfy.sh or your own ntfy server.',
		fields: [
			{ key: 'server', label: 'Server URL', placeholder: 'https://ntfy.sh', required: true },
			{ key: 'topic', label: 'Topic', placeholder: 'homelab-databases', required: true },
			{ key: 'token', label: 'Access token', placeholder: 'tk_… (optional)', secret: true }
		]
	},
	gotify: {
		label: 'Gotify',
		description: 'Messages to a Gotify application.',
		fields: [
			{ key: 'url', label: 'Server URL', placeholder: 'https://gotify.example.com', required: true },
			{ key: 'token', label: 'Application token', secret: true, required: true }
		]
	},
	discord: {
		label: 'Discord',
		description: 'A Discord channel webhook (Server settings → Integrations → Webhooks).',
		fields: [{ key: 'url', label: 'Webhook URL', placeholder: 'https://discord.com/api/webhooks/…', secret: true, required: true }]
	},
	slack: {
		label: 'Slack-compatible',
		description: 'Incoming webhooks for Slack, Mattermost, Rocket.Chat and others that accept Slack’s format.',
		fields: [{ key: 'url', label: 'Webhook URL', placeholder: 'https://hooks.slack.com/services/…', secret: true, required: true }]
	},
	webhook: {
		label: 'Webhook (JSON)',
		description: 'POSTs a JSON document to any URL (n8n, Home Assistant, Node-RED, your own service).',
		fields: [
			{ key: 'url', label: 'URL', placeholder: 'https://example.com/hooks/pg-modern', secret: true, required: true },
			{ key: 'authorization', label: 'Authorization header', placeholder: 'Bearer … (optional)', secret: true }
		]
	},
	apprise: {
		label: 'Apprise API',
		description: 'An Apprise API notify endpoint, which fans out to anything Apprise supports.',
		fields: [
			{ key: 'url', label: 'Notify URL', placeholder: 'http://apprise:8000/notify/pg-modern', secret: true, required: true },
			{ key: 'tag', label: 'Tag', placeholder: 'optional' }
		]
	}
};

export function isChannelKind(v: unknown): v is ChannelKind {
	return typeof v === 'string' && (CHANNEL_KINDS as string[]).includes(v);
}

/** A channel as the browser sees it: secrets only as "set" plus a harmless hint. */
export interface AlertChannel {
	id: string;
	name: string;
	kind: ChannelKind;
	enabled: boolean;
	config: Record<string, string>;
	/** Secret field → a redacted hint (e.g. `discord.com/…`); absent when not set. */
	secrets: Record<string, string>;
	lastSentAt: string | null;
	lastError: string | null;
	createdAt: string;
}

export type AlertTransition = 'fired' | 'resolved' | 'renotified';

export interface AlertEvent {
	id: number;
	at: string;
	ruleId: string | null;
	ruleKind: AlertRuleKind;
	connectionId: string | null;
	connectionName: string | null;
	event: AlertTransition;
	severity: Severity;
	message: string;
	/** Channels the notification reached. */
	delivered: number;
	error: string | null;
}

export interface ActiveAlert {
	ruleId: string;
	ruleKind: AlertRuleKind;
	connectionId: string;
	connectionName: string;
	severity: Severity;
	since: string;
	message: string;
	lastNotifiedAt: string | null;
}

export interface AlertSettings {
	/** How often checks run. */
	intervalSeconds: number;
	/** Re-notify a still-firing alert after this long; 0 never. */
	renotifyHours: number;
	/** pg·modern's address, for links in notifications. */
	publicUrl: string;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = { intervalSeconds: 60, renotifyHours: 6, publicUrl: '' };

/** Firing alerts for one connection, for badges. */
export interface FiringSummary {
	count: number;
	critical: boolean;
	titles: string[];
}

// --- size history ------------------------------------------------------------------

export type GrowthRange = '7d' | '30d' | '1y';
export const GROWTH_RANGES: GrowthRange[] = ['7d', '30d', '1y'];

export interface SizePoint {
	/** Epoch ms. */
	at: number;
	bytes: number;
}

export interface TableGrowth {
	schema: string;
	name: string;
	bytes: number;
	/** Change since the first sample in the range. */
	delta: number;
	/** null when the table first appeared in the range. */
	deltaPct: number | null;
}

export interface GrowthData {
	range: GrowthRange;
	series: SizePoint[];
	tables: TableGrowth[];
	lastSampleAt: number | null;
}
