import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { createToken, listTokens, parseTokenInput } from '#lib/server/api-tokens.ts';
import type { RequestHandler } from './$types';

// /api/integrations/* is admin-only (access.ts).

export const GET: RequestHandler = handler(() => json(listTokens()));

/** Creates a status token; the response is the only time the full token is shown. */
export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const input = parseTokenInput(await request.json().catch(() => null));
	const { token, record } = createToken(input, locals.user);
	audit(locals, 'token.create', {
		detail: `${record.name} (${record.prefix}…)${record.includeAddresses ? ', with addresses' : ''}${record.expiresAt ? `, expires ${record.expiresAt.slice(0, 10)}` : ''}`
	});
	return json({ token, record }, { status: 201 });
});
