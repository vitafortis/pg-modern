import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { searchAudit, searchHistory } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

/** Admins: queries (`?type=queries`) or other events, newest first, paged with `before`. */
export const GET: RequestHandler = handler(({ url }) => {
	const p = url.searchParams;
	const filter = {
		userId: p.get('user') || undefined,
		connectionId: p.get('connection') || undefined,
		q: p.get('q')?.trim() || undefined,
		before: Number(p.get('before')) || undefined,
		limit: Number(p.get('limit')) || 100
	};
	if (p.get('type') === 'queries') {
		return json(searchHistory({ ...filter, writes: p.get('writes') === '1', errors: p.get('errors') === '1' }));
	}
	return json(searchAudit({ ...filter, action: p.get('action') || undefined }));
});
