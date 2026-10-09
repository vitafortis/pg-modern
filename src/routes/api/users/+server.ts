import { json } from '@sveltejs/kit';
import { hashPassword } from '#lib/server/crypto.ts';
import { BadRequest, handler } from '#lib/server/http.ts';
import { createUser, findUserByEmail, listUsers } from '#lib/server/store.ts';
import { audit } from '#lib/server/permissions.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => json(listUsers());

/** Adds a user. Without a password they can only sign in through SSO with a matching email. */
export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const { email, name, role, password } = await request.json();
	if (typeof email !== 'string' || !email.trim()) throw new BadRequest('"email" is required');
	if (role !== 'admin' && role !== 'viewer') throw new BadRequest('"role" must be admin or viewer');
	if (password !== undefined && password !== '' && (typeof password !== 'string' || password.length < 8)) {
		throw new BadRequest('Passwords need at least 8 characters');
	}
	if (findUserByEmail(email)) throw new BadRequest(`${email} already exists`);
	const user = createUser({ email, name: typeof name === 'string' && name.trim() ? name.trim() : null, role, passwordHash: password ? hashPassword(password) : undefined });
	audit(locals, 'user.create', { detail: `${user.email} (${user.role})` });
	return json(user, { status: 201 });
});
