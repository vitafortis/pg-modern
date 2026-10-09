import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { activity } from '#lib/server/engine.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = handler(async ({ params }) => json(await activity(params.id)));
