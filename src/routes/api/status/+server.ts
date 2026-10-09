import { json } from '@sveltejs/kit';
import { statusSummary } from '#lib/server/status.ts';
import type { RequestHandler } from './$types';

/**
 * Up/down summary of every connection, for dashboards. Authenticated only by an API
 * token (hooks.server.ts); never by a session.
 */
export const GET: RequestHandler = async ({ locals }) => {
	const token = locals.apiToken;
	if (!token) return json({ message: 'API token required' }, { status: 401 });
	return json(await statusSummary({ includeAddresses: token.includeAddresses }), { headers: { 'cache-control': 'no-store' } });
};
