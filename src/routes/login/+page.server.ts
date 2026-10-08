import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (locals.auth === 'setup') redirect(303, '/setup');
	if (locals.auth === 'authenticated' || locals.auth === 'disabled') redirect(303, '/');
};
