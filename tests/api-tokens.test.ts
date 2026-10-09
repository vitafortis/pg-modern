import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

process.env.PGM_DATA_DIR = mkdtempSync(join(tmpdir(), 'pgm-tokens-test-'));
process.env.PGM_SECRET_KEY = 'test-key-for-tokens';
const t = await import('../src/lib/server/api-tokens.ts');
const { sqlite } = await import('../src/lib/server/store.ts');
const { statusBadge } = await import('../src/lib/server/status.ts');

const req = (method: string, path: string, opts: { bearer?: string; query?: string; ip?: string } = {}) => {
	const url = new URL(`http://pgm.local${path}${opts.query ? `?${opts.query}` : ''}`);
	const headers = new Headers(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {});
	return { method, path, headers, url, ip: opts.ip ?? '10.0.0.1' };
};

test('tokens look like pgm_ + 32 random bytes and only their hash is stored', () => {
	const { token, record } = t.createToken({ name: 'homepage', expiresAt: null, includeAddresses: false }, { id: 'u', email: 'a@x.io' });
	assert.match(token, /^pgm_[A-Za-z0-9_-]{43}$/);
	assert.equal(Buffer.from(token.slice(4), 'base64url').length, 32);
	assert.ok(record.prefix.startsWith('pgm_') && token.startsWith(record.prefix));
	const row = sqlite().prepare('SELECT * FROM api_tokens WHERE id = ?').get(record.id) as Record<string, unknown>;
	assert.equal(row.token_hash, createHash('sha256').update(token).digest('hex'));
	assert.ok(!JSON.stringify(row).includes(token), 'the token itself is never stored');
	assert.ok(t.tokenMatches(token, row.token_hash as string));
	assert.ok(!t.tokenMatches(`${token}x`, row.token_hash as string));
	assert.notEqual(t.generateToken(), t.generateToken());
});

test('verification: valid, revoked, expired, malformed', () => {
	const { token, record } = t.createToken({ name: 'kuma', expiresAt: null, includeAddresses: true }, null);
	const p = t.verifyToken(token, 'status');
	assert.deepEqual(p, { id: record.id, name: 'kuma', scope: 'status', includeAddresses: true });
	assert.ok(t.getToken(record.id)!.lastUsedAt, 'last use is recorded');

	assert.equal(t.verifyToken('pgm_nope', 'status'), null);
	assert.equal(t.verifyToken(token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), 'status'), null);

	const expired = t.createToken({ name: 'old', expiresAt: new Date(Date.now() - 1000).toISOString(), includeAddresses: false }, null);
	assert.equal(t.verifyToken(expired.token, 'status'), null);

	t.revokeToken(record.id);
	assert.equal(t.verifyToken(token, 'status'), null);
	assert.ok(t.getToken(record.id)!.revokedAt);
});

test('tokens only open the status routes, and only for GET', () => {
	for (const p of ['/api/status', '/api/status/abc', '/api/status/badge/abc.svg']) assert.ok(t.isStatusRoute(p), p);
	for (const p of ['/api/connections', '/api/connections/abc', '/api/statusx', '/api/status/a/b', '/api/queries', '/', '/c/abc', '/api/integrations/tokens']) {
		assert.ok(!t.isStatusRoute(p), p);
		assert.ok(!t.tokenAllowed('GET', p), p);
	}
	assert.ok(!t.tokenAllowed('POST', '/api/status'));
	assert.ok(!t.tokenAllowed('DELETE', '/api/status/abc'));

	const { token } = t.createToken({ name: 'glance', expiresAt: null, includeAddresses: false }, null);
	assert.equal(t.authorizeStatusRequest(req('GET', '/api/status', { bearer: token })).ok, true);
	assert.equal(t.authorizeStatusRequest(req('GET', '/api/status/badge/x.svg', { query: `token=${token}` })).ok, true);
	const noToken = t.authorizeStatusRequest(req('GET', '/api/status'));
	assert.equal(!noToken.ok && noToken.status, 401);
	const post = t.authorizeStatusRequest(req('POST', '/api/status', { bearer: token }));
	assert.equal(!post.ok && post.status, 405);
	const other = t.authorizeStatusRequest(req('GET', '/api/connections', { bearer: token }));
	assert.equal(!other.ok && other.status, 404);
});

test('bearer header and ?token= are both read; header wins', () => {
	const h = new Headers({ authorization: 'Bearer pgm_header' });
	assert.equal(t.presentedToken(h, new URL('http://x/api/status?token=pgm_query')), 'pgm_header');
	assert.equal(t.presentedToken(new Headers(), new URL('http://x/api/status?token=pgm_query')), 'pgm_query');
	assert.equal(t.presentedToken(new Headers({ authorization: 'Basic abc' }), new URL('http://x/api/status')), null);
});

test('repeated bad tokens from one address are throttled', () => {
	const bad = 'pgm_' + 'A'.repeat(43);
	let last;
	for (let i = 0; i < 21; i++) last = t.authorizeStatusRequest(req('GET', '/api/status', { bearer: bad, ip: '10.9.9.9' }));
	assert.equal(!last!.ok && last!.status, 429);
	const { token } = t.createToken({ name: 'other ip', expiresAt: null, includeAddresses: false }, null);
	assert.equal(t.authorizeStatusRequest(req('GET', '/api/status', { bearer: token, ip: '10.1.1.1' })).ok, true);
});

test('token input validation', () => {
	assert.throws(() => t.parseTokenInput({}), /name/);
	assert.throws(() => t.parseTokenInput({ name: 'x', expiresInDays: -3 }), /expiresInDays/);
	const now = Date.parse('2026-01-01T00:00:00Z');
	assert.deepEqual(t.parseTokenInput({ name: ' x ', expiresInDays: 30, includeAddresses: true }, now), {
		name: 'x',
		expiresAt: '2026-01-31T00:00:00.000Z',
		includeAddresses: true
	});
	assert.equal(t.parseTokenInput({ name: 'x' }).includeAddresses, false, 'addresses are off by default');
});

test('badge escapes its label', () => {
	const svg = statusBadge('<db & "x">', { status: 'up', latencyMs: 4 });
	assert.ok(!svg.includes('<db'));
	assert.match(svg, /&lt;db &amp; &quot;x&quot;&gt;/);
	assert.match(svg, /up 4 ms/);
	assert.match(statusBadge('db', { status: 'down', latencyMs: null }), /#e5534b/);
});
