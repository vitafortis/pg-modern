/**
 * SQLite connections: a connection is a database file. Every query runs on a worker
 * thread (see worker.ts) so node:sqlite's synchronous calls never block the app, and
 * cancelling or timing out terminates that worker.
 *
 * Read-only access is layered: SQLITE_OPEN_READONLY plus a `mode=ro` URI,
 * `PRAGMA query_only`, a transaction that is rolled back, and the statement allowlist
 * in classify.ts. Snapshots copied out of containers are always read-only (and opened
 * `immutable`, which is only safe because nothing else writes to the copy).
 */
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { accessSync, constants, existsSync, openSync, readSync, closeSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config.ts';
import { getConnection, touchConnection } from '../store.ts';
import { NotFound } from '../pg.ts';
import { splitRanges } from '#lib/sql-split.ts';
import { WORKER_SOURCE } from './worker.ts';
import { firstKeyword, readOnlyProblem, sqliteExplainProblem } from './classify.ts';
import type { Connection, QueryError, QueryField, QueryResult } from '#lib/types.ts';

/** How long a statement waits for another process's write lock before SQLITE_BUSY. */
export const BUSY_TIMEOUT_MS = Number(process.env.PGM_SQLITE_BUSY_TIMEOUT_MS ?? 5_000);

export function splitSqlite(sql: string): string[] {
	return splitRanges(sql, 'sqlite').map((r) => r.text);
}

// --- errors --------------------------------------------------------------------

/** An error from SQLite (carried over from a worker), a timeout, or a cancel. */
export class SqliteError extends Error {
	code: string;
	errcode: number | null;
	hint: string | undefined;
	constructor(message: string, code: string, errcode: number | null = null, hint?: string) {
		super(message);
		this.code = code;
		this.errcode = errcode;
		this.hint = hint;
	}
}

export function isSqliteError(err: unknown): err is SqliteError {
	return err instanceof SqliteError;
}

const PRIMARY: Record<number, string> = {
	1: 'SQLITE_ERROR', 2: 'SQLITE_INTERNAL', 3: 'SQLITE_PERM', 4: 'SQLITE_ABORT', 5: 'SQLITE_BUSY', 6: 'SQLITE_LOCKED', 7: 'SQLITE_NOMEM',
	8: 'SQLITE_READONLY', 9: 'SQLITE_INTERRUPT', 10: 'SQLITE_IOERR', 11: 'SQLITE_CORRUPT', 13: 'SQLITE_FULL', 14: 'SQLITE_CANTOPEN',
	15: 'SQLITE_PROTOCOL', 17: 'SQLITE_SCHEMA', 18: 'SQLITE_TOOBIG', 19: 'SQLITE_CONSTRAINT', 20: 'SQLITE_MISMATCH', 21: 'SQLITE_MISUSE',
	23: 'SQLITE_AUTH', 25: 'SQLITE_RANGE', 26: 'SQLITE_NOTADB'
};
const EXTENDED: Record<number, string> = {
	264: 'SQLITE_READONLY_RECOVERY', 520: 'SQLITE_READONLY_CANTLOCK', 776: 'SQLITE_READONLY_ROLLBACK', 1032: 'SQLITE_READONLY_DBMOVED',
	1288: 'SQLITE_READONLY_CANTINIT', 1544: 'SQLITE_READONLY_DIRECTORY', 261: 'SQLITE_BUSY_RECOVERY', 517: 'SQLITE_BUSY_SNAPSHOT',
	773: 'SQLITE_BUSY_TIMEOUT', 270: 'SQLITE_CANTOPEN_NOTEMPDIR', 526: 'SQLITE_CANTOPEN_ISDIR', 782: 'SQLITE_CANTOPEN_FULLPATH'
};

export function sqliteCodeName(errcode: number | null | undefined): string | undefined {
	if (errcode == null) return undefined;
	return EXTENDED[errcode] ?? PRIMARY[errcode & 0xff];
}

/** What's on disk next to a database file, to explain open failures. */
export interface FileDiagnosis {
	exists: boolean;
	readable: boolean;
	/** The header says WAL (file format versions 2). */
	walHeader: boolean;
	wal: boolean;
	shm: boolean;
	shmReadable: boolean;
	dirWritable: boolean;
}

function canAccess(path: string, mode: number): boolean {
	try {
		accessSync(path, mode);
		return true;
	} catch {
		return false;
	}
}

export function diagnoseFile(path: string): FileDiagnosis {
	const exists = existsSync(path);
	let walHeader = false;
	if (exists) {
		try {
			const fd = openSync(path, 'r');
			const buf = Buffer.alloc(20);
			readSync(fd, buf, 0, 20, 0);
			closeSync(fd);
			walHeader = buf[18] === 2 || buf[19] === 2;
		} catch {}
	}
	return {
		exists,
		readable: exists && canAccess(path, constants.R_OK),
		walHeader,
		wal: existsSync(`${path}-wal`),
		shm: existsSync(`${path}-shm`),
		shmReadable: canAccess(`${path}-shm`, constants.R_OK),
		dirWritable: canAccess(dirname(path), constants.W_OK)
	};
}

/** A fix the user can apply, from the error and what's on disk. Pure, for tests. */
export function openHint(code: string | undefined, d: FileDiagnosis | null): string | undefined {
	if (d && !d.exists) return 'The file doesn’t exist at this path inside pg·modern’s container. Mount the folder that holds it (read-only is fine for most databases) and use the path as pg·modern sees it.';
	if (d && !d.readable) return 'pg·modern can’t read this file. The container runs as the `node` user (uid 1000): make the file readable for it, or run pg·modern with a user/group that can read it.';
	const walProblem =
		d && (d.walHeader || d.wal) && (!d.shm || !d.shmReadable) && !d.dirWritable
			? 'This database uses WAL mode. Reading a WAL database needs its -shm and -wal files to exist and be readable, or write access to the folder so SQLite can create them. While the app that owns it is running, the -shm file is normally there; otherwise mount the folder read-write for pg·modern (it still opens the database read-only), or take a snapshot instead.'
			: undefined;
	switch (code) {
		case 'SQLITE_READONLY_DIRECTORY':
		case 'SQLITE_READONLY_CANTINIT':
		case 'SQLITE_READONLY_RECOVERY':
		case 'SQLITE_CANTOPEN':
			return walProblem ?? (code === 'SQLITE_CANTOPEN' ? 'SQLite couldn’t open the file. Check the path and that pg·modern can read the file and its folder.' : 'SQLite needs to create or update the -shm file next to this WAL database, but the folder is read-only for pg·modern. Mount it read-write, or open it while the owning app is running.');
		case 'SQLITE_READONLY':
		case 'SQLITE_READONLY_ROLLBACK':
			return walProblem ?? 'The database (or its folder) is read-only for pg·modern, or this connection is read-only. Writes need write access to the file, its -wal/-shm files and the folder.';
		case 'SQLITE_BUSY':
		case 'SQLITE_BUSY_TIMEOUT':
		case 'SQLITE_LOCKED':
			return `Another process holds a lock on the database and didn’t release it within ${Math.round(BUSY_TIMEOUT_MS / 1000)} s. Try again, or stop the app that owns it for heavy writes.`;
		case 'SQLITE_NOTADB':
			return 'This file isn’t a SQLite database (or it’s encrypted, e.g. SQLCipher).';
		case 'SQLITE_CORRUPT':
			return 'SQLite reports the file as malformed. If this is a snapshot of a live database, refresh it; otherwise run PRAGMA integrity_check.';
		default:
			return walProblem;
	}
}

export function toSqliteError(err: unknown, path?: string): QueryError {
	const e = err as SqliteError;
	const name = e.code && e.code.startsWith('SQLITE') ? e.code : sqliteCodeName(e.errcode);
	const needsDisk = !!path && /CANTOPEN|READONLY|NOTADB/.test(name ?? '');
	return {
		message: e.message || String(err),
		code: name ?? e.code,
		hint: e.hint ?? openHint(name, needsDisk ? diagnoseFile(path!) : null)
	};
}

// --- workers -------------------------------------------------------------------

interface WorkerError {
	message: string;
	code?: string;
	errcode?: number;
	errstr?: string;
}

/**
 * One open database handle in a worker: a thread for introspection (cheap), or a child
 * process for user queries, because SQLite can't be interrupted from outside here and
 * only killing a process stops a statement in the middle of a long step.
 */
class Lane {
	send: (m: Record<string, unknown>) => void;
	stop: () => void;
	pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
	seq = 0;
	dead = false;
	key: string;
	version: string;
	idleTimer: NodeJS.Timeout | null = null;
	/** Why it was stopped, for the error the waiting call sees. */
	killReason: SqliteError | null = null;

	constructor(key: string, version: string, location: string, readOnly: boolean, mode: 'thread' | 'process' = 'thread') {
		this.key = key;
		this.version = version;
		const data = { location, readOnly, busyTimeoutMs: BUSY_TIMEOUT_MS };
		const onMessage = (m: { id: number; ok: boolean; result?: unknown; error?: WorkerError }) => {
			const p = this.pending.get(m.id);
			if (!p) return;
			this.pending.delete(m.id);
			if (m.ok) p.resolve(m.result);
			else {
				const e = m.error!;
				const code = sqliteCodeName(e.errcode) ?? e.code ?? 'SQLITE_ERROR';
				p.reject(new SqliteError(e.message, code, e.errcode ?? null));
			}
		};
		const fail = (err: unknown) => {
			this.dead = true;
			const reason = this.killReason ?? new SqliteError(err instanceof Error ? err.message : 'The SQLite worker stopped', 'WORKER_EXIT');
			for (const p of this.pending.values()) p.reject(reason);
			this.pending.clear();
		};
		if (mode === 'process') {
			const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--max-old-space-size=512', '-e', WORKER_SOURCE], {
				stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
				serialization: 'advanced',
				env: { ...process.env, PGM_SQLITE_WORKER: JSON.stringify(data), NODE_OPTIONS: '' }
			});
			child.unref();
			child.channel?.unref();
			child.on('message', onMessage);
			child.on('error', fail);
			child.on('exit', () => fail(null));
			this.send = (m) => {
				child.channel?.ref();
				child.send(m);
			};
			this.stop = () => void child.kill('SIGKILL');
			// Only keep the event loop alive while a call is waiting.
			child.on('message', () => this.pending.size === 0 && child.channel?.unref());
		} else {
			const worker = new Worker(WORKER_SOURCE, {
				eval: true,
				workerData: data,
				resourceLimits: { maxOldGenerationSizeMb: 512 },
				execArgv: ['--disable-warning=ExperimentalWarning']
			});
			worker.on('message', onMessage);
			worker.on('error', fail);
			worker.on('exit', () => fail(null));
			// Listeners re-ref the worker, so unref after adding them, and only hold the
			// event loop while a call is waiting.
			worker.on('message', () => this.pending.size === 0 && worker.unref());
			worker.unref();
			this.send = (m) => {
				worker.ref();
				worker.postMessage(m);
			};
			this.stop = () => void worker.terminate().catch(() => {});
		}
	}

	call<T>(msg: Record<string, unknown>, timeoutMs = config.statementTimeoutMs): Promise<T> {
		if (this.dead) return Promise.reject(this.killReason ?? new SqliteError('The SQLite worker stopped', 'WORKER_EXIT'));
		const id = ++this.seq;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.kill(new SqliteError(`Statement timed out after ${Math.round(timeoutMs / 1000)} s and was stopped.`, 'TIMEOUT'));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => (clearTimeout(timer), resolve(v as T)),
				reject: (e) => (clearTimeout(timer), reject(e))
			});
			this.send({ ...msg, id });
		});
	}

	/** Stops the worker; its handle (and any lock it held) goes with it. */
	kill(reason: SqliteError) {
		if (this.dead) return;
		this.killReason = reason;
		this.dead = true;
		for (const p of this.pending.values()) p.reject(reason);
		this.pending.clear();
		this.stop();
	}
}

/** URI for sqlite3_open_v2: read-only opens add `mode=ro`; snapshots are immutable copies. */
export function locationFor(path: string, opts: { readOnly: boolean; immutable?: boolean }): string {
	const href = pathToFileURL(path).href;
	if (opts.immutable) return `${href}?mode=ro&immutable=1`;
	return `${href}?mode=${opts.readOnly ? 'ro' : 'rw'}`;
}

const metaLanes = new Map<string, Lane>();
const idleRunLanes = new Map<string, Lane[]>();
const busyRunLanes = new Set<Lane>();
const running = new Map<string, { id: string; lane: Lane }>();
const META_IDLE_MS = 5 * 60_000;
const RUN_IDLE_MS = 60_000;

/**
 * pg·modern's own store (users, sessions, encrypted secrets) and snapshots live in the
 * data dir; a connection must never point there (symlinks resolved).
 */
export function insideDataDir(path: string): boolean {
	let real = resolve(path);
	try {
		real = realpathSync(real);
	} catch {}
	let dataDir = config.dataDir;
	try {
		dataDir = realpathSync(dataDir);
	} catch {}
	return real === dataDir || real.startsWith(`${dataDir}/`);
}

const DATA_DIR_MESSAGE = 'Files in pg·modern’s own data folder can’t be opened as connections.';

function connFor(id: string): Connection {
	const conn = getConnection(id);
	if (!conn) throw new NotFound('Connection not found');
	if (conn.engine !== 'sqlite') throw new Error('Not a SQLite connection');
	if (!conn.snapshot && insideDataDir(conn.database)) throw new SqliteError(DATA_DIR_MESSAGE, 'FORBIDDEN');
	if (conn.snapshot && !conn.snapshot.takenAt) throw new SqliteError(conn.snapshot.error ?? 'No snapshot has been taken yet — refresh the snapshot.', 'NO_SNAPSHOT');
	return conn;
}

function newLane(conn: Connection, key: string, readOnly: boolean, mode: 'thread' | 'process'): Lane {
	const ro = readOnly || !!conn.snapshot;
	return new Lane(key, laneVersion(conn), locationFor(conn.database, { readOnly: ro, immutable: !!conn.snapshot }), ro, mode);
}

function laneVersion(conn: Connection) {
	return conn.updatedAt + (conn.snapshot?.takenAt ?? '');
}

/** The long-lived read-only lane for introspection. */
function metaLane(conn: Connection): Lane {
	let lane = metaLanes.get(conn.id);
	if (lane && (lane.dead || lane.version !== laneVersion(conn))) {
		lane.kill(new SqliteError('Connection changed', 'CLOSED'));
		lane = undefined;
	}
	if (!lane) {
		lane = newLane(conn, `${conn.id}:meta`, true, 'thread');
		metaLanes.set(conn.id, lane);
	}
	const l = lane;
	if (l.idleTimer) clearTimeout(l.idleTimer);
	l.idleTimer = setTimeout(() => {
		if (metaLanes.get(conn.id) === l) metaLanes.delete(conn.id);
		l.kill(new SqliteError('Idle', 'CLOSED'));
	}, META_IDLE_MS);
	l.idleTimer.unref();
	return l;
}

function acquireRun(conn: Connection, readOnly: boolean): Lane {
	const key = `${conn.id}:${readOnly ? 'ro' : 'rw'}`;
	const idle = idleRunLanes.get(key) ?? [];
	let lane: Lane | undefined;
	while ((lane = idle.pop())) {
		if (lane.idleTimer) clearTimeout(lane.idleTimer);
		if (!lane.dead && lane.version === laneVersion(conn)) break;
		lane.kill(new SqliteError('Connection changed', 'CLOSED'));
	}
	lane ??= newLane(conn, key, readOnly, 'process');
	busyRunLanes.add(lane);
	return lane;
}

function releaseRun(lane: Lane) {
	busyRunLanes.delete(lane);
	if (lane.dead) return;
	const idle = idleRunLanes.get(lane.key) ?? [];
	if (idle.length >= 2) return lane.kill(new SqliteError('Pool full', 'CLOSED'));
	idle.push(lane);
	idleRunLanes.set(lane.key, idle);
	lane.idleTimer = setTimeout(() => {
		const list = idleRunLanes.get(lane.key);
		if (list) idleRunLanes.set(lane.key, list.filter((l) => l !== lane));
		lane.kill(new SqliteError('Idle', 'CLOSED'));
	}, RUN_IDLE_MS);
	lane.idleTimer.unref();
}

/** Closes every handle on a connection (edits, deletes, relocking, refreshed snapshots). */
export function closePool(id: string) {
	const closed = new SqliteError('The connection was closed.', 'CLOSED');
	const meta = metaLanes.get(id);
	if (meta) {
		metaLanes.delete(id);
		meta.kill(closed);
	}
	for (const key of [`${id}:ro`, `${id}:rw`]) {
		for (const lane of idleRunLanes.get(key) ?? []) lane.kill(closed);
		idleRunLanes.delete(key);
	}
	for (const lane of busyRunLanes) if (lane.key.startsWith(`${id}:`) && lane.key.endsWith(':rw')) lane.kill(closed);
}

// --- reads for introspection ---------------------------------------------------

type Row = Record<string, unknown>;

/** Runs several reads on the connection's read-only lane in one round trip. */
export async function readMany(id: string, queries: { sql: string; params?: unknown[] }[], opts: { soft?: boolean } = {}): Promise<(Row[] | { error: string })[]> {
	const conn = connFor(id);
	try {
		const out = await metaLane(conn).call<(Row[] | { error: string })[]>({ op: 'all', queries, soft: !!opts.soft });
		touchConnection(id);
		return out;
	} catch (err) {
		if (err instanceof SqliteError) err.hint ??= toSqliteError(err, conn.database).hint;
		throw err;
	}
}

export async function readQuery<T = Row>(id: string, sql: string, params: unknown[] = []): Promise<T[]> {
	const [rows] = await readMany(id, [{ sql, params }]);
	return rows as T[];
}

/** Like readQuery, but returns [] when the query fails (missing optional tables/modules). */
export async function softQuery<T = Row>(id: string, sql: string, params: unknown[] = []): Promise<T[]> {
	const [rows] = await readMany(id, [{ sql, params }], { soft: true });
	return Array.isArray(rows) ? (rows as T[]) : [];
}

/** One statement on the read-only lane, capped, as arrays (for table browsing). */
export async function readArrays(id: string, sql: string, params: unknown[], maxRows: number): Promise<RunResult> {
	return metaLane(connFor(id)).call<RunResult>({ op: 'run', sql, params, maxRows });
}

// --- testing -------------------------------------------------------------------

/** Opens the file read-only and reads its header and version, without saving anything. */
export async function testSqlite(path: string): Promise<{ version: string }> {
	if (!path.startsWith('/')) throw new SqliteError('Use an absolute path to the database file.', 'BAD_PATH');
	if (insideDataDir(path)) throw new SqliteError(DATA_DIR_MESSAGE, 'FORBIDDEN');
	let st;
	try {
		st = statSync(path);
	} catch {
		throw new SqliteError(`No file at ${path}`, 'SQLITE_CANTOPEN', 14, openHint('SQLITE_CANTOPEN', diagnoseFile(path)));
	}
	if (st.isDirectory()) throw new SqliteError(`${path} is a folder, not a database file.`, 'SQLITE_CANTOPEN', 14);
	const lane = new Lane('test', '', locationFor(path, { readOnly: true }), true);
	try {
		const [[info]] = (await lane.call<Row[][]>({ op: 'all', queries: [{ sql: 'SELECT sqlite_version() AS v, (SELECT count(*) FROM sqlite_schema) AS n' }] }, 10_000)) as Row[][];
		return { version: `SQLite ${info.v}` };
	} catch (err) {
		if (err instanceof SqliteError) err.hint ??= toSqliteError(err, path).hint;
		throw err;
	} finally {
		lane.kill(new SqliteError('done', 'CLOSED'));
	}
}

/** Tests a saved connection on its own read-only lane (works for snapshots too). */
export async function testSaved(id: string): Promise<{ version: string }> {
	const [info] = await readQuery<{ v: string }>(id, 'SELECT sqlite_version() AS v, (SELECT count(*) FROM sqlite_schema) AS n');
	return { version: `SQLite ${info.v}` };
}

/**
 * Turns a freshly copied snapshot (db + -wal / -journal) into one self-contained file:
 * recovers the journal or WAL, checkpoints it, and switches the copy to rollback
 * journal mode so it opens read-only and immutable with no sidecar files.
 */
export async function finalizeSnapshotFile(path: string): Promise<void> {
	const lane = new Lane('snapshot', '', locationFor(path, { readOnly: false }), false, 'process');
	try {
		await lane.call({ op: 'exec', sql: 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;' }, 120_000);
		await lane.call({ op: 'all', queries: [{ sql: 'SELECT count(*) AS n FROM sqlite_schema' }] }, 60_000);
		await lane.call({ op: 'close' });
	} catch (err) {
		const e = toSqliteError(err);
		throw new Error(`The copied file isn’t a usable SQLite database: ${e.message}`);
	} finally {
		lane.kill(new SqliteError('done', 'CLOSED'));
	}
}

// --- running scripts -------------------------------------------------------------

interface RunResult {
	columns: { name: string; type: string }[];
	rows: unknown[][];
	truncated: boolean;
	changes: number | null;
}

export interface ScriptOutcome {
	results: (QueryResult & { sql: string })[];
	error?: QueryError & { statementIndex: number; sql: string };
}

/**
 * Executes a script statement by statement on one worker. Read-only: every statement
 * must pass the allowlist first, and the script runs in a transaction that is rolled
 * back. With write access, statements autocommit unless the script opens a
 * transaction, and an unfinished one is rolled back at the end.
 */
export async function runScript(id: string, script: string, opts: { runId?: string; maxRows?: number; readOnly: boolean }): Promise<ScriptOutcome> {
	const conn = connFor(id);
	const statements = splitSqlite(script);
	const maxRows = Math.min(opts.maxRows ?? config.maxRows, config.maxRows);
	const readOnly = opts.readOnly || !!conn.snapshot;

	if (readOnly) {
		for (let i = 0; i < statements.length; i++) {
			const problem = readOnlyProblem(statements[i]);
			if (problem) {
				return {
					results: [],
					error: {
						statementIndex: i,
						sql: statements[i],
						message: problem,
						hint: conn.snapshot
							? 'This is a snapshot copied out of a container, so it is always read-only.'
							: 'Read-only connections run reads only. Unlock writes, or switch the connection to read/write in its settings, if you need this.'
					}
				};
			}
		}
	}

	const outcome: ScriptOutcome = { results: [] };
	const lane = acquireRun(conn, readOnly);
	if (opts.runId) running.set(opts.runId, { id, lane });
	try {
		// One read transaction: every statement sees the same snapshot of the file.
		if (readOnly) await lane.call({ op: 'exec', sql: 'BEGIN', ignoreErrors: true });
		for (let i = 0; i < statements.length; i++) {
			const sql = statements[i];
			const started = performance.now();
			try {
				const r = await lane.call<RunResult>({ op: 'run', sql, maxRows });
				const fields: QueryField[] = r.columns.map((c) => ({ name: c.name, dataTypeID: 0, type: (c.type || '').toLowerCase() }));
				outcome.results.push({
					sql,
					command: (firstKeyword(sql) || 'statement').replace('(', 'select').toUpperCase(),
					rowCount: r.columns.length ? (r.truncated ? null : r.rows.length) : r.changes,
					fields,
					rows: r.rows,
					truncated: r.truncated,
					durationMs: Math.round((performance.now() - started) * 10) / 10,
					readOnly
				});
			} catch (err) {
				outcome.error = { ...toSqliteError(err, conn.database), statementIndex: i, sql };
				break;
			}
		}
		touchConnection(id);
	} finally {
		if (opts.runId) running.delete(opts.runId);
		if (!lane.dead) await lane.call({ op: 'exec', sql: 'ROLLBACK', ignoreErrors: true }).catch(() => {});
		releaseRun(lane);
	}
	return outcome;
}

/** Stops a running script by terminating its worker. */
export async function cancelRun(id: string, runId: string): Promise<boolean> {
	const run = running.get(runId);
	if (!run || run.id !== id) return false;
	run.lane.kill(new SqliteError('Cancelled.', 'CANCELLED'));
	return true;
}

// --- EXPLAIN QUERY PLAN ----------------------------------------------------------

export function explainProblem(sql: string, analyze: boolean): string | null {
	return sqliteExplainProblem(splitSqlite(sql), analyze);
}

/** Renders EXPLAIN QUERY PLAN rows as the sqlite3 shell does (a tree by parent id). */
export function planText(rows: { id: number; parent: number; detail: string }[]): string {
	const children = new Map<number, typeof rows>();
	for (const r of rows) children.set(r.parent, [...(children.get(r.parent) ?? []), r]);
	const lines = ['QUERY PLAN'];
	const walk = (parent: number, prefix: string) => {
		const list = children.get(parent) ?? [];
		list.forEach((r, i) => {
			const last = i === list.length - 1;
			lines.push(`${prefix}${last ? '`--' : '|--'}${r.detail}`);
			walk(r.id, prefix + (last ? '   ' : '|  '));
		});
	};
	walk(0, '');
	return lines.join('\n');
}

export async function explainSqlite(id: string, sql: string, opts: { analyze: boolean; readOnly: boolean; runId?: string }) {
	const problem = explainProblem(sql, opts.analyze);
	if (problem) throw new Error(problem);
	const conn = connFor(id);
	const statement = splitSqlite(sql)[0];
	const started = performance.now();
	// EXPLAIN never executes the statement, so it always runs on a read-only handle.
	const lane = acquireRun(conn, true);
	if (opts.runId) running.set(opts.runId, { id, lane });
	try {
		const r = await lane.call<RunResult>({ op: 'run', sql: `EXPLAIN QUERY PLAN ${statement}`, maxRows: 10_000 });
		const idx = (n: string) => r.columns.findIndex((c) => c.name === n);
		const rows = r.rows.map((row) => ({ id: Number(row[idx('id')]), parent: Number(row[idx('parent')]), detail: String(row[idx('detail')]) }));
		return {
			plan: planText(rows),
			format: 'text' as const,
			analyzed: false,
			readOnly: true,
			executedWrite: false as const,
			durationMs: Math.round((performance.now() - started) * 10) / 10
		};
	} finally {
		if (opts.runId) running.delete(opts.runId);
		releaseRun(lane);
	}
}

// --- write transactions (row editing / imports) ----------------------------------

/**
 * An interactive `BEGIN IMMEDIATE` transaction on a writable handle: `fn` runs statements one
 * at a time and decides whether to commit. Rolled back if `fn` throws. Snapshots refuse.
 */
export async function interactiveWrite<T extends { commit: boolean }>(
	id: string,
	fn: (run: (sql: string, params?: unknown[]) => Promise<{ rowCount: number; rows: unknown[][] }>) => Promise<T>
): Promise<T> {
	const conn = connFor(id);
	if (conn.snapshot) throw new SqliteError('This is a read-only snapshot copied out of a container.', 'READ_ONLY');
	const lane = acquireRun(conn, false);
	let open = false;
	try {
		await lane.call({ op: 'exec', sql: 'BEGIN IMMEDIATE' });
		open = true;
		const result = await fn(async (sql, params = []) => {
			const r = await lane.call<RunResult>({ op: 'run', sql, params, maxRows: 100_000 });
			return { rowCount: r.columns.length ? r.rows.length : (r.changes ?? 0), rows: r.rows };
		});
		await lane.call({ op: 'exec', sql: result.commit ? 'COMMIT' : 'ROLLBACK' });
		open = false;
		if (result.commit) touchConnection(id);
		return result;
	} catch (err) {
		if (err instanceof SqliteError) err.hint ??= toSqliteError(err, conn.database).hint;
		throw err;
	} finally {
		if (open && !lane.dead) await lane.call({ op: 'exec', sql: 'ROLLBACK', ignoreErrors: true }).catch(() => {});
		releaseRun(lane);
	}
}

/**
 * Runs parameterised statements in one `BEGIN IMMEDIATE … COMMIT` on a writable handle,
 * rolling back on the first error. Callers check write access first; snapshots refuse.
 * Returns each statement's changed-row count.
 */
export async function writeTransaction(id: string, statements: { sql: string; params?: unknown[] }[]): Promise<{ changes: number[] }> {
	const conn = connFor(id);
	if (conn.snapshot) throw new SqliteError('This is a read-only snapshot copied out of a container.', 'READ_ONLY');
	const lane = acquireRun(conn, false);
	try {
		await lane.call({ op: 'exec', sql: 'BEGIN IMMEDIATE' });
		const changes: number[] = [];
		for (const s of statements) {
			const r = await lane.call<RunResult>({ op: 'run', sql: s.sql, params: s.params ?? [], maxRows: 1 });
			changes.push(r.changes ?? r.rows.length);
		}
		await lane.call({ op: 'exec', sql: 'COMMIT' });
		touchConnection(id);
		return { changes };
	} catch (err) {
		if (err instanceof SqliteError) err.hint ??= toSqliteError(err, conn.database).hint;
		throw err;
	} finally {
		if (!lane.dead) await lane.call({ op: 'exec', sql: 'ROLLBACK', ignoreErrors: true }).catch(() => {});
		releaseRun(lane);
	}
}
