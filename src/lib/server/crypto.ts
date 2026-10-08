import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

const ALGO = 'aes-256-gcm';
const VERSION = 'v1';

let cachedKey: Buffer | undefined;

/**
 * The master key protects every stored credential. It comes from PGM_SECRET_KEY when set,
 * otherwise from a random 256-bit key file created (mode 0600) on first start.
 */
function masterKey(): Buffer {
	if (cachedKey) return cachedKey;
	if (config.secretKey) {
		cachedKey = scryptSync(config.secretKey, 'pg-modern/master-key', 32);
		return cachedKey;
	}
	mkdirSync(config.dataDir, { recursive: true });
	const file = join(config.dataDir, 'secret.key');
	if (!existsSync(file)) {
		writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
	}
	cachedKey = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
	if (cachedKey.length !== 32) throw new Error(`Invalid key file at ${file}`);
	return cachedKey;
}

/** Encrypts `plaintext`, binding it to `context` (e.g. the connection id) as additional data. */
export function encrypt(plaintext: string, context: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv(ALGO, masterKey(), iv);
	cipher.setAAD(Buffer.from(context));
	const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return [VERSION, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
}

export function decrypt(payload: string, context: string): string {
	const [version, iv, tag, data] = payload.split(':');
	if (version !== VERSION) throw new Error('Unsupported ciphertext version');
	const decipher = createDecipheriv(ALGO, masterKey(), Buffer.from(iv, 'base64'));
	decipher.setAAD(Buffer.from(context));
	decipher.setAuthTag(Buffer.from(tag, 'base64'));
	return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

export function hashPassword(password: string): string {
	const salt = randomBytes(16);
	const hash = scryptSync(password, salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
	return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
	const [scheme, salt, hash] = stored.split(':');
	if (scheme !== 'scrypt') return false;
	const expected = Buffer.from(hash, 'base64');
	const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
		N: 1 << 15,
		r: 8,
		p: 1,
		maxmem: 64 * 1024 * 1024
	});
	return timingSafeEqual(expected, actual);
}

export function randomToken(bytes = 32): string {
	return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}
