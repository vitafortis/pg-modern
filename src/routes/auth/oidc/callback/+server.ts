import { redirect } from '@sveltejs/kit';
import { startSession } from '#lib/server/auth.ts';
import { LoginRefused, completeLogin } from '#lib/server/oidc.ts';
import { audit } from '#lib/server/permissions.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ cookies, url, locals }) => {
	const providerError = url.searchParams.get('error_description') ?? url.searchParams.get('error');
	if (providerError) redirect(303, `/login?error=${encodeURIComponent(providerError)}`);

	let next = '/';
	try {
		const result = await completeLogin(cookies, url, locals.origin);
		startSession(cookies, result.user.id, locals.secure);
		audit(locals, 'auth.login', { as: result.user, detail: 'SSO' });
		next = result.next;
	} catch (err) {
		const message = err instanceof LoginRefused ? err.message : `Sign-in failed: ${(err as Error).message}`;
		audit(locals, 'auth.login_failed', { detail: `SSO: ${message}`.slice(0, 300) });
		redirect(303, `/login?error=${encodeURIComponent(message)}`);
	}
	redirect(303, next.startsWith('/') && !next.startsWith('//') ? next : '/');
};
