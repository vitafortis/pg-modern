import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { diagram } from '#lib/server/introspect.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = handler(async ({ params, url }) => {
	const schema = url.searchParams.get('schema');
	if (!schema) throw new BadRequest('"schema" is required');
	return json(await diagram(params.id, schema, { views: url.searchParams.get('views') === '1' }));
});
