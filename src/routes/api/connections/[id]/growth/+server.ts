import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { NotFound } from '#lib/server/engine.ts';
import { getConnection } from '#lib/server/store.ts';
import { growth } from '#lib/server/size-history.ts';
import { sampleConnection } from '#lib/server/size-sampler.ts';
import { monitorable } from '#lib/server/monitor.ts';
import { GROWTH_RANGES, type GrowthRange } from '#lib/alerts.ts';
import type { RequestHandler } from './$types';

/** Database size over time and the fastest-growing tables (`?range=7d|30d|1y`). Visibility is checked in hooks. */
export const GET: RequestHandler = handler(({ params, url }) => {
	if (!getConnection(params.id)) throw new NotFound('Connection not found');
	const r = url.searchParams.get('range') as GrowthRange;
	return json(growth(params.id, GROWTH_RANGES.includes(r) ? r : '30d'));
});

/** Admins: take a sample now instead of waiting for the hourly job. */
export const POST: RequestHandler = handler(async ({ params, url, locals }) => {
	if (locals.user?.role !== 'admin') return json({ message: 'Admins only' }, { status: 403 });
	const conn = getConnection(params.id);
	if (!conn) throw new NotFound('Connection not found');
	if (!monitorable(conn)) return json({ message: 'Size history isn’t available for this engine' }, { status: 400 });
	await sampleConnection(params.id);
	const r = url.searchParams.get('range') as GrowthRange;
	return json(growth(params.id, GROWTH_RANGES.includes(r) ? r : '30d'));
});
