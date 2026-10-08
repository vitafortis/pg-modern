import { json } from '@sveltejs/kit';
import { startSession } from '#lib/server/auth.ts';
import { hashPassword } from '#lib/server/crypto.ts';
import { countUsers, createUser } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

/** Creates the first admin. Only works while there are no users. */
export const POST: RequestHandler = async ({ request, cookies, locals }) => {
	if (countUsers() > 0) return json({ message: 'Already set up' }, { status: 409 });
	const { email, password } = await request.json();
	if (typeof email !== 'string' || !email.trim()) return json({ message: 'Enter an email or username' }, { status: 400 });
	if (typeof password !== 'string' || password.length < 8) {
		return json({ message: 'Use at least 8 characters' }, { status: 400 });
	}
	const user = createUser({ email, name: null, role: 'admin', passwordHash: hashPassword(password) });
	startSession(cookies, user.id, locals.secure);
	return json({ ok: true });
};
