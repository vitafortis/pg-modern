import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { getSettings, saveSettings } from '#lib/server/store.ts';
import { audit } from '#lib/server/permissions.ts';
import { DEFAULT_SNAPSHOT_MAX_MB } from '#lib/server/sqlite/archive.ts';
import type { RequestHandler } from './$types';

/** SQLite discovery settings (admins only, like everything under /api/settings). */
export const GET: RequestHandler = () => {
	const s = getSettings();
	return json({ sqliteArchive: s.sqliteArchive === true, sqliteSnapshotMaxMb: s.sqliteSnapshotMaxMb ?? DEFAULT_SNAPSHOT_MAX_MB });
};

export const PUT: RequestHandler = handler(async ({ request, locals }) => {
	const body = await request.json();
	const current = getSettings();
	const sqliteArchive = typeof body.sqliteArchive === 'boolean' ? body.sqliteArchive : current.sqliteArchive === true;
	const maxMb = body.sqliteSnapshotMaxMb === undefined ? (current.sqliteSnapshotMaxMb ?? DEFAULT_SNAPSHOT_MAX_MB) : Number(body.sqliteSnapshotMaxMb);
	if (!Number.isInteger(maxMb) || maxMb < 1 || maxMb > 65536) throw new BadRequest('"sqliteSnapshotMaxMb" must be a whole number of MB, 1–65536');
	saveSettings({ ...current, sqliteArchive, sqliteSnapshotMaxMb: maxMb });
	audit(locals, 'settings.sqlite', { detail: `read SQLite from containers via the Docker API: ${sqliteArchive ? 'on' : 'off'}; snapshot limit ${maxMb} MB` });
	return json({ sqliteArchive, sqliteSnapshotMaxMb: maxMb });
});
