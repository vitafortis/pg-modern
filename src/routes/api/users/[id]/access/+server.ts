import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { NotFound } from '#lib/server/pg.ts';
import { audit } from '#lib/server/permissions.ts';
import { getConnection, getUser, listGrants, setGrants, updateUser } from '#lib/server/store.ts';
import type { Grant } from '#lib/types.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = handler(({ params }) => {
	const user = getUser(params.id);
	if (!user) throw new NotFound('User not found');
	return json({ connectionAccess: user.connectionAccess, grants: listGrants(user.id) });
});

/** Which connections a viewer sees, and which they may unlock writes on. */
export const PUT: RequestHandler = handler(async ({ params, request, locals }) => {
	const user = getUser(params.id);
	if (!user) throw new NotFound('User not found');
	const body = await request.json();
	if (body.connectionAccess !== 'all' && body.connectionAccess !== 'selected') {
		throw new BadRequest('"connectionAccess" must be all or selected');
	}
	if (!Array.isArray(body.grants)) throw new BadRequest('"grants" must be a list');
	const grants: Grant[] = body.grants
		.filter((g: unknown): g is Grant => !!g && typeof (g as Grant).connectionId === 'string')
		.map((g: Grant) => ({ connectionId: g.connectionId, canWrite: g.canWrite === true }));
	updateUser(user.id, { connectionAccess: body.connectionAccess });
	setGrants(user.id, grants);
	const names = (list: Grant[]) => list.map((g) => getConnection(g.connectionId)?.name ?? g.connectionId).join(', ') || 'none';
	audit(locals, 'user.access', {
		detail: `${user.email}: ${body.connectionAccess === 'all' ? 'all connections' : `only ${names(grants)}`}; may unlock writes on ${names(grants.filter((g) => g.canWrite))}`
	});
	return json({ connectionAccess: body.connectionAccess, grants: listGrants(user.id) });
});
