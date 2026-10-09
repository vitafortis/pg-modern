import { error } from '@sveltejs/kit';
import { getConnection } from '#lib/server/store.ts';
import { withAccess } from '#lib/server/permissions.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params, locals }) => {
	const connection = getConnection(params.id);
	if (!connection) error(404, 'Connection not found');
	return { connection: withAccess(locals.user, connection) };
};
