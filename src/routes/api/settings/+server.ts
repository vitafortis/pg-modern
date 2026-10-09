import { json } from '@sveltejs/kit';
import { config, IN_CONTAINER } from '#lib/server/config.ts';
import { BadRequest, handler } from '#lib/server/http.ts';
import { getSettings, saveSettings } from '#lib/server/store.ts';
import { audit } from '#lib/server/permissions.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () =>
	json({
		settings: getSettings(),
		env: {
			scanPaths: config.scanPaths,
			dockerHosts: config.dockerHosts,
			scanDepth: config.scanDepth,
			statementTimeoutMs: config.statementTimeoutMs,
			maxRows: config.maxRows,
			dataDir: config.dataDir,
			keySource: config.secretKey ? 'PGM_SECRET_KEY' : 'key file',
			authDisabled: config.authDisabled,
			inContainer: IN_CONTAINER
		}
	});

export const PUT: RequestHandler = handler(async ({ request, locals }) => {
	const body = await request.json();
	const clean = (v: unknown) =>
		Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean))] : [];
	const dockerHosts = clean(body.dockerHosts);
	for (const h of dockerHosts) {
		if (!/^(unix|tcp):\/\//.test(h)) throw new BadRequest(`Docker host "${h}" must start with unix:// or tcp://`);
	}
	saveSettings({ ...getSettings(), scanPaths: clean(body.scanPaths), dockerHosts });
	audit(locals, 'settings.discovery', { detail: `docker: ${dockerHosts.join(', ') || 'none'}; folders: ${clean(body.scanPaths).join(', ') || 'none'}` });
	return json(getSettings());
});
