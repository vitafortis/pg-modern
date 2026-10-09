// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		interface Error {
			message: string;
		}
		interface Locals {
			auth: import('#lib/server/auth.ts').AuthState;
			user: import('#lib/types.ts').User | null;
			/** Origin the browser used (see origin.ts); use instead of url.origin. */
			origin: string;
			/** Whether the browser connection is https, for Secure cookies. */
			secure: boolean;
			/** Client address, for the audit log. */
			ip?: string;
			/** Set only on /api/status routes, by a valid API token (never a session). */
			apiToken?: import('#lib/server/api-tokens.ts').TokenPrincipal;
		}
	}
}

export {};
