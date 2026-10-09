import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, subject, webhookPayload, secretHint, type Notification } from '../src/lib/server/alerts/notify.ts';

const n: Notification = {
	event: 'fired',
	severity: 'critical',
	title: 'Database unreachable',
	message: 'Can’t connect: ECONNREFUSED',
	connection: { id: 'c1', name: 'nextcloud-db', engine: 'postgres' },
	rule: { id: 'r1', kind: 'unreachable' },
	value: null,
	since: '2026-10-09T10:00:00.000Z',
	at: '2026-10-09T10:01:00.000Z',
	url: 'https://pgm.lan/c/c1'
};

test('subject line', () => {
	assert.equal(subject(n), '[FIRING] nextcloud-db: Database unreachable');
	assert.equal(subject({ ...n, event: 'resolved' }), '[RESOLVED] nextcloud-db: Database unreachable');
	assert.equal(subject({ ...n, event: 'test', connection: null, title: 'Test notification' }), '[TEST] Test notification');
});

test('ntfy: JSON publish to the server root with topic, priority and token', () => {
	const r = buildRequest('ntfy', { server: 'https://ntfy.example.com/', topic: 'dbs' }, { token: 'tk_abc' }, n);
	assert.equal(r.url, 'https://ntfy.example.com');
	assert.equal(r.headers.authorization, 'Bearer tk_abc');
	const body = JSON.parse(r.body);
	assert.equal(body.topic, 'dbs');
	assert.equal(body.priority, 5);
	assert.equal(body.click, 'https://pgm.lan/c/c1');
	assert.ok(body.tags.includes('rotating_light'));
	const resolved = JSON.parse(buildRequest('ntfy', { topic: 'dbs' }, {}, { ...n, event: 'resolved' }).body);
	assert.equal(resolved.priority, 3);
	assert.equal(buildRequest('ntfy', { topic: 'dbs' }, {}, n).headers.authorization, undefined);
});

test('gotify: /message with the app token header', () => {
	const r = buildRequest('gotify', { url: 'https://gotify.lan/' }, { token: 'AppTok' }, { ...n, severity: 'warning' });
	assert.equal(r.url, 'https://gotify.lan/message');
	assert.equal(r.headers['x-gotify-key'], 'AppTok');
	const body = JSON.parse(r.body);
	assert.equal(body.priority, 5);
	assert.equal(body.extras['client::notification'].click.url, 'https://pgm.lan/c/c1');
});

test('discord: an embed coloured by state', () => {
	const r = buildRequest('discord', {}, { url: 'https://discord.com/api/webhooks/1/x' }, n);
	assert.equal(r.url, 'https://discord.com/api/webhooks/1/x');
	const e = JSON.parse(r.body).embeds[0];
	assert.equal(e.title, '[FIRING] nextcloud-db: Database unreachable');
	assert.equal(e.color, 0xef4444);
	assert.equal(e.timestamp, n.at);
	assert.equal(JSON.parse(buildRequest('discord', {}, { url: 'x' }, { ...n, event: 'resolved' }).body).embeds[0].color, 0x22c55e);
});

test('slack-compatible: text plus a coloured attachment', () => {
	const body = JSON.parse(buildRequest('slack', {}, { url: 'https://hooks.slack.com/services/x' }, n).body);
	assert.equal(body.text, '[FIRING] nextcloud-db: Database unreachable');
	assert.equal(body.attachments[0].color, '#ef4444');
	assert.equal(body.attachments[0].title_link, 'https://pgm.lan/c/c1');
	assert.equal(body.attachments[0].ts, Math.floor(Date.parse(n.at) / 1000));
});

test('generic webhook: documented JSON body and optional auth header', () => {
	const r = buildRequest('webhook', {}, { url: 'https://hook.lan/x', authorization: 'Bearer t' }, n);
	assert.equal(r.headers.authorization, 'Bearer t');
	assert.deepEqual(JSON.parse(r.body), webhookPayload(n));
	assert.deepEqual(Object.keys(webhookPayload(n)), ['source', 'version', 'event', 'severity', 'status', 'title', 'alert', 'message', 'rule', 'connection', 'value', 'since', 'at', 'url']);
	assert.equal(webhookPayload({ ...n, event: 'renotified' }).status, 'firing');
	assert.equal(webhookPayload({ ...n, event: 'resolved' }).status, 'resolved');
});

test('apprise: title/body/type, with an optional tag', () => {
	const body = JSON.parse(buildRequest('apprise', { tag: 'ops' }, { url: 'http://apprise:8000/notify/k' }, n).body);
	assert.equal(body.type, 'failure');
	assert.equal(body.tag, 'ops');
	assert.match(body.body, /ECONNREFUSED\nhttps:\/\/pgm\.lan\/c\/c1/);
	assert.equal(JSON.parse(buildRequest('apprise', {}, { url: 'x' }, { ...n, event: 'resolved' }).body).type, 'success');
});

test('secret hints reveal only the host', () => {
	assert.equal(secretHint('https://discord.com/api/webhooks/1/token'), 'discord.com/…');
	assert.equal(secretHint('tk_secret'), '••••••');
});
