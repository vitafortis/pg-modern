import { json } from '@sveltejs/kit';
import { recall } from '#lib/server/discovery/cache.ts';
import { BadRequest, handler } from '#lib/server/http.ts';
import { closePool, NotFound } from '#lib/server/pg.ts';
import { getConnection, updateConnection } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

/**
 * Points a saved connection at the address a fresh scan found (e.g. after a port or
 * network change), keeping its name, access mode and color. The password is refreshed
 * too when the scan found one.
 */
export const POST: RequestHandler = handler(async ({ request }) => {
	const { key, connectionId, host, port } = (await request.json()) as { key?: string; connectionId?: string; host?: string; port?: number };
	if (!key || !connectionId) throw new BadRequest('"key" and "connectionId" are required');
	const c = recall(key);
	if (!c) throw new BadRequest('This scan result expired; rescan and try again.');
	const existing = getConnection(connectionId);
	if (!existing) throw new NotFound('Connection not found');
	const updated = updateConnection(connectionId, {
		name: existing.name,
		host: host ?? c.host,
		port: port ?? c.port,
		database: existing.database,
		user: existing.user,
		password: c.password,
		sslMode: existing.sslMode,
		readOnly: existing.readOnly,
		color: existing.color
	});
	closePool(connectionId);
	return json(updated);
});
