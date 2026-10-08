import { redirect } from '@sveltejs/kit';
import { localLoginDisabled, ssoConfig } from '#lib/server/sso.ts';
import { legacyAdminPending } from '#lib/server/store.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.auth === 'setup') redirect(303, '/setup');
	if (locals.auth === 'authenticated' || locals.auth === 'disabled') redirect(303, '/');
	return {
		sso: ssoConfig() ? { name: ssoConfig()!.name } : null,
		localLogin: !localLoginDisabled(),
		// Upgraded from the single-password version: tell them the username it became.
		legacyHint: !localLoginDisabled() && legacyAdminPending(),
		error: url.searchParams.get('error') ?? ''
	};
};
