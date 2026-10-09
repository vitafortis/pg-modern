/**
 * A small S3 client (SigV4 via aws4fetch) for S3-compatible storage: MinIO, Garage,
 * TrueNAS / Synology C2, Backblaze B2, AWS. Uploads stream in 16 MiB parts with
 * multipart upload, so a dump never has to fit in memory or on local disk.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { AwsClient } from 'aws4fetch';
import type { S3Config } from '#lib/backups.ts';

export const PART_SIZE = 16 * 1024 * 1024;
/** S3 allows 10,000 parts: 16 MiB × 10,000 ≈ 156 GiB per dump. */
export const MAX_PARTS = 10_000;

export interface S3Target extends S3Config {
	secretAccessKey: string;
}

function encodeKey(key: string): string {
	return key.split('/').map(encodeURIComponent).join('/');
}

/** Object URL, path-style (`endpoint/bucket/key`) or virtual-hosted (`bucket.endpoint/key`). */
export function objectUrl(t: S3Config, key: string): URL {
	const base = new URL(t.endpoint.includes('://') ? t.endpoint : `https://${t.endpoint}`);
	const basePath = base.pathname.replace(/\/+$/, '');
	if (t.pathStyle) {
		base.pathname = `${basePath}/${encodeURIComponent(t.bucket)}/${encodeKey(key)}`;
	} else {
		base.hostname = `${t.bucket}.${base.hostname}`;
		base.pathname = `${basePath}/${encodeKey(key)}`;
	}
	return base;
}

export function fullKey(t: S3Config, key: string): string {
	const prefix = t.prefix.replace(/^\/+/, '').replace(/\/*$/, t.prefix.trim() ? '/' : '');
	return `${prefix}${key}`;
}

function client(t: S3Target) {
	return new AwsClient({ accessKeyId: t.accessKeyId, secretAccessKey: t.secretAccessKey, region: t.region || 'us-east-1', service: 's3' });
}

async function check(res: Response, what: string): Promise<Response> {
	if (res.ok) return res;
	const text = await res.text().catch(() => '');
	const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
	const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1];
	throw new Error(`S3 ${what} failed: ${res.status}${code ? ` ${code}` : ''}${message ? ` — ${message}` : ''}`);
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Reads exactly `size` bytes (or what's left) from an async iterator of chunks. */
async function* parts(stream: Readable, size: number): AsyncGenerator<Buffer> {
	let chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of stream) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		chunks.push(buf);
		length += buf.length;
		while (length >= size) {
			const all = Buffer.concat(chunks);
			yield all.subarray(0, size);
			chunks = [all.subarray(size)];
			length = all.length - size;
		}
	}
	if (length > 0 || chunks.length === 0) yield Buffer.concat(chunks);
}

/** Uploads a stream; returns the byte count. Small objects go in one PUT. */
export async function s3Put(t: S3Target, key: string, stream: Readable, partSize = PART_SIZE): Promise<number> {
	const aws = client(t);
	const url = objectUrl(t, fullKey(t, key));
	const it = parts(stream, partSize);
	const first = await it.next();
	const firstPart = first.done ? Buffer.alloc(0) : first.value;
	const second = firstPart.length < partSize ? { done: true as const, value: undefined } : await it.next();

	if (second.done) {
		await check(
			await aws.fetch(url, { method: 'PUT', body: firstPart as unknown as BodyInit, headers: { 'x-amz-content-sha256': sha256(firstPart), 'content-type': 'application/octet-stream' } }),
			'upload'
		);
		return firstPart.length;
	}

	const createUrl = new URL(url);
	createUrl.search = 'uploads=';
	const created = await (await check(await aws.fetch(createUrl, { method: 'POST', headers: { 'content-type': 'application/octet-stream' } }), 'multipart start')).text();
	const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(created)?.[1];
	if (!uploadId) throw new Error('S3 multipart start returned no UploadId');

	const etags: string[] = [];
	let total = 0;
	try {
		const upload = async (body: Buffer) => {
			if (etags.length >= MAX_PARTS) throw new Error(`Dump is larger than ${MAX_PARTS} parts of ${partSize / 1048576} MiB`);
			const partUrl = new URL(url);
			partUrl.search = new URLSearchParams({ partNumber: String(etags.length + 1), uploadId }).toString();
			const res = await check(await aws.fetch(partUrl, { method: 'PUT', body: body as unknown as BodyInit, headers: { 'x-amz-content-sha256': sha256(body) } }), `part ${etags.length + 1}`);
			etags.push(res.headers.get('etag') ?? '');
			total += body.length;
		};
		await upload(firstPart);
		await upload(second.value!);
		for await (const part of it) if (part.length) await upload(part);

		const xml =
			'<CompleteMultipartUpload>' +
			etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</ETag></Part>`).join('') +
			'</CompleteMultipartUpload>';
		const doneUrl = new URL(url);
		doneUrl.search = new URLSearchParams({ uploadId }).toString();
		const res = await check(await aws.fetch(doneUrl, { method: 'POST', body: xml, headers: { 'content-type': 'application/xml' } }), 'multipart complete');
		// S3 can report an error inside a 200 response.
		const text = await res.text();
		if (/<Error>/.test(text)) throw new Error(`S3 multipart complete failed: ${/<Message>([^<]+)/.exec(text)?.[1] ?? text.slice(0, 200)}`);
		return total;
	} catch (err) {
		const abortUrl = new URL(url);
		abortUrl.search = new URLSearchParams({ uploadId }).toString();
		await aws.fetch(abortUrl, { method: 'DELETE' }).catch(() => {});
		throw err;
	}
}

export async function s3Get(t: S3Target, key: string): Promise<{ stream: Readable; size: number | null }> {
	const res = await check(await client(t).fetch(objectUrl(t, fullKey(t, key))), 'download');
	if (!res.body) throw new Error('S3 download returned no body');
	const len = Number(res.headers.get('content-length'));
	return { stream: Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), size: Number.isFinite(len) && len > 0 ? len : null };
}

export async function s3Delete(t: S3Target, key: string): Promise<void> {
	const res = await client(t).fetch(objectUrl(t, fullKey(t, key)), { method: 'DELETE' });
	if (res.status === 404) return;
	await check(res, 'delete');
}
