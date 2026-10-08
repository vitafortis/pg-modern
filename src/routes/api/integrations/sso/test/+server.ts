import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { discover } from '#lib/server/oidc.ts';
import { ssoConfig } from '#lib/server/sso.ts';
import type { RequestHandler } from './$types';

/** Runs OIDC discovery with the given (or saved) settings, without saving anything. */
export const POST: RequestHandler = handler(async ({ request }) => {
	const body = await request.json();
	const saved = ssoConfig();
	const issuer = typeof body.issuer === 'string' && body.issuer.trim() ? body.issuer.trim() : saved?.issuer;
	const clientId = typeof body.clientId === 'string' && body.clientId.trim() ? body.clientId.trim() : saved?.clientId;
	const clientSecret = typeof body.clientSecret === 'string' && body.clientSecret ? body.clientSecret : saved?.clientSecret;
	if (!issuer || !clientId) throw new BadRequest('Issuer and client ID are required');
	try {
		const cfg = await discover({ issuer, clientId, clientSecret });
		const meta = cfg.serverMetadata();
		return json({
			ok: true,
			issuer: meta.issuer,
			authorizationEndpoint: meta.authorization_endpoint,
			pkce: meta.code_challenge_methods_supported?.includes('S256') ?? null,
			emailScope: meta.scopes_supported ? meta.scopes_supported.includes('email') : null
		});
	} catch (err) {
		return json({ ok: false, error: describe(err, issuer) });
	}
});

/** Turns nested fetch/OIDC errors into something actionable ("connection refused" beats "fetch failed"). */
function describe(err: unknown, issuer: string): string {
	let e = err as { message?: string; code?: string; cause?: unknown } | undefined;
	let code: string | undefined;
	let innermost = (err as Error).message;
	while (e) {
		code ??= e.code && /^E[A-Z]+$/.test(e.code) ? e.code : undefined;
		if (e.message) innermost = e.message;
		e = e.cause as typeof e;
	}
	const reasons: Record<string, string> = {
		ECONNREFUSED: 'connection refused — is the provider running and the port right?',
		ENOTFOUND: 'host not found — check the hostname',
		ETIMEDOUT: 'timed out — is it reachable from this server?',
		ECONNRESET: 'connection reset',
		CERT_HAS_EXPIRED: 'its TLS certificate has expired'
	};
	if (code) return `Could not reach ${new URL(issuer).host}: ${reasons[code] ?? code}`;
	const message = (err as Error).message;
	if (message === 'fetch failed') return `Could not reach ${new URL(issuer).host}: ${innermost}`;
	return /unexpected HTTP response status code|404/i.test(message)
		? `${message}. Check the issuer URL — pg·modern appends /.well-known/openid-configuration to it.`
		: message;
}
