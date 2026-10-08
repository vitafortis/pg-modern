import { error } from '@sveltejs/kit';
import { getConnection } from '#lib/server/store.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	const connection = getConnection(params.id);
	if (!connection) error(404, 'Connection not found');
	return { connection };
};
