import { json } from '@sveltejs/kit';
import { hashPassword } from '#lib/server/crypto.ts';
import { BadRequest, handler } from '#lib/server/http.ts';
import { NotFound } from '#lib/server/pg.ts';
import { countAdmins, deleteUser, getUser, updateUser } from '#lib/server/store.ts';
import { audit } from '#lib/server/permissions.ts';
import type { RequestHandler } from './$types';

function guardLastAdmin(id: string, losingAdmin: boolean) {
	const user = getUser(id);
	if (!user) throw new NotFound('User not found');
	if (losingAdmin && user.role === 'admin' && !user.disabled && countAdmins() <= 1) {
		throw new BadRequest('This is the last admin. Promote someone else first.');
	}
	return user;
}

export const PATCH: RequestHandler = handler(async ({ params, request, locals }) => {
	const body = await request.json();
	const patch: Parameters<typeof updateUser>[1] = {};
	if (body.role !== undefined) {
		if (body.role !== 'admin' && body.role !== 'viewer') throw new BadRequest('"role" must be admin or viewer');
		patch.role = body.role;
	}
	if (typeof body.disabled === 'boolean') patch.disabled = body.disabled;
	if (typeof body.name === 'string') patch.name = body.name.trim() || null;
	if (body.password !== undefined) {
		if (body.password === null || body.password === '') patch.passwordHash = null;
		else if (typeof body.password === 'string' && body.password.length >= 8) patch.passwordHash = hashPassword(body.password);
		else throw new BadRequest('Passwords need at least 8 characters');
	}
	if (params.id === locals.user?.id && (patch.disabled || patch.role === 'viewer')) {
		throw new BadRequest("You can't demote or disable yourself");
	}
	const before = guardLastAdmin(params.id, patch.role === 'viewer' || patch.disabled === true);
	const updated = updateUser(params.id, patch);
	const changes = [
		patch.role && patch.role !== before.role && `role ${patch.role}`,
		patch.disabled !== undefined && patch.disabled !== before.disabled && (patch.disabled ? 'disabled' : 'enabled'),
		patch.passwordHash !== undefined && (patch.passwordHash ? 'password set' : 'password removed'),
		patch.name !== undefined && patch.name !== before.name && 'name changed'
	].filter(Boolean);
	if (changes.length) audit(locals, 'user.update', { detail: `${before.email}: ${changes.join(', ')}` });
	return json(updated);
});

export const DELETE: RequestHandler = handler(({ params, locals }) => {
	if (params.id === locals.user?.id) throw new BadRequest("You can't delete yourself");
	const user = guardLastAdmin(params.id, true);
	deleteUser(params.id);
	audit(locals, 'user.delete', { detail: user.email });
	return json({ ok: true });
});
