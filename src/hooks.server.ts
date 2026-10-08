import { json, redirect } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';
import { authState } from '#lib/server/auth.ts';

const PUBLIC = ['/login', '/setup', '/api/auth/', '/api/health'];

export const handle: Handle = async ({ event, resolve }) => {
	const { pathname } = event.url;
	const isApi = pathname.startsWith('/api/');

	// JSON APIs must come from our own host. Browsers always send Origin on
	// cross-site and non-GET requests, so a mismatch means a forged request.
	// Hosts are compared (not full origins) so it works by IP, hostname, or
	// behind a TLS-terminating proxy without configuring ORIGIN.
	if (isApi && event.request.method !== 'GET') {
		const origin = event.request.headers.get('origin');
		if (origin && origin !== 'null') {
			const h = event.request.headers;
			const allowed = [event.url.host, h.get('host'), h.get('x-forwarded-host')].filter(Boolean);
			let host = '';
			try {
				host = new URL(origin).host;
			} catch {}
			if (!allowed.includes(host)) return json({ message: 'Cross-origin request blocked' }, { status: 403 });
		} else if (origin === 'null') {
			return json({ message: 'Cross-origin request blocked' }, { status: 403 });
		}
	}

	const state = authState(event.cookies);
	event.locals.auth = state;

	if (!PUBLIC.some((p) => pathname.startsWith(p))) {
		if (state === 'setup') {
			if (isApi) return json({ message: 'Setup required' }, { status: 401 });
			redirect(303, '/setup');
		}
		if (state === 'anonymous') {
			if (isApi) return json({ message: 'Not signed in' }, { status: 401 });
			redirect(303, `/login?next=${encodeURIComponent(pathname + event.url.search)}`);
		}
	}

	const response = await resolve(event);
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'same-origin');
	return response;
};
