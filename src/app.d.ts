// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		interface Error {
			message: string;
		}
		interface Locals {
			auth: import('#lib/server/auth.ts').AuthState;
		}
	}
}

export {};
