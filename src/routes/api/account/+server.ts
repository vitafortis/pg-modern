import { json } from '@sveltejs/kit';
import { hashPassword, verifyPassword } from '#lib/server/crypto.ts';
import { BadRequest, handler } from '#lib/server/http.ts';
import { findUserByEmail, getPasswordHash, updateUser } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lets the signed-in user change their own name, email and password. */
export const PUT: RequestHandler = handler(async ({ request, locals }) => {
	const user = locals.user;
	if (!user || user.id === 'open') throw new BadRequest('Accounts are disabled (PGM_AUTH=disabled)');
	const body = await request.json();
	const patch: Parameters<typeof updateUser>[1] = {};

	if (typeof body.name === 'string') patch.name = body.name.trim() || null;

	if (typeof body.email === 'string' && body.email.trim() !== user.email) {
		const email = body.email.trim();
		if (!EMAIL.test(email)) throw new BadRequest('Enter a valid email address');
		const taken = findUserByEmail(email);
		if (taken && taken.id !== user.id) throw new BadRequest(`${email} is already used by another account`);
		// SSO accounts are matched by email at the provider; changing it here would break that link's meaning.
		if (user.sso) throw new BadRequest('Your email comes from single sign-on and can’t be changed here');
		patch.email = email;
	}

	if (typeof body.newPassword === 'string' && body.newPassword) {
		if (body.newPassword.length < 8) throw new BadRequest('Use at least 8 characters for the new password');
		const current = getPasswordHash(user.id);
		if (current && !(typeof body.currentPassword === 'string' && verifyPassword(body.currentPassword, current))) {
			throw new BadRequest('Current password is incorrect');
		}
		patch.passwordHash = hashPassword(body.newPassword);
	}

	if (user.needsProfile) {
		const email = patch.email ?? user.email;
		if (!EMAIL.test(email)) throw new BadRequest('Add your email address to finish setting up');
		patch.needsProfile = false;
	}

	const updated = updateUser(user.id, patch)!;
	return json({ email: updated.email, name: updated.name, needsProfile: updated.needsProfile });
});
