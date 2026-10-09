import { json } from '@sveltejs/kit';
import { recall } from '#lib/server/discovery/cache.ts';
import { BadRequest, handler } from '#lib/server/http.ts';
import { createConnection } from '#lib/server/store.ts';
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
	for (const c of created) audit(locals, 'connection.import', { connection: c, detail: `${c.user}@${c.host}:${c.port}/${c.database} from ${c.source.kind}` });
	return json({ created, missing });
});
