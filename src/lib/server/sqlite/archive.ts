/**
 * SQLite inside containers, through the Docker API's archive endpoint — opt-in
 * (Integrations → "Read SQLite files from containers via the Docker API").
 *
 * `HEAD /containers/{id}/archive?path=…` stats a path (X-Docker-Container-Path-Stat)
 * and `GET` streams it as a tar archive. Both are GET-class requests, so the read-only
 * docker-socket-proxy (CONTAINERS=1, POST=0) allows them; PUT (writing into a
 * container) stays blocked. Databases found this way are copied into pg·modern's data
 * dir as snapshots and browsed read-only.
 */
import { request, type IncomingMessage } from 'node:http';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { getConnection, getSettings, getSqliteSnapshot, setConnectionDatabase, setSqliteSnapshot } from '../store.ts';
import { NotFound } from '../pg.ts';
import { closePool, finalizeSnapshotFile } from './client.ts';
import { headerSaysWal, isBulkMount, isSqliteCandidateName, isSqliteHeader, KNOWN_CONTAINER_PATHS, isNoiseDatabase } from './files.ts';
import { headSink, tarReader, type TarEntry } from './tar.ts';
import { sqliteCandidate } from './discover.ts';
import type { Candidate, SqliteSnapshot } from '#lib/types.ts';

export const DEFAULT_SNAPSHOT_MAX_MB = 512;

export function archiveEnabled(): boolean {
	return getSettings().sqliteArchive === true;
}

export function snapshotMaxBytes(): number {
	const mb = Number(getSettings().sqliteSnapshotMaxMb ?? DEFAULT_SNAPSHOT_MAX_MB);
	return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_SNAPSHOT_MAX_MB) * 1024 * 1024;
}

export function snapshotDir(): string {
	return join(config.dataDir, 'sqlite-snapshots');
}

// --- Docker requests --------------------------------------------------------------

function target(endpoint: string, path: string) {
	if (endpoint.startsWith('unix://')) return { socketPath: endpoint.slice('unix://'.length), path };
	const u = new URL(endpoint.replace(/^tcp:/, 'http:'));
	return { host: u.hostname, port: Number(u.port) || 2375, path };
}

function dockerRequest(endpoint: string, method: 'GET' | 'HEAD', path: string, timeoutMs = 10_000): Promise<IncomingMessage> {
	return new Promise((resolve, reject) => {
		const req = request({ ...target(endpoint, path), method, timeout: timeoutMs, headers: { Host: 'docker' } }, resolve);
		req.on('timeout', () => req.destroy(new Error('Docker API timed out')));
		req.on('error', reject);
		req.end();
	});
}

async function readBody(res: IncomingMessage, max = 64 * 1024): Promise<string> {
	const chunks: Buffer[] = [];
	let n = 0;
	for await (const c of res) {
		if (n < max) chunks.push(c as Buffer);
		n += (c as Buffer).length;
	}
	return Buffer.concat(chunks).toString('utf8');
}

async function apiError(res: IncomingMessage, what: string): Promise<Error> {
	const body = await readBody(res).catch(() => '');
	if (res.statusCode === 403) {
		return new Error(`${what}: the Docker endpoint refused the request (403). With docker-socket-proxy, set CONTAINERS=1 (linuxserver/socket-proxy also needs ALLOW_ARCHIVE=1).`);
	}
	let message = body;
	try {
		message = JSON.parse(body).message ?? body;
	} catch {}
	return new Error(`${what}: Docker API ${res.statusCode}${message ? ` — ${message.slice(0, 200)}` : ''}`);
}

async function dockerJson<T>(endpoint: string, path: string): Promise<T> {
	const res = await dockerRequest(endpoint, 'GET', path);
	if ((res.statusCode ?? 500) >= 400) throw await apiError(res, path);
	return JSON.parse(await readBody(res, 8 * 1024 * 1024)) as T;
}

const archivePath = (id: string, path: string) => `/containers/${encodeURIComponent(id)}/archive?path=${encodeURIComponent(path)}`;

export interface PathStat {
	name: string;
	size: number;
	mode: number;
	mtime: string;
	linkTarget: string;
}

/** Go's os.FileMode bits, as Docker reports them. */
const MODE_DIR = 2 ** 31;
const MODE_SYMLINK = 2 ** 27;
export const isDirMode = (mode: number) => mode >= MODE_DIR;
export const isSymlinkMode = (mode: number) => Math.floor(mode / MODE_SYMLINK) % 2 === 1;

/** Decodes the X-Docker-Container-Path-Stat header (base64 JSON). */
export function decodePathStat(header: string | string[] | undefined): PathStat | null {
	const value = Array.isArray(header) ? header[0] : header;
	if (!value) return null;
	try {
		return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as PathStat;
	} catch {
		return null;
	}
}

/** Stats a path inside a container (HEAD on the archive endpoint); null if it doesn't exist. */
export async function statPath(endpoint: string, containerId: string, path: string): Promise<PathStat | null> {
	const res = await dockerRequest(endpoint, 'HEAD', archivePath(containerId, path));
	res.resume();
	if (res.statusCode === 404) return null;
	if ((res.statusCode ?? 500) >= 400) throw await apiError(res, `stat ${path}`);
	return decodePathStat(res.headers['x-docker-container-path-stat']);
}

/** Follows a symlink (once or twice) to the file it points at. */
async function statFollow(endpoint: string, containerId: string, path: string): Promise<{ path: string; stat: PathStat } | null> {
	let current = path;
	for (let i = 0; i < 3; i++) {
		const st = await statPath(endpoint, containerId, current);
		if (!st) return null;
		if (!isSymlinkMode(st.mode) || !st.linkTarget) return { path: current, stat: st };
		current = posix.resolve(posix.dirname(current), st.linkTarget);
	}
	return null;
}

export interface ListedDatabase {
	path: string;
	size: number;
	wal: boolean;
}

export interface ListOptions {
	/** Stop reading the archive after this many bytes (file contents stream through too). */
	maxBytes: number;
	maxEntries: number;
	timeoutMs: number;
	/** Deepest folder level below the listed one to report. */
	maxDepth: number;
}

/**
 * Lists a folder inside a container by streaming its tar archive, checking the header
 * of each file whose name looks like a database. Reading stops at the caps, so a
 * folder full of media costs at most `maxBytes`.
 */
export async function listDatabases(endpoint: string, containerId: string, dir: string, opts: ListOptions): Promise<{ found: ListedDatabase[]; truncated: boolean }> {
	const res = await dockerRequest(endpoint, 'GET', archivePath(containerId, dir), opts.timeoutMs);
	if (res.statusCode === 404) {
		res.resume();
		return { found: [], truncated: false };
	}
	if ((res.statusCode ?? 500) >= 400) throw await apiError(res, `list ${dir}`);
	const parent = posix.dirname(dir);
	const files = new Map<string, TarEntry>();
	const heads = new Map<string, Buffer>();
	let entries = 0;
	let truncated = false;
	const reader = tarReader((entry) => {
		entries++;
		if (entry.type !== 'file') return null;
		const full = posix.join(parent, entry.name);
		files.set(full, entry);
		const depth = entry.name.split('/').length - 2;
		if (depth > opts.maxDepth || !isSqliteCandidateName(posix.basename(full)) || isNoiseDatabase(full)) return null;
		return headSink(100, (head) => heads.set(full, head));
	});
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => stop(true), opts.timeoutMs);
		const stop = (cut: boolean) => {
			clearTimeout(timer);
			if (cut) {
				truncated = true;
				res.destroy();
			}
			resolve();
		};
		res.on('data', (chunk: Buffer) => {
			try {
				reader.write(chunk);
			} catch (err) {
				clearTimeout(timer);
				res.destroy();
				reject(err);
				return;
			}
			if (reader.done) stop(false);
			else if (reader.bytes > opts.maxBytes || entries > opts.maxEntries) stop(true);
		});
		res.on('end', () => stop(false));
		res.on('error', (err) => (truncated ? resolve() : reject(err)));
		res.on('close', () => stop(false));
	});
	const found: ListedDatabase[] = [];
	for (const [path, head] of heads) {
		if (!isSqliteHeader(head)) continue;
		found.push({ path, size: files.get(path)?.size ?? 0, wal: headerSaysWal(head) || files.has(`${path}-wal`) });
	}
	return { found, truncated };
}

/** Streams one file out of a container into `dest`, refusing files over `maxBytes`. */
export async function fetchFile(endpoint: string, containerId: string, path: string, dest: string, maxBytes: number): Promise<{ size: number; mtime: number }> {
	const res = await dockerRequest(endpoint, 'GET', archivePath(containerId, path), 120_000);
	if ((res.statusCode ?? 500) >= 400) throw await apiError(res, `copy ${path}`);
	const out = createWriteStream(dest, { mode: 0o600 });
	const state: { meta: { size: number; mtime: number } | null; failure: Error | null; wrote: number } = { meta: null, failure: null, wrote: 0 };
	const reader = tarReader((entry) => {
		if (state.meta || entry.type !== 'file') return null;
		if (entry.size > maxBytes) {
			state.failure = new Error(`${path} is ${Math.round(entry.size / 1048576)} MB, over the ${Math.round(maxBytes / 1048576)} MB snapshot limit (Integrations → SQLite in containers).`);
			return null;
		}
		state.meta = { size: entry.size, mtime: entry.mtime };
		return {
			data(chunk) {
				state.wrote += chunk.length;
				if (!out.write(chunk)) {
					res.pause();
					out.once('drain', () => res.resume());
				}
			},
			end() {}
		};
	});
	await new Promise<void>((resolve, reject) => {
		res.on('data', (chunk: Buffer) => {
			try {
				reader.write(chunk);
			} catch (err) {
				state.failure = err as Error;
			}
			if (state.failure) res.destroy();
		});
		res.on('end', resolve);
		res.on('close', resolve);
		res.on('error', (err) => (state.failure ? resolve() : reject(err)));
	});
	await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
	if (state.failure) throw state.failure;
	if (!state.meta) throw new Error(`${path} isn't a regular file in the container.`);
	if (state.wrote !== state.meta.size) throw new Error(`Copy of ${path} was cut short (${state.wrote} of ${state.meta.size} bytes).`);
	return state.meta;
}

// --- discovery ----------------------------------------------------------------------

export interface ContainerMount {
	Type: string;
	Source: string;
	Destination: string;
	RW?: boolean;
	Name?: string;
}

/**
 * SQLite databases inside one container's mounts, through the archive API: known app
 * paths first (HEAD each), then a capped listing of each mount that isn't bulk media.
 */
export async function discoverArchive(
	endpoint: string,
	container: { id: string; name: string; label: string; state: string; mounts: ContainerMount[] },
	skipDestinations: Set<string> = new Set()
): Promise<{ candidates: Candidate[]; notes: string[] }> {
	const notes: string[] = [];
	const mounts = container.mounts.filter((m) => !isBulkMount(m.Destination) && !skipDestinations.has(m.Destination) && m.Type !== 'tmpfs');
	const found = new Map<string, ListedDatabase>();
	const under = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith('/') ? dir : `${dir}/`);

	for (const known of KNOWN_CONTAINER_PATHS) {
		if (!mounts.some((m) => under(known, m.Destination))) continue;
		try {
			const st = await statFollow(endpoint, container.id, known);
			if (st && !isDirMode(st.stat.mode)) {
				const wal = !!(await statPath(endpoint, container.id, `${known}-wal`).catch(() => null));
				found.set(known, { path: known, size: st.stat.size, wal });
			}
		} catch (err) {
			notes.push((err as Error).message);
			break;
		}
	}
	for (const m of mounts) {
		// A mount whose known database was already found is listed anyway (others may sit next to it), but cheaply.
		try {
			const { found: listed, truncated } = await listDatabases(endpoint, container.id, m.Destination, {
				maxBytes: 64 * 1024 * 1024,
				maxEntries: 5000,
				timeoutMs: 15_000,
				maxDepth: 5
			});
			for (const db of listed) if (!found.has(db.path)) found.set(db.path, db);
			if (truncated) notes.push(`Stopped listing ${m.Destination} after 64 MB / 5000 entries; databases deeper in it may be missing.`);
		} catch (err) {
			notes.push(`${m.Destination}: ${(err as Error).message}`);
		}
	}
	const max = snapshotMaxBytes();
	const candidates = [...found.values()].map((db) =>
		sqliteCandidate({
			database: db.path,
			context: container.label,
			source: { kind: 'docker', ref: `${endpoint}#${container.name}` },
			info: { via: 'archive', sizeBytes: db.size, wal: db.wal, endpoint, container: container.name, containerId: container.id, containerPath: db.path },
			notes: [
				'Copied out of the container as a read-only snapshot (Docker archive API).',
				...(db.size > max ? [`${Math.round(db.size / 1048576)} MB — over the ${Math.round(max / 1048576)} MB snapshot limit; raise it in Integrations to import.`] : []),
				...(container.state !== 'running' ? [`Container is ${container.state}.`] : [])
			]
		})
	);
	return { candidates, notes };
}

// --- snapshots ----------------------------------------------------------------------

const inFlight = new Map<string, Promise<SqliteSnapshot>>();

/** Copies (or re-copies) a snapshot connection's database out of its container. */
export function refreshSnapshot(id: string): Promise<SqliteSnapshot> {
	const existing = inFlight.get(id);
	if (existing) return existing;
	const p = takeSnapshot(id).finally(() => inFlight.delete(id));
	inFlight.set(id, p);
	return p;
}

async function takeSnapshot(id: string): Promise<SqliteSnapshot> {
	const conn = getConnection(id);
	const snap = getSqliteSnapshot(id);
	if (!conn || !snap) throw new NotFound('Snapshot connection not found');
	if (!archiveEnabled()) {
		throw new Error('Reading SQLite files from containers is turned off. An admin can enable it in Integrations → SQLite in containers.');
	}
	const tmp = join(snapshotDir(), `${id}.tmp-${randomUUID().slice(0, 8)}`);
	try {
		// The container may have been recreated since; its name is the stable handle.
		const info = await dockerJson<{ Id: string }>(snap.endpoint, `/containers/${encodeURIComponent(snap.container)}/json`).catch(() => ({ Id: snap.containerId }));
		const containerId = info.Id;
		const max = snapshotMaxBytes();
		await mkdir(tmp, { recursive: true, mode: 0o700 });
		const dbFile = join(tmp, 'db.sqlite');
		let copied: { size: number; wal: boolean } | null = null;
		// A copy of a live database: if the file changed while it was copied, copy again.
		for (let attempt = 0; attempt < 3 && !copied; attempt++) {
			const target = await statFollow(snap.endpoint, containerId, snap.containerPath);
			if (!target || isDirMode(target.stat.mode)) throw new Error(`${snap.containerPath} no longer exists in ${snap.container}.`);
			const walStat = await statPath(snap.endpoint, containerId, `${target.path}-wal`);
			const journalStat = await statPath(snap.endpoint, containerId, `${target.path}-journal`);
			const total = target.stat.size + (walStat?.size ?? 0) + (journalStat?.size ?? 0);
			if (total > max) {
				throw new Error(`${walStat ? 'The database and its -wal are' : 'The database is'} ${Math.round(total / 1048576)} MB, over the ${Math.round(max / 1048576)} MB snapshot limit (Integrations → SQLite in containers).`);
			}
			await rm(`${dbFile}-wal`, { force: true });
			await rm(`${dbFile}-journal`, { force: true });
			const { size } = await fetchFile(snap.endpoint, containerId, target.path, dbFile, max);
			if (walStat) await fetchFile(snap.endpoint, containerId, `${target.path}-wal`, `${dbFile}-wal`, max);
			// A hot rollback journal means a write was interrupted; SQLite rolls it back on open.
			if (journalStat && journalStat.size > 0) await fetchFile(snap.endpoint, containerId, `${target.path}-journal`, `${dbFile}-journal`, max);
			const after = await statPath(snap.endpoint, containerId, target.path);
			if (after && after.mtime === target.stat.mtime && after.size === target.stat.size) copied = { size, wal: !!walStat };
		}
		if (!copied) throw new Error('The database kept changing while it was copied; try again in a moment.');
		// Fold the -wal into the copy and make it a plain rollback-journal file, so it can
		// be opened read-only (and immutable) without any sidecar files.
		await finalizeSnapshotFile(dbFile);
		const dir = join(snapshotDir(), id);
		closePool(id);
		await rm(dir, { recursive: true, force: true });
		await rename(tmp, dir);
		const final = join(dir, 'db.sqlite');
		const finalBytes = (await stat(final).catch(() => null))?.size ?? copied.size;
		setConnectionDatabase(id, final);
		const next: SqliteSnapshot = { ...snap, containerId, takenAt: new Date().toISOString(), bytes: finalBytes, wal: copied.wal, error: null };
		setSqliteSnapshot(id, next);
		closePool(id);
		return next;
	} catch (err) {
		await rm(tmp, { recursive: true, force: true }).catch(() => {});
		setSqliteSnapshot(id, { ...snap, error: (err as Error).message });
		throw err;
	}
}

/** Removes a deleted connection's snapshot files. */
export async function removeSnapshotFiles(id: string) {
	if (!/^[\w-]+$/.test(id)) return;
	await rm(join(snapshotDir(), id), { recursive: true, force: true }).catch(() => {});
}
