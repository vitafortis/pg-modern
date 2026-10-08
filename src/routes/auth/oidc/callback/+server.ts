import { redirect } from '@sveltejs/kit';
import { startSession } from '#lib/server/auth.ts';
import { LoginRefused, completeLogin } from '#lib/server/oidc.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ cookies, url }) => {
	const providerError = url.searchParams.get('error_description') ?? url.searchParams.get('error');
	if (providerError) redirect(303, `/login?error=${encodeURIComponent(providerError)}`);

	let next = '/';
	try {
		const result = await completeLogin(cookies, url);
		startSession(cookies, result.user.id, url.protocol === 'https:');
		next = result.next;
	} catch (err) {
		const message = err instanceof LoginRefused ? err.message : `Sign-in failed: ${(err as Error).message}`;
		redirect(303, `/login?error=${encodeURIComponent(message)}`);
	}
	redirect(303, next.startsWith('/') && !next.startsWith('//') ? next : '/');
};
