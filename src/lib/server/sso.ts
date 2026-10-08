import { config } from './config.ts';
import { decrypt, encrypt } from './crypto.ts';
import { deleteKv, getKv, setKv } from './store.ts';
import type { Role } from '#lib/types.ts';

/** Effective OIDC settings, from environment variables (which win) or the Integrations page. */
export interface SsoConfig {
	issuer: string;
	clientId: string;
	clientSecret?: string;
	name: string;
	scopes: string;
	redirectUri?: string;
	autoCreate: string[];
	adminEmails: string[];
	defaultRole: Role;
	source: 'env' | 'ui';
}

type Stored = Omit<SsoConfig, 'clientSecret' | 'source'>;

const KEY = 'sso';
const SECRET_KEY = 'sso-secret';
const LOCAL_LOGIN_KEY = 'local-login-disabled';

export function ssoConfig(): SsoConfig | undefined {
	if (config.oidc) return { ...config.oidc, source: 'env' };
	const stored = getKv<Stored | undefined>(KEY, undefined);
	if (!stored) return undefined;
	const sealed = getKv<string | undefined>(SECRET_KEY, undefined);
	return { ...stored, clientSecret: sealed ? decrypt(sealed, 'sso') : undefined, source: 'ui' };
}

/** Saves UI-managed SSO settings. `clientSecret: undefined` keeps the stored one; `''` clears it. */
export function saveSso(input: Stored & { clientSecret?: string }) {
	const { clientSecret, ...rest } = input;
	setKv(KEY, rest);
	if (clientSecret === '') deleteKv(SECRET_KEY);
	else if (clientSecret !== undefined) setKv(SECRET_KEY, encrypt(clientSecret, 'sso'));
}

export function deleteSso() {
	deleteKv(KEY);
	deleteKv(SECRET_KEY);
	deleteKv(LOCAL_LOGIN_KEY);
}

export function hasStoredSecret(): boolean {
	return config.oidc ? !!config.oidc.clientSecret : getKv<string | undefined>(SECRET_KEY, undefined) !== undefined;
}

/** Whether the email/password form is off. Never true without SSO, so you can't lock yourself out. */
export function localLoginDisabled(): boolean {
	if (config.localLogin === 'enabled') return false;
	if (!ssoConfig()) return false;
	if (config.localLogin === 'disabled') return true;
	return getKv<boolean>(LOCAL_LOGIN_KEY, false);
}

export function setLocalLoginDisabled(disabled: boolean) {
	setKv(LOCAL_LOGIN_KEY, disabled);
}
