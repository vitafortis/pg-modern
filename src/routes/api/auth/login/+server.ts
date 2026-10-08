import { json } from '@sveltejs/kit';
import { startSession, throttled } from '#lib/server/auth.ts';
import { localLoginDisabled } from '#lib/server/sso.ts';
import { hashPassword, verifyPassword } from '#lib/server/crypto.ts';
import { findUserByEmail, getPasswordHash } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

// Verified against when the user doesn't exist, so timing doesn't reveal valid emails.
const DUMMY_HASH = hashPassword('pg-modern-dummy-password');

export const POST: RequestHandler = async ({ request, cookies, locals, getClientAddress }) => {
	if (localLoginDisabled()) return json({ message: 'Password sign-in is disabled; use SSO' }, { status: 403 });
	if (throttled(getClientAddress())) return json({ message: 'Too many attempts — wait a few minutes' }, { status: 429 });
	const { email, password } = await request.json();
	if (typeof email !== 'string' || typeof password !== 'string') return json({ message: 'Incorrect email or password' }, { status: 401 });
	const user = findUserByEmail(email);
	const hash = user && !user.disabled ? getPasswordHash(user.id) : undefined;
	const ok = verifyPassword(password, hash ?? DUMMY_HASH) && !!hash;
	if (!user || !ok) return json({ message: 'Incorrect email or password' }, { status: 401 });
	startSession(cookies, user.id, locals.secure);
	return json({ ok: true });
};
