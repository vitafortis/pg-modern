/**
 * A minimal streaming tar reader for Docker's `GET /containers/{id}/archive`, which
 * returns plain (uncompressed) POSIX tar: ustar headers, PAX extended headers for long
 * names, and GNU `././@LongLink` entries from older engines. Data is pushed in chunks
 * and handed to a per-entry sink, so a large file can be written to disk (or skipped)
 * without buffering it.
 */

export interface TarEntry {
	/** Path as stored (Docker uses the requested base name as the first component). */
	name: string;
	size: number;
	/** `file`, `directory`, `symlink`, `hardlink` or `other`. */
	type: 'file' | 'directory' | 'symlink' | 'hardlink' | 'other';
	mode: number;
	/** Seconds since the epoch. */
	mtime: number;
	linkname: string;
}

/** Receives one entry's data; return null from `onEntry` to skip it. */
export interface TarSink {
	data(chunk: Buffer): void;
	end(): void;
}

const BLOCK = 512;

function cstring(buf: Buffer, start: number, len: number): string {
	const slice = buf.subarray(start, start + len);
	const nul = slice.indexOf(0);
	return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8');
}

/** Octal field, or GNU base-256 for sizes beyond 8 GB. */
function numeric(buf: Buffer, start: number, len: number): number {
	if (buf[start] & 0x80) {
		let n = 0;
		for (let i = start + 1; i < start + len; i++) n = n * 256 + buf[i];
		return n;
	}
	const s = cstring(buf, start, len).trim();
	return s ? parseInt(s, 8) : 0;
}

function checksumOk(h: Buffer): boolean {
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
	return sum === numeric(h, 148, 8);
}

/** PAX records: `<len> key=value\n`. */
export function parsePax(body: Buffer): Record<string, string> {
	const out: Record<string, string> = {};
	let i = 0;
	while (i < body.length) {
		const sp = body.indexOf(0x20, i);
		if (sp === -1) break;
		const len = parseInt(body.subarray(i, sp).toString('ascii'), 10);
		if (!len) break;
		const record = body.subarray(sp + 1, i + len - 1).toString('utf8');
		const eq = record.indexOf('=');
		if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
		i += len;
	}
	return out;
}

const TYPES: Record<string, TarEntry['type']> = { '0': 'file', '\0': 'file', '7': 'file', '5': 'directory', '2': 'symlink', '1': 'hardlink' };

export interface TarReader {
	write(chunk: Buffer): void;
	/** True once the end-of-archive blocks were seen. */
	readonly done: boolean;
	/** Bytes consumed so far. */
	readonly bytes: number;
}

export function tarReader(onEntry: (entry: TarEntry) => TarSink | null): TarReader {
	let pending = Buffer.alloc(0);
	let bytes = 0;
	let done = false;
	/** Bytes of the current entry's body still to come, and padding after it. */
	let remaining = 0;
	let padding = 0;
	let sink: TarSink | null = null;
	/** Collects a PAX or LongLink body (small) instead of a sink. */
	let meta: { kind: 'pax' | 'longname' | 'longlink' | 'skip'; chunks: Buffer[] } | null = null;
	let nextName: string | null = null;
	let nextLink: string | null = null;
	let nextSize: number | null = null;

	function finishBody() {
		if (sink) sink.end();
		sink = null;
		if (meta) {
			const body = Buffer.concat(meta.chunks);
			if (meta.kind === 'pax') {
				const pax = parsePax(body);
				if (pax.path) nextName = pax.path;
				if (pax.linkpath) nextLink = pax.linkpath;
				if (pax.size) nextSize = Number(pax.size);
			} else if (meta.kind === 'longname') nextName = cstring(body, 0, body.length);
			else if (meta.kind === 'longlink') nextLink = cstring(body, 0, body.length);
			meta = null;
		}
	}

	function header(h: Buffer) {
		if (h.every((b) => b === 0)) {
			done = true;
			return;
		}
		if (!checksumOk(h)) throw new Error('Not a tar archive (bad header checksum)');
		const flag = String.fromCharCode(h[156] || 0);
		let size = numeric(h, 124, 12);
		const prefix = h.subarray(257, 262).toString('ascii') === 'ustar' ? cstring(h, 345, 155) : '';
		let name = cstring(h, 0, 100);
		if (prefix) name = `${prefix}/${name}`;
		remaining = size;
		padding = (BLOCK - (size % BLOCK)) % BLOCK;
		if (flag === 'x' || flag === 'g' || flag === 'L' || flag === 'K') {
			meta = { kind: flag === 'x' ? 'pax' : flag === 'L' ? 'longname' : flag === 'K' ? 'longlink' : 'skip', chunks: [] };
			if (remaining === 0) finishBody();
			return;
		}
		if (nextSize != null) {
			size = nextSize;
			remaining = size;
			padding = (BLOCK - (size % BLOCK)) % BLOCK;
		}
		const entry: TarEntry = {
			name: nextName ?? name,
			size,
			type: TYPES[flag] ?? 'other',
			mode: numeric(h, 100, 8),
			mtime: numeric(h, 136, 12),
			linkname: nextLink ?? cstring(h, 157, 100)
		};
		nextName = nextLink = null;
		nextSize = null;
		sink = onEntry(entry);
		if (remaining === 0) finishBody();
	}

	return {
		get done() {
			return done;
		},
		get bytes() {
			return bytes;
		},
		write(chunk: Buffer) {
			bytes += chunk.length;
			let buf = pending.length ? Buffer.concat([pending, chunk]) : chunk;
			pending = Buffer.alloc(0);
			while (buf.length && !done) {
				if (remaining > 0) {
					const take = Math.min(remaining, buf.length);
					const part = buf.subarray(0, take);
					if (meta) meta.kind !== 'skip' && meta.chunks.push(Buffer.from(part));
					else sink?.data(part);
					remaining -= take;
					buf = buf.subarray(take);
					if (remaining === 0) finishBody();
				} else if (padding > 0) {
					const take = Math.min(padding, buf.length);
					padding -= take;
					buf = buf.subarray(take);
				} else if (buf.length >= BLOCK) {
					header(buf.subarray(0, BLOCK));
					buf = buf.subarray(BLOCK);
				} else {
					pending = Buffer.from(buf);
					break;
				}
			}
		}
	};
}

/** Collects an entry's first `n` bytes (e.g. to check a SQLite header). */
export function headSink(n: number, done: (head: Buffer) => void): TarSink {
	const chunks: Buffer[] = [];
	let have = 0;
	return {
		data(chunk) {
			if (have >= n) return;
			chunks.push(chunk.subarray(0, n - have));
			have += Math.min(chunk.length, n - have);
		},
		end() {
			done(Buffer.concat(chunks));
		}
	};
}

/** Builds a tar archive in memory (tests and the screenshot mock). Names up to 100 bytes, or PAX for longer. */
export function buildTar(files: { name: string; data?: Buffer | string; type?: 'file' | 'directory'; mtime?: number }[]): Buffer {
	const blocks: Buffer[] = [];
	const headerFor = (name: string, size: number, flag: string, mtime: number) => {
		const h = Buffer.alloc(BLOCK);
		h.write(name.slice(0, 100), 0, 'utf8');
		h.write('0000644\0', 100);
		h.write('0000000\0', 108);
		h.write('0000000\0', 116);
		h.write(size.toString(8).padStart(11, '0') + '\0', 124);
		h.write(Math.floor(mtime).toString(8).padStart(11, '0') + '\0', 136);
		h.write('        ', 148);
		h.write(flag, 156);
		h.write('ustar\0', 257);
		h.write('00', 263);
		let sum = 0;
		for (const b of h) sum += b;
		h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
		return h;
	};
	const pad = (n: number) => Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK);
	for (const f of files) {
		const data = typeof f.data === 'string' ? Buffer.from(f.data) : (f.data ?? Buffer.alloc(0));
		const mtime = f.mtime ?? 1_700_000_000;
		if (Buffer.byteLength(f.name) > 100) {
			const rec = ` path=${f.name}\n`;
			let len = rec.length + 2;
			len = `${len}${rec}`.length;
			const body = Buffer.from(`${len}${rec}`);
			blocks.push(headerFor('PaxHeader', body.length, 'x', mtime), body, pad(body.length));
		}
		blocks.push(headerFor(f.name, f.type === 'directory' ? 0 : data.length, f.type === 'directory' ? '5' : '0', mtime));
		if (f.type !== 'directory') blocks.push(data, pad(data.length));
	}
	blocks.push(Buffer.alloc(BLOCK * 2));
	return Buffer.concat(blocks);
}
