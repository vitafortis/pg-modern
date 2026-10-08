import { json } from '@sveltejs/kit';
import { startSession } from '#lib/server/auth.ts';
import { hashPassword } from '#lib/server/crypto.ts';
import { getAdminPasswordHash, setAdminPasswordHash } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	if (getAdminPasswordHash()) return json({ message: 'Already set up' }, { status: 409 });
	const { password } = await request.json();
	if (typeof password !== 'string' || password.length < 8) {
		return json({ message: 'Use at least 8 characters' }, { status: 400 });
	}
	setAdminPasswordHash(hashPassword(password));
	startSession(cookies, url.protocol === 'https:');
	return json({ ok: true });
};
