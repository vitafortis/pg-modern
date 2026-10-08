import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { schemaTree } from '#lib/server/introspect.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = handler(async ({ params, url }) =>
	json(await schemaTree(params.id, url.searchParams.get('system') === '1'))
);
