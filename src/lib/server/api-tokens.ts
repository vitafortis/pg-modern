/**
 * Read-only API tokens for dashboards (Homepage, Glance, Uptime Kuma, Home Assistant).
 *
 * A token is `pgm_` + 32 random bytes (base64url), shown once; only its SHA-256 is
 * stored. Tokens are never sessions: hooks.server.ts accepts them on the status routes
 * (`STATUS_ROUTE`) and nowhere else, and only for GET.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { sha256 } from './crypto.ts';
import { BadRequest } from './http.ts';
import { sqlite } from './store.ts';
import type { User } from '#lib/types.ts';

export const TOKEN_PREFIX = 'pgm_';

export type TokenScope = 'status';

export interface ApiToken {
	id: string;
	name: string;
	/** First characters, to tell tokens apart in the list (`pgm_AbCd…`). */
	prefix: string;
	scope: TokenScope;
	includeAddresses: boolean;
	expiresAt: string | null;
	createdBy: string | null;
	createdAt: string;
	lastUsedAt: string | null;
	revokedAt: string | null;
}

/** What a route sees after a token authenticated (event.locals.apiToken). */
export interface TokenPrincipal {
	id: string;
	name: string;
	scope: TokenScope;
	includeAddresses: boolean;
}

/** The only paths a token opens: GET /api/status, /api/status/<id>, /api/status/badge/<id>.svg. */
export const STATUS_ROUTE = /^\/api\/status(?:\/badge\/[^/]+\.svg|\/[^/]+)?\/?$/;

export function isStatusRoute(path: string): boolean {
	return STATUS_ROUTE.test(path);
}

/** Whether a token may be used for this request at all. */
export function tokenAllowed(method: string, path: string): boolean {
	return (method === 'GET' || method === 'HEAD') && isStatusRoute(path);
}

export function generateToken(): string {
	return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export const hashToken = (token: string) => sha256(token);

/** Constant-time check of a presented token against a stored hash. */
export function tokenMatches(token: string, storedHash: string): boolean {
	const a = Buffer.from(hashToken(token), 'hex');
	const b = Buffer.from(storedHash, 'hex');
	return a.length === b.length && timingSafeEqual(a, b);
}

/** A token from `Authorization: Bearer …`, or `?token=` for widgets that can't set headers. */
export function presentedToken(headers: Headers, url: URL): string | null {
	const auth = headers.get('authorization');
	const m = auth ? /^Bearer\s+(\S+)\s*$/i.exec(auth) : null;
	if (m) return m[1];
	return url.searchParams.get('token') || null;
}

/** Well-formed tokens only, so junk never reaches the database. */
export function looksLikeToken(token: string): boolean {
	return token.startsWith(TOKEN_PREFIX) && /^[A-Za-z0-9_-]{40,60}$/.test(token.slice(TOKEN_PREFIX.length));
}

type Row = Record<string, unknown>;

function toToken(r: Row): ApiToken {
	return {
		id: r.id as string,
		name: r.name as string,
		prefix: r.prefix as string,
		scope: r.scope as TokenScope,
		includeAddresses: r.include_addresses === 1,
		expiresAt: (r.expires_at as string) ?? null,
		createdBy: (r.created_by_email as string) ?? null,
		createdAt: r.created_at as string,
		lastUsedAt: (r.last_used_at as string) ?? null,
		revokedAt: (r.revoked_at as string) ?? null
	};
}

export function listTokens(): ApiToken[] {
	return (sqlite().prepare('SELECT * FROM api_tokens ORDER BY revoked_at IS NOT NULL, created_at DESC').all() as Row[]).map(toToken);
}

export function getToken(id: string): ApiToken | undefined {
	const r = sqlite().prepare('SELECT * FROM api_tokens WHERE id = ?').get(id) as Row | undefined;
	return r && toToken(r);
}

export interface TokenInput {
	name: string;
	expiresAt: string | null;
	includeAddresses: boolean;
}

export function parseTokenInput(body: unknown, now = Date.now()): TokenInput {
	if (!body || typeof body !== 'object') throw new BadRequest('Expected a JSON object');
	const b = body as Record<string, unknown>;
	const name = typeof b.name === 'string' ? b.name.trim() : '';
	if (!name) throw new BadRequest('"name" is required');
	if (name.length > 80) throw new BadRequest('"name" is too long (80 characters at most)');
	let expiresAt: string | null = null;
	if (b.expiresInDays != null && b.expiresInDays !== '' && b.expiresInDays !== 0) {
		const days = Number(b.expiresInDays);
		if (!Number.isFinite(days) || days < 1 || days > 3650) throw new BadRequest('"expiresInDays" must be 1–3650');
		expiresAt = new Date(now + Math.round(days) * 86_400_000).toISOString();
	}
	return { name, expiresAt, includeAddresses: b.includeAddresses === true };
}

/** Creates a token and returns it in full — the only time it's ever available. */
export function createToken(input: TokenInput, by: Pick<User, 'id' | 'email'> | null): { token: string; record: ApiToken } {
	const token = generateToken();
	const id = randomUUID();
	sqlite()
		.prepare(
			`INSERT INTO api_tokens (id, name, token_hash, prefix, scope, include_addresses, expires_at, created_by, created_by_email, created_at)
			 VALUES (?, ?, ?, ?, 'status', ?, ?, ?, ?, ?)`
		)
		.run(id, input.name, hashToken(token), token.slice(0, TOKEN_PREFIX.length + 6), input.includeAddresses ? 1 : 0, input.expiresAt, by?.id ?? null, by?.email ?? null, new Date().toISOString());
	return { token, record: getToken(id)! };
}

export function revokeToken(id: string): boolean {
	return Number(sqlite().prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(new Date().toISOString(), id).changes) > 0;
}

export function deleteToken(id: string): boolean {
	return Number(sqlite().prepare('DELETE FROM api_tokens WHERE id = ?').run(id).changes) > 0;
}

// --- request authorization (used by hooks.server.ts) ------------------------------------

const failures = new Map<string, number[]>();
const FAIL_WINDOW_MS = 5 * 60_000;
const MAX_FAILURES = 20;

function tooManyFailures(key: string): boolean {
	const now = Date.now();
	const recent = (failures.get(key) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
	failures.set(key, recent);
	return recent.length >= MAX_FAILURES;
}

export type StatusAuth = { ok: true; principal: TokenPrincipal } | { ok: false; status: number; message: string };

/**
 * Decides a request to a status route: GET/HEAD only, with a valid status token.
 * Repeated bad tokens from one address are throttled (20 per 5 minutes).
 */
export function authorizeStatusRequest(req: { method: string; path: string; headers: Headers; url: URL; ip?: string }): StatusAuth {
	if (!isStatusRoute(req.path)) return { ok: false, status: 404, message: 'Not found' };
	if (!tokenAllowed(req.method, req.path)) return { ok: false, status: 405, message: 'Only GET is supported' };
	const key = req.ip ?? 'unknown';
	if (tooManyFailures(key)) return { ok: false, status: 429, message: 'Too many invalid tokens; try again later' };
	const token = presentedToken(req.headers, req.url);
	if (!token) return { ok: false, status: 401, message: 'API token required (Authorization: Bearer pgm_…)' };
	const principal = verifyToken(token, 'status', req.ip);
	if (!principal) {
		failures.get(key)!.push(Date.now());
		return { ok: false, status: 401, message: 'Invalid, expired or revoked API token' };
	}
	return { ok: true, principal };
}

const lastTouched = new Map<string, number>();

/**
 * The token's principal if it's valid for `scope`: known, not revoked, not expired.
 * Records when it was last used (at most once a minute per token).
 */
export function verifyToken(token: string, scope: TokenScope, ip?: string): TokenPrincipal | null {
	if (!looksLikeToken(token)) return null;
	const r = sqlite().prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(hashToken(token)) as Row | undefined;
	if (!r || !tokenMatches(token, r.token_hash as string)) return null;
	const t = toToken(r);
	if (t.revokedAt) return null;
	if (t.expiresAt && Date.parse(t.expiresAt) <= Date.now()) return null;
	if (t.scope !== scope) return null;
	const now = Date.now();
	if (now - (lastTouched.get(t.id) ?? 0) > 60_000) {
		lastTouched.set(t.id, now);
		sqlite().prepare('UPDATE api_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?').run(new Date(now).toISOString(), ip ?? null, t.id);
	}
	return { id: t.id, name: t.name, scope: t.scope, includeAddresses: t.includeAddresses };
}
