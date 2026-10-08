import type { LayoutServerLoad } from './$types';
import { listConnections } from '#lib/server/store.ts';
import type { Viewer } from '#lib/types.ts';

export const load: LayoutServerLoad = ({ locals }) => {
	const user = locals.user;
	const viewer: Viewer | null = user ? { email: user.email, name: user.name, role: user.role } : null;
	return {
		auth: locals.auth,
		viewer,
		connections: user ? listConnections() : []
	};
};
