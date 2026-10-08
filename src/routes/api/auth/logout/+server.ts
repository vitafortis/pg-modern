import { json } from '@sveltejs/kit';
import { endSession } from '#lib/server/auth.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ cookies }) => {
	endSession(cookies);
	return json({ ok: true });
};
