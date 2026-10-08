/** Pages viewers can't open (checked in hooks and the root layout load). */
export const ADMIN_PAGES = ['/discover', '/settings', '/users', '/integrations'];

/**
 * API calls only admins may make. Viewers can browse and query (always
 * read-only, enforced in the query route) but not change anything.
 */
export function adminOnlyApi(method: string, path: string): boolean {
	if (/^\/api\/(discover|settings|users|managers|integrations)(\/|$)/.test(path)) return true;
	if (path === '/api/connections') return method !== 'GET';
	if (path === '/api/connections/test') return true;
	if (/^\/api\/connections\/[^/]+$/.test(path)) return method !== 'GET';
	if (/^\/api\/connections\/[^/]+\/history$/.test(path)) return method === 'DELETE';
	return false;
}
