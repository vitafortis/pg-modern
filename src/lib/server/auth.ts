import type { Cookies } from '@sveltejs/kit';
import { config } from './config.ts';
import { randomToken, sha256 } from './crypto.ts';
import { createSession, deleteSession, getAdminPasswordHash, sessionValid } from './store.ts';

export const SESSION_COOKIE = 'pgm_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type AuthState = 'disabled' | 'setup' | 'anonymous' | 'authenticated';

export function authState(cookies: Cookies): AuthState {
	if (config.authDisabled) return 'disabled';
	if (!getAdminPasswordHash()) return 'setup';
	const token = cookies.get(SESSION_COOKIE);
	return token && sessionValid(sha256(token)) ? 'authenticated' : 'anonymous';
}

export function startSession(cookies: Cookies, secure: boolean) {
	const token = randomToken();
	createSession(sha256(token), SESSION_TTL_MS);
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'strict',
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
