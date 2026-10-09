/**
 * Backup destinations: a local folder (or an NFS/CIFS volume mounted there), an SFTP
 * server, or S3-compatible object storage. Each one stores files under relative keys
 * like `nextcloud/nextcloud-20261009-030000.sql.gz`.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, posix, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import SftpClient from 'ssh2-sftp-client';
import { isSafeKey, type DestinationConfig, type DestinationSecrets, type SftpConfig } from '#lib/backups.ts';
import { s3Delete, s3Get, s3Put } from './s3.ts';

export { describeDestination } from '#lib/backups.ts';

export interface Driver {
	/** Writes the stream to `key`; resolves with the number of bytes stored. */
	put(key: string, stream: Readable): Promise<number>;
	get(key: string): Promise<{ stream: Readable; size: number | null }>;
	delete(key: string): Promise<void>;
}

export class DestinationError extends Error {}

function checkKey(key: string) {
	if (!isSafeKey(key)) throw new DestinationError(`Invalid backup file name "${key}"`);
}

/** Counts bytes flowing through. */
export function byteCounter(): Transform & { bytes: number } {
	const t = new Transform({
		transform(chunk: Buffer, _enc, cb) {
			t.bytes += chunk.length;
			cb(null, chunk);
		}
	}) as Transform & { bytes: number };
	t.bytes = 0;
	return t;
}

// --- local -------------------------------------------------------------------------

function localPath(base: string, key: string): string {
	checkKey(key);
	const root = resolve(base);
	const full = resolve(root, ...key.split('/'));
	if (!full.startsWith(root + sep)) throw new DestinationError('Path escapes the backup folder');
	return full;
}

function localDriver(path: string): Driver {
	if (!isAbsolute(path)) throw new DestinationError('The folder must be an absolute path, e.g. /backups');
	return {
		async put(key, stream) {
			const file = localPath(path, key);
			await mkdir(dirname(file), { recursive: true });
			const partial = `${file}.partial`;
			const counter = byteCounter();
			try {
				await pipeline(stream, counter, createWriteStream(partial, { mode: 0o600 }));
				await rename(partial, file);
			} catch (err) {
				await rm(partial, { force: true });
				throw err;
			}
			return counter.bytes;
		},
		async get(key) {
			const file = localPath(path, key);
			const s = await stat(file);
			return { stream: createReadStream(file), size: s.size };
		},
		async delete(key) {
			await rm(localPath(path, key), { force: true });
		}
	};
}

// --- sftp --------------------------------------------------------------------------

/** OpenSSH-style fingerprint of a host key: `SHA256:base64-without-padding`. */
export function fingerprint(key: Buffer): string {
	return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

async function sftpConnect(c: SftpConfig, s: DestinationSecrets, seen?: { hostKey?: string }): Promise<SftpClient> {
	const client = new SftpClient('pg-modern');
	const pinned = c.hostKey.trim().replace(/=+$/, '');
	await client.connect({
		host: c.host,
		port: c.port || 22,
		username: c.user,
		password: s.password || undefined,
		privateKey: s.privateKey || undefined,
		passphrase: s.passphrase || undefined,
		readyTimeout: 15_000,
		hostVerifier: (key: Buffer) => {
			const fp = fingerprint(key);
			if (seen) seen.hostKey = fp;
			return !pinned || fp === pinned;
		}
	});
	return client;
}

function remotePath(c: SftpConfig, key: string) {
	checkKey(key);
	return posix.join(c.path || '.', key);
}

function sftpDriver(c: SftpConfig, s: DestinationSecrets): Driver {
	return {
		async put(key, stream) {
			const client = await sftpConnect(c, s);
			const file = remotePath(c, key);
			const partial = `${file}.partial`;
			const counter = byteCounter();
			try {
				await client.mkdir(posix.dirname(file), true);
				await client.put(stream.pipe(counter), partial);
				await client.delete(file, true);
				await client.rename(partial, file);
				return counter.bytes;
			} catch (err) {
				stream.destroy();
				await client.delete(partial, true).catch(() => {});
				throw err;
			} finally {
				await client.end().catch(() => {});
			}
		},
		async get(key) {
			const client = await sftpConnect(c, s);
			try {
				const file = remotePath(c, key);
				const info = await client.stat(file);
				const stream = client.createReadStream(file);
				const close = () => void client.end().catch(() => {});
				stream.once('close', close);
				stream.once('error', close);
				return { stream: stream as unknown as Readable, size: info.size ?? null };
			} catch (err) {
				await client.end().catch(() => {});
				throw err;
			}
		},
		async delete(key) {
			const client = await sftpConnect(c, s);
			try {
				await client.delete(remotePath(c, key), true);
			} finally {
				await client.end().catch(() => {});
			}
		}
	};
}

// --- factory -----------------------------------------------------------------------

export function driverFor(dest: DestinationConfig, secrets: DestinationSecrets): Driver {
	switch (dest.kind) {
		case 'local':
			return localDriver(dest.config.path);
		case 'sftp':
			if (!secrets.password && !secrets.privateKey) throw new DestinationError('Set a password or a private key');
			return sftpDriver(dest.config, secrets);
		case 's3': {
			if (!secrets.secretAccessKey) throw new DestinationError('Set the secret access key');
			const t = { ...dest.config, secretAccessKey: secrets.secretAccessKey };
			return { put: (k, st) => (checkKey(k), s3Put(t, k, st)), get: (k) => (checkKey(k), s3Get(t, k)), delete: (k) => (checkKey(k), s3Delete(t, k)) };
		}
		default:
			throw new DestinationError('Unknown destination type');
	}
}

/** Writes, reads back and deletes a small file. Returns the SFTP host key seen, for pinning. */
export async function testDestination(dest: DestinationConfig, secrets: DestinationSecrets): Promise<{ hostKey?: string; latencyMs: number }> {
	const started = performance.now();
	const seen: { hostKey?: string } = {};
	if (dest.kind === 'sftp') {
		// Connect once on our own first, so a host-key mismatch can name the key we saw.
		try {
			const c = await sftpConnect(dest.config, secrets, seen);
			await c.end().catch(() => {});
		} catch (err) {
			if (seen.hostKey && dest.config.hostKey.trim() && seen.hostKey !== dest.config.hostKey.trim().replace(/=+$/, '')) {
				throw new DestinationError(`Host key mismatch: the server presented ${seen.hostKey}`);
			}
			throw err;
		}
	}
	const driver = driverFor(dest, secrets);
	const key = `.pg-modern-test-${Date.now().toString(36)}.txt`;
	const body = `pg-modern destination test ${new Date().toISOString()}\n`;
	await driver.put(key, Readable.from([Buffer.from(body)]));
	try {
		const { stream } = await driver.get(key);
		const chunks: Buffer[] = [];
		for await (const c of stream) chunks.push(Buffer.from(c));
		if (Buffer.concat(chunks).toString() !== body) throw new DestinationError('The test file read back differently');
	} finally {
		await driver.delete(key);
	}
	return { hostKey: seen.hostKey, latencyMs: Math.round(performance.now() - started) };
}

