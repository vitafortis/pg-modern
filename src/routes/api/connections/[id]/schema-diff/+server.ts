import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { parseSource, resolveSource } from '#lib/server/schema-snapshots.ts';
import { getConnection } from '#lib/server/store.ts';
import { canSee } from '#lib/server/permissions.ts';
import { diffSchemas, migrationSql } from '#lib/schema/diff.ts';
import type { RequestHandler } from './$types';

/**
 * Compares two schemas: `{ from, to }`, each `{ kind: 'live', connectionId }` or
 * `{ kind: 'snapshot', connectionId, snapshotId }`. Either side may be another
 * connection the user can see, as long as it's the same engine. Read-only, so it's a
 * POST only because the body is structured.
 */
export const POST: RequestHandler = handler(async ({ params, request, locals }) => {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body) throw new BadRequest('Expected a JSON object');
	const fromSrc = parseSource(body.from);
	const toSrc = parseSource(body.to);
	if (fromSrc.connectionId !== params.id && toSrc.connectionId !== params.id) throw new BadRequest('One side must belong to this connection');
	// Refuse mixed engines before reading any catalog (only for connections the user can see;
	// resolveSource answers "not found" for the others).
	const visible = (id: string) => {
		const c = getConnection(id);
		return c && canSee(locals.user, c) ? c : undefined;
	};
	const fromConn = visible(fromSrc.connectionId);
	const toConn = visible(toSrc.connectionId);
	if (fromConn && toConn && fromConn.engine !== toConn.engine) throw new BadRequest(`Can’t compare a ${fromConn.engine} schema with a ${toConn.engine} one`);
	const [from, to] = await Promise.all([resolveSource(locals.user!, fromSrc), resolveSource(locals.user!, toSrc)]);
	if (from.engine !== to.engine) throw new BadRequest(`Can’t compare a ${from.engine} schema with a ${to.engine} one`);
	const diff = diffSchemas(from.data, to.data);
	const strip = ({ data, ...side }: typeof from) => ({ ...side, bodiesOmitted: !!data.bodiesOmitted });
	return json({
		from: strip(from),
		to: strip(to),
		diff,
		migration: body.migration === false || diff.identical ? null : migrationSql(diff, to.data)
	});
});
