import { json } from '@sveltejs/kit';
import { connectionStatus } from '#lib/server/status.ts';
import type { RequestHandler } from './$types';

/**
 * One connection's status. `?strict=1` answers 503 when it's down, for monitors that
 * only look at the HTTP status (Uptime Kuma's plain HTTP check).
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	const token = locals.apiToken;
	if (!token) return json({ message: 'API token required' }, { status: 401 });
	const item = await connectionStatus(params.id, { includeAddresses: token.includeAddresses });
	if (!item) return json({ message: 'Connection not found' }, { status: 404 });
	const strict = url.searchParams.get('strict') === '1' || url.searchParams.get('strict') === 'true';
	return json(item, { status: strict && item.status === 'down' ? 503 : 200, headers: { 'cache-control': 'no-store' } });
};
