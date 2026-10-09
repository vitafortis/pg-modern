import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { visibleConnections } from '#lib/server/permissions.ts';
import { ADMIN_PAGES } from '#lib/server/access.ts';
import type { Viewer } from '#lib/types.ts';

export const load: LayoutServerLoad = ({ locals, url }) => {
	// Reading url.pathname makes this load rerun on every client-side navigation,
	// so the page checks below apply to in-app navigation, not just full page loads.
	const path = url.pathname;
	const user = locals.user;
	if (user?.needsProfile && !path.startsWith('/account')) redirect(303, '/account?welcome=1');
	if (user && user.role !== 'admin' && ADMIN_PAGES.some((p) => path === p || path.startsWith(`${p}/`))) redirect(303, '/');

	const viewer: Viewer | null = user
		? { email: user.email, name: user.name, role: user.role, hasPassword: user.hasPassword, sso: user.sso }
		: null;
	return {
		auth: locals.auth,
		viewer,
		needsProfile: !!user?.needsProfile,
		connections: visibleConnections(user)
	};
};
