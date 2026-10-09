import { BackupError, backupFilename, checkPassphrase, encodeBackup } from '#lib/server/backup.ts';
import { appVersion, snapshot, summarizeInclude, type BackupPayload } from '#lib/server/config-backup.ts';
import { BadRequest, handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import type { RequestHandler } from './$types';

/** Downloads an encrypted backup of connections, users and settings. */
export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const body = await request.json().catch(() => ({}));
	let passphrase: string;
	try {
		passphrase = checkPassphrase(body.passphrase);
	} catch (err) {
		throw new BadRequest((err as Error).message);
	}
	const inc = body.include && typeof body.include === 'object' ? body.include : {};
	const include = { connections: inc.connections !== false, users: inc.users !== false, settings: inc.settings !== false };
	if (!include.connections && !include.users && !include.settings) throw new BadRequest('Choose at least one thing to back up');
	let payload: BackupPayload;
	try {
		payload = snapshot(include);
	} catch (err) {
		if (err instanceof BackupError) throw new BadRequest(err.message);
		throw new BadRequest(`Couldn't read the stored secrets: ${(err as Error).message}`);
	}
	const envelope = await encodeBackup(payload, passphrase, { appVersion: appVersion() });
	audit(locals, 'backup.export', { detail: summarizeInclude(payload) });
	return new Response(JSON.stringify(envelope, null, '\t'), {
		headers: {
			'content-type': 'application/json',
			'content-disposition': `attachment; filename="${backupFilename()}"`,
			'cache-control': 'no-store'
		}
	});
});
