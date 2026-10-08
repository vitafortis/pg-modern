import { json } from '@sveltejs/kit';
import { startSession, throttled } from '#lib/server/auth.ts';
import { verifyPassword } from '#lib/server/crypto.ts';
import { getAdminPasswordHash } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, cookies, url, getClientAddress }) => {
	if (throttled(getClientAddress())) return json({ message: 'Too many attempts — wait a few minutes' }, { status: 429 });
	const hash = getAdminPasswordHash();
	const { password } = await request.json();
	if (!hash || typeof password !== 'string' || !verifyPassword(password, hash)) {
		return json({ message: 'Incorrect password' }, { status: 401 });
	}
	startSession(cookies, url.protocol === 'https:');
	return json({ ok: true });
};
