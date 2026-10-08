import type { Cookies } from '@sveltejs/kit';
import { config } from './config.ts';
import { randomToken, sha256 } from './crypto.ts';
import { countUsers, createSession, deleteSession, sessionUser, touchUserLogin } from './store.ts';
import type { User } from '#lib/types.ts';

export const SESSION_COOKIE = 'pgm_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type AuthState = 'disabled' | 'setup' | 'anonymous' | 'authenticated';

/** Stand-in user when PGM_AUTH=disabled. */
const OPEN_USER: User = {
	id: 'open',
	email: 'admin',
	name: 'Admin',
	role: 'admin',
	hasPassword: false,
	sso: false,
	disabled: false,
	createdAt: new Date(0).toISOString(),
	lastLoginAt: null
};

export function authenticate(cookies: Cookies): { state: AuthState; user: User | null } {
	if (config.authDisabled) return { state: 'disabled', user: OPEN_USER };
	if (countUsers() === 0) return { state: 'setup', user: null };
	const token = cookies.get(SESSION_COOKIE);
	const user = token ? sessionUser(sha256(token)) : undefined;
	return user ? { state: 'authenticated', user } : { state: 'anonymous', user: null };
}

export function startSession(cookies: Cookies, userId: string, secure: boolean) {
	const token = randomToken();
	createSession(sha256(token), userId, SESSION_TTL_MS);
	touchUserLogin(userId);
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		// Lax (not Strict) so the cookie survives the redirect back from an SSO provider.
		// Cross-site writes are still blocked by the Origin check in hooks.server.ts.
		sameSite: 'lax',
		secure,
		maxAge: SESSION_TTL_MS / 1000
	});
}

export function endSession(cookies: Cookies) {
	const token = cookies.get(SESSION_COOKIE);
	if (token) deleteSession(sha256(token));
	cookies.delete(SESSION_COOKIE, { path: '/' });
}

// Simple in-memory login throttle: 10 attempts per 5 minutes per client address.
const attempts = new Map<string, number[]>();
export function throttled(key: string): boolean {
	const now = Date.now();
	const recent = (attempts.get(key) ?? []).filter((t) => now - t < 5 * 60_000);
	recent.push(now);
	attempts.set(key, recent);
	return recent.length > 10;
}

/** Matches an email against patterns like `alice@example.com`, `*@example.com` or `*`. */
export function emailMatches(email: string, patterns: string[]): boolean {
	const e = email.trim().toLowerCase();
	return patterns.some((raw) => {
		const p = raw.trim().toLowerCase();
		if (!p) return false;
		if (p === '*') return true;
		if (p.startsWith('*@')) return e.endsWith(p.slice(1));
		if (p.startsWith('@')) return e.endsWith(p);
		return e === p;
	});
}
