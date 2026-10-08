import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { overview } from '#lib/server/introspect.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = handler(async ({ params }) => json(await overview(params.id)));
