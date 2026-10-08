import * as client from 'openid-client';
import type { Cookies } from '@sveltejs/kit';
import { ssoConfig, type SsoConfig } from './sso.ts';
import { decrypt, encrypt } from './crypto.ts';
import { emailMatches } from './auth.ts';
import { createUser, findUserByEmail, findUserBySub, updateUser } from './store.ts';
import type { User } from '#lib/types.ts';

const FLOW_COOKIE = 'pgm_oidc';
let discovered: { key: string; config: Promise<client.Configuration> } | undefined;

function settings(): SsoConfig {
	const o = ssoConfig();
	if (!o) throw new Error('Single sign-on is not configured');
	return o;
}

export function discover(o: Pick<SsoConfig, 'issuer' | 'clientId' | 'clientSecret'>): Promise<client.Configuration> {
	const issuer = new URL(o.issuer);
	// Plain-http issuers are common on a LAN; openid-client only allows them when asked.
	const options = issuer.protocol === 'http:' ? { execute: [client.allowInsecureRequests] } : undefined;
	return client.discovery(issuer, o.clientId, o.clientSecret, undefined, options);
}

/** Discovery is cached per issuer/client (so edits in the UI take effect); failures aren't cached. */
function configuration(): Promise<client.Configuration> {
	const o = settings();
	const key = JSON.stringify([o.issuer, o.clientId, o.clientSecret]);
	if (discovered?.key !== key) {
		const pending = discover(o).catch((err) => {
			if (discovered?.config === pending) discovered = undefined;
			throw err;
		});
		discovered = { key, config: pending };
	}
	return discovered.config;
}

export function redirectUri(origin: string): string {
	return settings().redirectUri ?? `${origin}/auth/oidc/callback`;
}

/** Builds the provider URL and stores state/nonce/PKCE verifier in a short-lived encrypted cookie. */
export async function beginLogin(cookies: Cookies, origin: string, next: string, secure: boolean): Promise<URL> {
	const cfg = await configuration();
	const verifier = client.randomPKCECodeVerifier();
	const flow = { verifier, state: client.randomState(), nonce: client.randomNonce(), next };
	cookies.set(FLOW_COOKIE, encrypt(JSON.stringify(flow), 'oidc-flow'), {
		path: '/auth/oidc',
		httpOnly: true,
		sameSite: 'lax',
		secure,
		maxAge: 600
	});
	return client.buildAuthorizationUrl(cfg, {
		redirect_uri: redirectUri(origin),
		scope: settings().scopes,
		code_challenge: await client.calculatePKCECodeChallenge(verifier),
		code_challenge_method: 'S256',
		state: flow.state,
		nonce: flow.nonce
	});
}

export class LoginRefused extends Error {}

/** Completes the code exchange and maps the identity to a local user (creating one if allowed). */
export async function completeLogin(cookies: Cookies, currentUrl: URL, origin: string): Promise<{ user: User; next: string }> {
	const raw = cookies.get(FLOW_COOKIE);
	cookies.delete(FLOW_COOKIE, { path: '/auth/oidc' });
	if (!raw) throw new LoginRefused('Sign-in session expired. Please try again.');
	const flow = JSON.parse(decrypt(raw, 'oidc-flow')) as { verifier: string; state: string; nonce: string; next: string };

	const cfg = await configuration();
	// The callback URL must match the registered redirect URI exactly.
	const callback = new URL(redirectUri(origin));
	callback.search = currentUrl.search;
	const tokens = await client.authorizationCodeGrant(cfg, callback, {
		pkceCodeVerifier: flow.verifier,
		expectedState: flow.state,
		expectedNonce: flow.nonce
	});

	let claims: Record<string, unknown> = { ...tokens.claims() };
	if (!claims.email) {
		claims = { ...claims, ...(await client.fetchUserInfo(cfg, tokens.access_token, claims.sub as string)) };
	}
	const sub = String(claims.sub);
	const email = typeof claims.email === 'string' ? claims.email.trim() : '';
	const name = (claims.name ?? claims.preferred_username ?? null) as string | null;
	if (!email) throw new LoginRefused('Your identity provider did not share an email address (add the "email" scope).');
	if (claims.email_verified === false) throw new LoginRefused(`${email} is not verified with your identity provider.`);

	let user = findUserBySub(sub);
	if (!user) {
		const existing = findUserByEmail(email);
		if (existing) {
			// An admin added this email ahead of time; link it to the SSO identity.
			if (existing.sso) throw new LoginRefused(`${email} is already linked to a different SSO account.`);
			user = updateUser(existing.id, { oidcSub: sub, name: existing.name ?? name })!;
		} else if (emailMatches(email, settings().autoCreate)) {
			const role = emailMatches(email, settings().adminEmails) ? 'admin' : settings().defaultRole;
			user = createUser({ email, name, role, oidcSub: sub });
		} else {
			throw new LoginRefused(`${email} doesn't have access. Ask an admin to add you.`);
		}
	}
	if (user.disabled) throw new LoginRefused(`${email} has been disabled.`);
	return { user, next: flow.next };
}
