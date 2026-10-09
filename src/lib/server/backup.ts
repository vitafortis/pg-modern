import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';

/**
 * Portable, passphrase-encrypted backups of pg·modern's own configuration.
 *
 * The key is derived from the passphrase (scrypt), never from the master key, so a
 * backup restores on a new install whose master key is different. The envelope is
 * plain JSON; everything sensitive is inside `data` (AES-256-GCM, with the envelope's
 * header fields bound as additional data so they can't be swapped either).
 */

export const BACKUP_FORMAT = 'pg-modern-backup' as const;
export const BACKUP_VERSION = 1;
export const MIN_PASSPHRASE = 12;

export interface KdfParams {
	name: 'scrypt';
	N: number;
	r: number;
	p: number;
	salt: string;
}

export interface BackupEnvelope {
	format: typeof BACKUP_FORMAT;
	version: number;
	createdAt: string;
	appVersion: string;
	kdf: KdfParams;
	cipher: 'aes-256-gcm';
	iv: string;
	tag: string;
	data: string;
}

/** scrypt cost; tests pass a lower N. */
export interface BackupOptions {
	N?: number;
	r?: number;
	p?: number;
	appVersion?: string;
	now?: Date;
}

const DEFAULT_N = 1 << 17;
/** Refuse absurd costs from a crafted file (memory = 128 * N * r bytes). */
const MAX_N = 1 << 20;
const MAX_MEM = 512 * 1024 * 1024;

export class BackupError extends Error {}

export const WRONG_PASSPHRASE = 'Wrong passphrase or damaged file';

export function checkPassphrase(passphrase: unknown): string {
	if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
		throw new BackupError(`The passphrase needs at least ${MIN_PASSPHRASE} characters`);
	}
	return passphrase;
}

function deriveKey(passphrase: string, kdf: KdfParams): Promise<Buffer> {
	const maxmem = 256 * kdf.N * kdf.r + 32 * 1024 * 1024;
	return new Promise((resolve, reject) =>
		scrypt(passphrase.normalize('NFC'), Buffer.from(kdf.salt, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem }, (err, key) =>
			err ? reject(err) : resolve(key)
		)
	);
}

/** The header fields are authenticated, so e.g. a downgraded kdf or edited date fails to decrypt. */
function aad(e: Pick<BackupEnvelope, 'format' | 'version' | 'createdAt' | 'appVersion' | 'kdf' | 'cipher'>): Buffer {
	return Buffer.from(JSON.stringify([e.format, e.version, e.createdAt, e.appVersion, e.kdf.name, e.kdf.N, e.kdf.r, e.kdf.p, e.kdf.salt, e.cipher]));
}

export async function encodeBackup(payload: unknown, passphrase: string, opts: BackupOptions = {}): Promise<BackupEnvelope> {
	checkPassphrase(passphrase);
	const kdf: KdfParams = { name: 'scrypt', N: opts.N ?? DEFAULT_N, r: opts.r ?? 8, p: opts.p ?? 1, salt: randomBytes(16).toString('base64') };
	const header = {
		format: BACKUP_FORMAT,
		version: BACKUP_VERSION,
		createdAt: (opts.now ?? new Date()).toISOString(),
		appVersion: opts.appVersion ?? 'unknown',
		kdf,
		cipher: 'aes-256-gcm' as const
	};
	const key = await deriveKey(passphrase, kdf);
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(aad(header));
	const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
	return { ...header, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

/** Parses and validates an envelope (from a string or an already-parsed object). */
export function parseEnvelope(input: unknown): BackupEnvelope {
	let e: unknown = input;
	if (typeof input === 'string') {
		try {
			e = JSON.parse(input);
		} catch {
			throw new BackupError('Not a pg·modern backup file');
		}
	}
	const o = e as Partial<BackupEnvelope> | null;
	if (!o || typeof o !== 'object' || o.format !== BACKUP_FORMAT) throw new BackupError('Not a pg·modern backup file');
	if (o.version !== BACKUP_VERSION) throw new BackupError(`Unsupported backup version ${o.version}`);
	const k = o.kdf;
	const isInt = (n: unknown, min: number, max: number) => Number.isInteger(n) && (n as number) >= min && (n as number) <= max;
	if (
		!k ||
		k.name !== 'scrypt' ||
		!isInt(k.N, 2, MAX_N) ||
		((k.N as number) & ((k.N as number) - 1)) !== 0 ||
		!isInt(k.r, 1, 32) ||
		!isInt(k.p, 1, 16) ||
		128 * (k.N as number) * (k.r as number) > MAX_MEM ||
		typeof k.salt !== 'string' ||
		o.cipher !== 'aes-256-gcm' ||
		typeof o.iv !== 'string' ||
		typeof o.tag !== 'string' ||
		typeof o.data !== 'string' ||
		typeof o.createdAt !== 'string' ||
		typeof o.appVersion !== 'string'
	) {
		throw new BackupError('Damaged backup file');
	}
	return o as BackupEnvelope;
}

export async function decodeBackup<T = unknown>(input: unknown, passphrase: string): Promise<{ envelope: BackupEnvelope; payload: T }> {
	const envelope = parseEnvelope(input);
	if (typeof passphrase !== 'string' || !passphrase) throw new BackupError('Enter the passphrase');
	const key = await deriveKey(passphrase, envelope.kdf);
	try {
		const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
		decipher.setAAD(aad(envelope));
		decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
		const text = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8');
		return { envelope, payload: JSON.parse(text) as T };
	} catch {
		throw new BackupError(WRONG_PASSPHRASE);
	}
}

/** `pg-modern-backup-2026-10-08.pgmbackup` */
export function backupFilename(date = new Date()): string {
	return `pg-modern-backup-${date.toISOString().slice(0, 10)}.pgmbackup`;
}
