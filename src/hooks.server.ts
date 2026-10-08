import { json, redirect } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';
import { authenticate } from '#lib/server/auth.ts';
import { publicUrl } from '#lib/server/origin.ts';

const PUBLIC = ['/login', '/setup', '/auth/oidc/', '/api/auth/', '/api/health'];

/** Pages viewers can't open. */
const ADMIN_PAGES = ['/discover', '/settings', '/users', '/integrations'];

/**
 * API calls only admins may make. Viewers can browse and query (always
 * read-only, enforced in the query route) but not change anything.
 */
function adminOnlyApi(method: string, path: string): boolean {
	if (/^\/api\/(discover|settings|users|managers|integrations)(\/|$)/.test(path)) return true;
	if (path === '/api/connections') return method !== 'GET';
	if (path === '/api/connections/test') return true;
	if (/^\/api\/connections\/[^/]+$/.test(path)) return method !== 'GET';
	if (/^\/api\/connections\/[^/]+\/history$/.test(path)) return method === 'DELETE';
	return false;
}

export const handle: Handle = async ({ event, resolve }) => {
	const { pathname } = event.url;
	const method = event.request.method;
	const isApi = pathname.startsWith('/api/');

	// JSON APIs must come from our own host. Browsers always send Origin on
	// cross-site and non-GET requests, so a mismatch means a forged request.
	// Hosts are compared (not full origins) so it works by IP, hostname, or
	// behind a TLS-terminating proxy without configuring ORIGIN.
	if (isApi && method !== 'GET') {
		const origin = event.request.headers.get('origin');
		if (origin) {
			const h = event.request.headers;
			const allowed = [event.url.host, h.get('host'), h.get('x-forwarded-host')].filter(Boolean);
			let host = '';
			try {
				host = new URL(origin).host;
			} catch {}
			if (!allowed.includes(host)) return json({ message: 'Cross-origin request blocked' }, { status: 403 });
		}
	}

	const visible = publicUrl(event.url, event.request.headers);
	event.locals.origin = visible.origin;
	event.locals.secure = visible.protocol === 'https:';

	const { state, user } = authenticate(event.cookies);
	event.locals.auth = state;
	event.locals.user = user;

	if (!PUBLIC.some((p) => pathname.startsWith(p))) {
		if (state === 'setup') {
			if (isApi) return json({ message: 'Setup required' }, { status: 401 });
			redirect(303, '/setup');
		}
		if (state === 'anonymous') {
			if (isApi) return json({ message: 'Not signed in' }, { status: 401 });
			redirect(303, `/login?next=${encodeURIComponent(pathname + event.url.search)}`);
		}
		if (user?.role !== 'admin') {
			if (isApi && adminOnlyApi(method, pathname)) return json({ message: 'Admins only' }, { status: 403 });
			if (!isApi && ADMIN_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) redirect(303, '/');
		}
	}

	const response = await resolve(event);
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'same-origin');
	return response;
};
