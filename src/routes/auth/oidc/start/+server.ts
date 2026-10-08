import { redirect } from '@sveltejs/kit';
import { config } from '#lib/server/config.ts';
import { beginLogin } from '#lib/server/oidc.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ cookies, url }) => {
	if (!config.oidc) redirect(303, '/login');
	const next = url.searchParams.get('next') ?? '/';
	let target: URL;
	try {
		target = await beginLogin(cookies, url.origin, next, url.protocol === 'https:');
	} catch (err) {
		redirect(303, `/login?error=${encodeURIComponent(`Could not reach the identity provider: ${(err as Error).message}`)}`);
	}
	// The provider's authorization endpoint comes from OIDC discovery, so it's a trusted external URL.
	redirect(303, target.href, { external: true });
};
