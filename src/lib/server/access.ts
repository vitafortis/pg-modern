/** Pages viewers can't open (checked in hooks and the root layout load). */
export const ADMIN_PAGES = ['/discover', '/settings', '/users', '/integrations', '/audit'];

/**
 * API calls only admins may make. Viewers can browse and query (always
 * read-only, enforced in the query route) but not change anything.
 */
export function adminOnlyApi(method: string, path: string): boolean {
	if (/^\/api\/(discover|settings|users|managers|integrations|audit|backup)(\/|$)/.test(path)) return true;
	if (path === '/api/connections') return method !== 'GET';
	if (path === '/api/connections/test') return true;
	if (/^\/api\/connections\/[^/]+$/.test(path)) return method !== 'GET';
	return false;
}

/** The connection a page or API path is scoped to, if any. */
export function connectionIdFromPath(path: string): string | undefined {
	const m = /^\/(?:api\/connections|c)\/([^/]+)/.exec(path);
	return m && m[1] !== 'test' ? decodeURIComponent(m[1]) : undefined;
}
