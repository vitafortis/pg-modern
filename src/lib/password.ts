/**
 * Strong random passwords for generated database users. Letters and digits only, so
 * they survive every quoting context (SQL literals, URLs, .env files, shells)
 * without escaping. Works in the browser (crypto.getRandomValues is available even
 * on plain-http pages) and in Node.
 */
export const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function generatePassword(length = 28): string {
	const n = PASSWORD_ALPHABET.length;
	// Rejection sampling keeps every character equally likely.
	const limit = 256 - (256 % n);
	let out = '';
	const buf = new Uint8Array(length * 2);
	while (out.length < length) {
		globalThis.crypto.getRandomValues(buf);
		for (const b of buf) {
			if (b < limit) out += PASSWORD_ALPHABET[b % n];
			if (out.length === length) break;
		}
	}
	return out;
}
