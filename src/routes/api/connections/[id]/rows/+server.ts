import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { browse, type Filter } from '#lib/server/introspect.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = handler(async ({ params, url }) => {
	const q = url.searchParams;
	const schema = q.get('schema');
	const table = q.get('table');
	if (!schema || !table) throw new BadRequest('"schema" and "table" are required');
	let filters: Filter[] = [];
	try {
		filters = JSON.parse(q.get('filters') ?? '[]');
	} catch {
		throw new BadRequest('"filters" must be JSON');
	}
	return json(
		await browse(params.id, {
			schema,
			table,
			limit: Math.min(Math.max(Number(q.get('limit') ?? 100), 1), 1000),
			offset: Math.max(Number(q.get('offset') ?? 0), 0),
			sort: q.get('sort') ?? undefined,
			dir: q.get('dir') === 'desc' ? 'desc' : 'asc',
			filters: Array.isArray(filters) ? filters : [],
			search: q.get('q') ?? undefined
		})
	);
});
