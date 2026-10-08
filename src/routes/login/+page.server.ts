import { redirect } from '@sveltejs/kit';
import { config } from '#lib/server/config.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.auth === 'setup') redirect(303, '/setup');
	if (locals.auth === 'authenticated' || locals.auth === 'disabled') redirect(303, '/');
	return {
		sso: config.oidc ? { name: config.oidc.name } : null,
		localLogin: !config.localLoginDisabled,
		error: url.searchParams.get('error') ?? ''
	};
};
