import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

function list(value: string | undefined): string[] {
	return (value ?? '')
		.split(/[,;\n]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

function defaultDockerHosts(): string[] {
	if (process.env.DOCKER_HOST) return [process.env.DOCKER_HOST];
	const candidates = [
		'/var/run/docker.sock',
		`${process.env.HOME}/.docker/run/docker.sock`,
		`${process.env.HOME}/.orbstack/run/docker.sock`,
		`${process.env.HOME}/.colima/default/docker.sock`
	];
	const found = candidates.find((p) => existsSync(p));
	return found ? [`unix://${found}`] : [];
}

/** True when this process itself runs inside a container. */
export const IN_CONTAINER = existsSync('/.dockerenv') || existsSync('/run/.containerenv');

export const config = {
	dataDir: resolve(process.env.PGM_DATA_DIR ?? './data'),
	/** Optional master secret. When unset, a random key is generated in the data dir. */
	secretKey: process.env.PGM_SECRET_KEY,
	/** `disabled` turns off the login screen — only for fully trusted networks. */
	authDisabled: process.env.PGM_AUTH === 'disabled',
	/** Docker endpoints, e.g. `unix:///var/run/docker.sock,tcp://10.0.0.5:2375`. */
	dockerHosts: process.env.PGM_DOCKER_HOSTS ? list(process.env.PGM_DOCKER_HOSTS) : defaultDockerHosts(),
	/** Folders to scan for .env / compose files, in addition to ones saved in settings. */
	scanPaths: list(process.env.PGM_SCAN_PATHS),
	scanDepth: Number(process.env.PGM_SCAN_DEPTH ?? 6),
	/** `disabled` hides the email/password form (SSO only). */
	localLoginDisabled: process.env.PGM_LOCAL_LOGIN === 'disabled',
	oidc: process.env.PGM_OIDC_ISSUER
		? {
				issuer: process.env.PGM_OIDC_ISSUER,
				clientId: process.env.PGM_OIDC_CLIENT_ID ?? '',
				clientSecret: process.env.PGM_OIDC_CLIENT_SECRET,
				/** Label on the login button. */
				name: process.env.PGM_OIDC_NAME ?? 'SSO',
				scopes: process.env.PGM_OIDC_SCOPES ?? 'openid email profile',
				/** Override when the public URL can't be inferred (defaults to <origin>/auth/oidc/callback). */
				redirectUri: process.env.PGM_OIDC_REDIRECT_URI,
				/** Email patterns that may create an account on first login, e.g. `*@example.com`. */
				autoCreate: list(process.env.PGM_OIDC_AUTO_CREATE),
				/** Email patterns that get the admin role when auto-created. */
				adminEmails: list(process.env.PGM_OIDC_ADMIN_EMAILS),
				defaultRole: process.env.PGM_OIDC_DEFAULT_ROLE === 'admin' ? ('admin' as const) : ('viewer' as const)
			}
		: undefined,
	statementTimeoutMs: Number(process.env.PGM_STATEMENT_TIMEOUT_MS ?? 30_000),
	maxRows: Number(process.env.PGM_MAX_ROWS ?? 5_000)
};
