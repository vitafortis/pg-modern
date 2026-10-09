import { Readable } from 'node:stream';
import { BadRequest, handler } from '#lib/server/http.ts';
import { NotFound } from '#lib/server/engine.ts';
import { audit } from '#lib/server/permissions.ts';
import { openRunFile } from '#lib/server/backups/runner.ts';
import { getRun } from '#lib/server/backups/store.ts';
import type { RequestHandler } from './$types';

/** Streams a backup file from its destination (local folder, SFTP or S3) to the browser. */
export const GET: RequestHandler = handler(async ({ params, locals }) => {
	const run = getRun(params.id);
	if (!run) throw new NotFound('Run not found');
	let file;
	try {
		file = await openRunFile(run);
	} catch (err) {
		throw new BadRequest((err as Error).message);
	}
	audit(locals, 'backup.download', {
		connection: run.connectionId ? { id: run.connectionId, name: run.connectionName } : undefined,
		detail: `${run.destinationName}: ${run.fileName}`
	});
	const name = run.fileName!.split('/').pop()!;
	return new Response(Readable.toWeb(file.stream) as ReadableStream, {
		headers: {
			'content-type': run.format === 'mysql-sql' ? 'application/sql' : 'application/octet-stream',
			'content-disposition': `attachment; filename="${name}"`,
			'cache-control': 'no-store',
			...(file.size ? { 'content-length': String(file.size) } : {})
		}
	});
});
