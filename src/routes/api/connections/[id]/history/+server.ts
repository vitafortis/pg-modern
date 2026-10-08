import { json } from '@sveltejs/kit';
import { clearHistory, listHistory } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => json(listHistory(params.id));

export const DELETE: RequestHandler = ({ params }) => {
	clearHistory(params.id);
	return json({ ok: true });
};
