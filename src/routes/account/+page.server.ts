import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user || locals.auth === 'disabled') redirect(303, '/');
	const u = locals.user;
	return { user: { email: u.email, name: u.name, role: u.role, sso: u.sso, hasPassword: u.hasPassword, needsProfile: u.needsProfile } };
};
