import { json } from '@sveltejs/kit';
import { connectionStatus, statusBadge } from '#lib/server/status.ts';
import type { RequestHandler } from './$types';

/** A shields.io-style SVG badge for one connection; `?label=` overrides the left text. */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.apiToken) return json({ message: 'API token required' }, { status: 401 });
	const item = await connectionStatus(params.id, { includeAddresses: false });
	const label = (url.searchParams.get('label') ?? item?.name ?? 'database').slice(0, 60);
	return new Response(statusBadge(label, item), {
		status: item ? 200 : 404,
		headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-cache, max-age=0' }
	});
};
