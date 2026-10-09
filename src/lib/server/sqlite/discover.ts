/**
 * SQLite discovery helpers: reading a file's header, walking a folder for databases,
 * and turning what was found into Discover candidates.
 */
import { open, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { candidateLabel, guessApp, headerSaysWal, isNoiseDatabase, isSqliteCandidateName, isSqliteHeader } from './files.ts';
import { insideDataDir } from './client.ts';
import type { Candidate, ConnectionSource, SqliteCandidateInfo } from '#lib/types.ts';

/** First bytes of a file, or null if it can't be read. */
export async function readHeader(path: string, bytes = 100): Promise<Buffer | null> {
	let fh;
	try {
		fh = await open(path, 'r');
		const buf = Buffer.alloc(bytes);
		const { bytesRead } = await fh.read(buf, 0, bytes, 0);
		return buf.subarray(0, bytesRead);
	} catch {
		return null;
	} finally {
		await fh?.close().catch(() => {});
	}
}

export interface FoundDatabase {
	path: string;
	size: number;
	wal: boolean;
}

/** Checks a candidate file's header; returns what discovery shows about it. */
export async function inspectDatabase(path: string): Promise<FoundDatabase | null> {
	if (isNoiseDatabase(path) || insideDataDir(path)) return null;
	const head = await readHeader(path);
	if (!isSqliteHeader(head)) return null;
	let size = 0;
	try {
		size = (await stat(path)).size;
	} catch {}
	return { path, size, wal: headerSaysWal(head) || existsSync(`${path}-wal`) };
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'proc', 'sys', 'dev', 'cache', 'Cache', 'caches', '.cache', 'transcodes', 'metadata', 'logs', 'log']);

/** Walks a folder for SQLite databases (by name, confirmed by header). */
export async function findSqliteFiles(root: string, depth: number, limit = 200): Promise<FoundDatabase[]> {
	const out: FoundDatabase[] = [];
	const walk = async (dir: string, d: number) => {
		if (out.length >= limit) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = join(dir, e.name);
			if (e.isFile() && isSqliteCandidateName(e.name)) {
				const found = await inspectDatabase(full);
				if (found) out.push(found);
			} else if (e.isDirectory() && d > 0 && !SKIP_DIRS.has(e.name)) await walk(full, d - 1);
			if (out.length >= limit) return;
		}
	};
	await walk(root, depth);
	return out;
}

export function sqliteFingerprint(database: string, where = ''): string {
	return `sqlite:${where}:${database}`;
}

/** A Discover candidate for a SQLite database. `database` is the local path (or the path in the container for archive candidates). */
export function sqliteCandidate(opts: {
	database: string;
	source: ConnectionSource;
	info: SqliteCandidateInfo;
	/** Folder or container the label is taken from. */
	context?: string;
	notes?: string[];
}): Candidate {
	const where = opts.info.via === 'archive' ? `${opts.info.endpoint}#${opts.info.container}` : '';
	const notes = [...(opts.notes ?? [])];
	return {
		engine: 'sqlite',
		flavor: 'sqlite',
		fingerprint: sqliteFingerprint(opts.database, where),
		name: candidateLabel(opts.info.containerPath ?? opts.database, opts.context),
		host: '',
		port: 0,
		database: opts.database,
		user: '',
		hasPassword: false,
		sslMode: 'disable',
		source: opts.source,
		notes,
		reachable: true,
		sqlite: { ...opts.info, app: opts.info.app ?? guessApp(`${opts.context ?? ''}/${opts.info.containerPath ?? opts.database}`) }
	};
}
