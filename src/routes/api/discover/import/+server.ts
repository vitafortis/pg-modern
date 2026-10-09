import { json } from '@sveltejs/kit';
import { recall } from '#lib/server/discovery/cache.ts';
import { BadRequest, handler } from '#lib/server/http.ts';
import { createConnection, getConnection, setSqliteSnapshot } from '#lib/server/store.ts';
import { archiveEnabled, refreshSnapshot } from '#lib/server/sqlite/archive.ts';
import type { Connection } from '#lib/types.ts';
import { audit } from '#lib/server/permissions.ts';
import type { RequestHandler } from './$types';

interface ImportItem {
	key: string;
	name?: string;
	host?: string;
	port?: number;
	password?: string;
	readOnly?: boolean;
}

/** Saves discovered candidates. Passwords come from the server-side scan cache, not the browser. */
export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const { items } = (await request.json()) as { items: ImportItem[] };
	if (!Array.isArray(items) || !items.length) throw new BadRequest('"items" is required');
	const created: Connection[] = [];
	const missing: string[] = [];
	for (const item of items) {
		const c = recall(item.key);
		if (!c) {
			missing.push(item.key);
			continue;
		}
		if (c.engine === 'sqlite' && c.sqlite?.via === 'archive') {
			// Copied out of the container: always read-only, refreshed on demand.
			if (!archiveEnabled()) throw new BadRequest('Reading SQLite files from containers is turned off (Integrations → SQLite in containers).');
			const conn = createConnection(
				{ engine: 'sqlite', name: item.name?.trim() || c.name, host: '', port: 0, database: '', user: '', sslMode: 'disable', readOnly: true, source: c.source },
				'sqlite'
			);
			const s = c.sqlite;
			setSqliteSnapshot(conn.id, { endpoint: s.endpoint!, container: s.container!, containerId: s.containerId!, containerPath: s.containerPath!, takenAt: null, bytes: null, wal: false, error: null });
			await refreshSnapshot(conn.id).catch(() => {}); // the error is kept on the snapshot and shown on the connection
			created.push(getConnection(conn.id)!);
			continue;
		}
		created.push(
			createConnection(
				{
				engine: c.engine,
				name: item.name?.trim() || c.name,
				host: item.host ?? c.host,
				port: item.port ?? c.port,
				database: c.database,
				user: c.user,
				password: item.password || c.password,
				sslMode: c.sslMode,
				readOnly: item.readOnly !== false,
				source: c.source
				},
				c.flavor && c.flavor !== 'postgres' ? c.flavor : null
			)
		);
	}
	for (const c of created) {
		const target = c.engine === 'sqlite' ? (c.snapshot ? `snapshot of ${c.snapshot.container}:${c.snapshot.containerPath}` : c.database) : `${c.user}@${c.host}:${c.port}/${c.database}`;
		audit(locals, 'connection.import', { connection: c, detail: `${target} from ${c.source.kind}` });
	}
	return json({ created, missing });
});
