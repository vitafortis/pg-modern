import { json } from '@sveltejs/kit';
import { config } from '#lib/server/config.ts';
import { BadRequest, handler } from '#lib/server/http.ts';
import { deleteSso, hasStoredSecret, localLoginDisabled, saveSso, setLocalLoginDisabled, ssoConfig } from '#lib/server/sso.ts';
import type { RequestHandler } from './$types';

function view(origin: string) {
	const sso = ssoConfig();
	return {
		configured: !!sso,
		source: sso?.source ?? null,
		config: sso
			? {
					issuer: sso.issuer,
					clientId: sso.clientId,
					name: sso.name,
					scopes: sso.scopes,
					autoCreate: sso.autoCreate,
					adminEmails: sso.adminEmails,
					defaultRole: sso.defaultRole,
					redirectUri: sso.redirectUri ?? ''
				}
			: null,
		hasSecret: hasStoredSecret(),
		redirectUri: sso?.redirectUri || `${origin}/auth/oidc/callback`,
		localLoginDisabled: localLoginDisabled(),
		/** Set by PGM_LOCAL_LOGIN; the UI toggle is locked. */
		localLoginLocked: config.localLogin ?? null
	};
}

export const GET: RequestHandler = ({ locals }) => json(view(locals.origin));

const list = (v: unknown) =>
	(Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n]/) : []).map((s) => String(s).trim()).filter(Boolean);

export const PUT: RequestHandler = handler(async ({ request, locals }) => {
	const body = await request.json();
	if (ssoConfig()?.source === 'env') {
		// Env-configured SSO: only the password sign-in toggle can be changed here.
		if (typeof body.localLoginDisabled === 'boolean') setLocalLoginDisabled(body.localLoginDisabled);
		return json(view(locals.origin));
	}
	const issuer = typeof body.issuer === 'string' ? body.issuer.trim() : '';
	if (!/^https?:\/\/.+/.test(issuer)) throw new BadRequest('Issuer must be an http(s) URL');
	const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
	if (!clientId) throw new BadRequest('Client ID is required');
	const redirectUri = typeof body.redirectUri === 'string' ? body.redirectUri.trim() : '';
	if (redirectUri && !/^https?:\/\/.+/.test(redirectUri)) throw new BadRequest('Redirect URI must be an http(s) URL');
	saveSso({
		issuer,
		clientId,
		clientSecret: typeof body.clientSecret === 'string' ? body.clientSecret : undefined,
		name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'SSO',
		scopes: typeof body.scopes === 'string' && body.scopes.trim() ? body.scopes.trim() : 'openid email profile',
		redirectUri: redirectUri || undefined,
		autoCreate: list(body.autoCreate),
		adminEmails: list(body.adminEmails),
		defaultRole: body.defaultRole === 'admin' ? 'admin' : 'viewer'
	});
	if (typeof body.localLoginDisabled === 'boolean') setLocalLoginDisabled(body.localLoginDisabled);
	return json(view(locals.origin));
});

export const DELETE: RequestHandler = handler(({ locals }) => {
	if (ssoConfig()?.source === 'env') throw new BadRequest('SSO is configured with PGM_OIDC_* environment variables; remove them there.');
	deleteSso();
	return json(view(locals.origin));
});
