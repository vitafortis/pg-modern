import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { NotFound } from '#lib/server/pg.ts';
import { audit } from '#lib/server/permissions.ts';
import { deleteToken, getToken, revokeToken } from '#lib/server/api-tokens.ts';
import type { RequestHandler } from './$types';

/** Revokes a token; `?purge=1` removes an already revoked one from the list. */
export const DELETE: RequestHandler = handler(({ params, url, locals }) => {
	const t = getToken(params.id);
	if (!t) throw new NotFound('Token not found');
	if (url.searchParams.get('purge') === '1' && t.revokedAt) {
		deleteToken(t.id);
		return json({ ok: true });
	}
	revokeToken(t.id);
	audit(locals, 'token.revoke', { detail: `${t.name} (${t.prefix}…)` });
	return json(getToken(t.id));
});
