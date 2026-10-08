import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { testConnection } from '#lib/server/pg.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = handler(async ({ params }) => json(await testConnection(params.id)));
