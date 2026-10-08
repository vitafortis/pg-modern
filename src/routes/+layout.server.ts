import type { LayoutServerLoad } from './$types';
import { listConnections } from '#lib/server/store.ts';

export const load: LayoutServerLoad = ({ locals }) => ({
	auth: locals.auth,
	connections: locals.auth === 'authenticated' || locals.auth === 'disabled' ? listConnections() : []
});
