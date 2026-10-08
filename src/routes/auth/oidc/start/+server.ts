import { redirect } from '@sveltejs/kit';
import { ssoConfig } from '#lib/server/sso.ts';
import { beginLogin } from '#lib/server/oidc.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ cookies, url, locals }) => {
	if (!ssoConfig()) redirect(303, '/login');
	const next = url.searchParams.get('next') ?? '/';
	let target: URL;
	try {
		target = await beginLogin(cookies, locals.origin, next, locals.secure);
	} catch (err) {
		redirect(303, `/login?error=${encodeURIComponent(`Could not reach the identity provider: ${(err as Error).message}`)}`);
	}
	// The provider's authorization endpoint comes from OIDC discovery, so it's a trusted external URL.
	redirect(303, target.href, { external: true });
};
