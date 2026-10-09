/**
 * MySQL / MariaDB connections: pools per connection and mode, the read-only layers,
 * capped result streaming, cancellation and error mapping. Mirrors pg.ts.
 */
import mysql from 'mysql2/promise';
import type { FieldPacket, Pool, PoolConnection, PoolOptions, ResultSetHeader } from 'mysql2/promise';
import type { Connection as CallbackConnection, TypeCastField } from 'mysql2';
import { config } from '../config.ts';
import { getConnection, getPassword, setFlavor, touchConnection } from '../store.ts';
import { NotFound } from '../pg.ts';
import { splitRanges } from '#lib/sql-split.ts';
import { flavorFromVersion, quoteIdentFor } from '#lib/engine.ts';
import { changesSession, firstKeyword, readOnlyProblem, useTarget } from './classify.ts';
import type { Connection, Flavor, QueryError, QueryField, QueryResult, SslMode } from '#lib/types.ts';

export const quoteIdent = (name: string) => quoteIdentFor('mysql', name);

export function splitMysql(sql: string): string[] {
	return splitRanges(sql, 'mysql').map((r) => r.text);
}

// --- values and types ----------------------------------------------------------

/** BIT as a number, MariaDB's JSON (a LONGTEXT alias flagged as json) parsed like MySQL's. */
function typeCast(field: TypeCastField, next: () => unknown): unknown {
	if (field.type === 'BIT') {
		const b = field.buffer();
		if (!b) return null;
		return b.length > 0 && b.length <= 6 ? b.readUIntBE(0, b.length) : `0x${b.toString('hex')}`;
	}
	if (field.extendedFormat === 'json') {
		const s = field.string();
		if (s == null) return null;
		try {
			return JSON.parse(s);
		} catch {
			return s;
		}
	}
	return next();
}

const TYPE_NAMES: Record<number, string> = {
	0: 'decimal', 1: 'tinyint', 2: 'smallint', 3: 'int', 4: 'float', 5: 'double', 6: 'null', 7: 'timestamp', 8: 'bigint',
	9: 'mediumint', 10: 'date', 11: 'time', 12: 'datetime', 13: 'year', 14: 'date', 15: 'varchar', 16: 'bit', 17: 'timestamp',
	18: 'datetime', 19: 'time', 242: 'vector', 245: 'json', 246: 'decimal', 247: 'enum', 248: 'set', 249: 'tinyblob',
	250: 'mediumblob', 251: 'longblob', 252: 'blob', 253: 'varchar', 254: 'char', 255: 'geometry'
};
const BINARY_CHARSET = 63;
const UNSIGNED_FLAG = 32;
const ENUM_FLAG = 256;
const SET_FLAG = 2048;

/** A readable type name for a result column (varchar, int unsigned, json, blob, …). */
export function fieldTypeName(f: FieldPacket): string {
	if (f.extendedFormat === 'json') return 'json';
	if (f.extendedTypeName) return f.extendedTypeName;
	const t = f.columnType ?? f.type ?? -1;
	const flags = typeof f.flags === 'number' ? f.flags : 0;
	const binary = f.characterSet === BINARY_CHARSET;
	let name = TYPE_NAMES[t] ?? `type ${t}`;
	if (t === 252 || t === 249 || t === 250 || t === 251) {
		const len = f.columnLength ?? 0;
		const size = len <= 255 ? 'tiny' : len <= 65535 ? '' : len <= 16777215 ? 'medium' : 'long';
		name = `${size}${binary ? 'blob' : 'text'}`;
	} else if (t === 253 || t === 15) name = binary ? 'varbinary' : 'varchar';
	else if (t === 254) name = flags & ENUM_FLAG ? 'enum' : flags & SET_FLAG ? 'set' : binary ? 'binary' : 'char';
	if (flags & UNSIGNED_FLAG && [1, 2, 3, 8, 9, 0, 246, 4, 5].includes(t)) name += ' unsigned';
	return name;
}

/** JSON-safe values: binary as hex, everything else as the driver returns it (text for decimals, bigints, dates). */
export function serializeValue(v: unknown): unknown {
	if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`;
	if (typeof v === 'bigint') return v.toString();
	if (v instanceof Date) return v.toISOString();
	if (Array.isArray(v)) return v.map(serializeValue);
	return v;
}

// --- pools ---------------------------------------------------------------------

export interface MysqlTarget {
	host: string;
	port: number;
	database: string;
	user: string;
	password?: string;
	sslMode: SslMode;
}

interface PoolEntry {
	pool: Pool;
	version: string;
	/** Server version string, e.g. `8.4.2` or `11.4.2-MariaDB-ubu2404`. */
	serverVersion: string;
	flavor: Flavor;
	readOnly: boolean;
	/** host:port, for labelling our own sessions. */
	address: string;
	/** Underlying sessions that already have their session settings. */
	ready: WeakSet<object>;
}

const pools = new Map<string, PoolEntry>();
/** Thread ids of pg·modern's own sessions per server address, so Activity can label them. */
const ownThreads = new Map<string, Set<number>>();

export function ownThreadIds(conn: Pick<Connection, 'host' | 'port'>): Set<number> {
	return ownThreads.get(`${conn.host.toLowerCase()}:${conn.port}`) ?? new Set();
}

function sslOption(mode: SslMode): PoolOptions['ssl'] {
	switch (mode) {
		case 'disable':
			return undefined;
		case 'verify-full':
			return { rejectUnauthorized: true };
		default:
			return { rejectUnauthorized: false };
	}
}

function baseOptions(t: MysqlTarget, ssl: PoolOptions['ssl']): PoolOptions {
	return {
		host: t.host,
		port: t.port,
		user: t.user,
		password: t.password,
		database: t.database || undefined,
		ssl,
		connectTimeout: 8_000,
		// One statement per call: nothing can ride along behind a read and COMMIT.
		multipleStatements: false,
		dateStrings: true,
		supportBigNumbers: true,
		bigNumberStrings: true,
		decimalNumbers: false,
		charset: 'utf8mb4',
		typeCast,
		connectAttributes: { program_name: 'pg-modern' }
	};
}

function isSslUnsupported(err: unknown) {
	return err instanceof Error && /does not support secure connection|SSL/i.test(err.message) && !/certificate/i.test(err.message);
}

async function openPool(t: MysqlTarget): Promise<{ pool: Pool; serverVersion: string }> {
	const make = (ssl: PoolOptions['ssl']) =>
		mysql.createPool({ ...baseOptions(t, ssl), connectionLimit: 4, maxIdle: 4, idleTimeout: 60_000, enableKeepAlive: true });
	let pool = make(sslOption(t.sslMode));
	let serverVersion: string;
	try {
		serverVersion = await probeVersion(pool);
	} catch (err) {
		await pool.end().catch(() => {});
		if (t.sslMode === 'prefer' && isSslUnsupported(err)) {
			pool = make(undefined);
			serverVersion = await probeVersion(pool);
		} else throw err;
	}
	// Idle sessions dropped by a server restart must not crash the app.
	pool.pool.on('connection', (c: CallbackConnection) => c.on('error', () => {}));
	return { pool, serverVersion };
}

async function probeVersion(pool: Pool): Promise<string> {
	const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT VERSION() AS v');
	return String(rows[0].v);
}

function targetFor(conn: Connection): MysqlTarget {
	return { ...conn, password: getPassword(conn.id) };
}

/**
 * Pools are per connection and effective mode. Read-only pools set the session
 * read-only on every new session; the writable pool is only used with write access.
 */
async function entryFor(id: string, readOnly: boolean): Promise<PoolEntry & { conn: Connection }> {
	const conn = getConnection(id);
	if (!conn) throw new NotFound('Connection not found');
	const key = `${id}:${readOnly ? 'ro' : 'rw'}`;
	const existing = pools.get(key);
	if (existing && existing.version === conn.updatedAt) return { ...existing, conn };
	if (existing) {
		pools.delete(key);
		existing.pool.end().catch(() => {});
	}
	const { pool, serverVersion } = await openPool(targetFor(conn));
	const entry: PoolEntry = {
		pool,
		version: conn.updatedAt,
		serverVersion,
		flavor: flavorFromVersion('mysql', serverVersion),
		readOnly,
		address: `${conn.host.toLowerCase()}:${conn.port}`,
		ready: new WeakSet()
	};
	pools.set(key, entry);
	touchConnection(id);
	if (conn.flavor !== entry.flavor) setFlavor(id, entry.flavor);
	return { ...entry, conn };
}

export function closePool(id: string) {
	for (const key of [`${id}:ro`, `${id}:rw`]) {
		const entry = pools.get(key);
		if (entry) {
			pools.delete(key);
			entry.pool.end().catch(() => {});
		}
	}
}

/** Puts a fresh session into the pool's mode once: read-only, and fresh information_schema statistics. */
async function initSession(c: PoolConnection, entry: PoolEntry) {
	if (entry.ready.has(c.connection)) return;
	if (entry.readOnly) {
		try {
			await c.query('SET SESSION transaction_read_only = ON');
		} catch {
			// MariaDB before 11.1 and MySQL 5.7 only know the older name.
			await c.query('SET SESSION tx_read_only = 1');
		}
	}
	// MySQL 8 caches table statistics for a day; row counts and sizes should be current.
	if (entry.flavor === 'mysql') await c.query('SET SESSION information_schema_stats_expiry = 0').catch(() => {});
	entry.ready.add(c.connection);
	const key = `${entry.address}`;
	if (!ownThreads.has(key)) ownThreads.set(key, new Set());
	const set = ownThreads.get(key)!;
	const thread = c.threadId;
	set.add(thread);
	c.connection.once('end', () => set.delete(thread));
}

function timeoutSql(entry: PoolEntry, ms: number): string[] {
	const lockSeconds = Math.max(1, Math.ceil(ms / 1000));
	return entry.flavor === 'mariadb'
		? [`SET SESSION max_statement_time = ${(ms / 1000).toFixed(3)}`, `SET SESSION lock_wait_timeout = ${lockSeconds}`]
		: [`SET SESSION max_execution_time = ${Math.floor(ms)}`, `SET SESSION lock_wait_timeout = ${lockSeconds}`];
}

export interface Lease {
	conn: PoolConnection;
	entry: PoolEntry & { conn: Connection };
	readOnly: boolean;
	/** Close the session instead of returning it to the pool. */
	discard: boolean;
	/** A USE changed the default database; it's reset before the session is reused. */
	switched: boolean;
	/** Already closed (e.g. a capped result stream was cut off). */
	closed: boolean;
}

async function acquire(id: string, readOnly: boolean, timeoutMs?: number): Promise<Lease> {
	const entry = await entryFor(id, readOnly);
	const conn = await entry.pool.getConnection();
	const lease: Lease = { conn, entry, readOnly, discard: false, switched: false, closed: false };
	try {
		await initSession(conn, entry);
		for (const s of timeoutSql(entry, timeoutMs ?? config.statementTimeoutMs)) await conn.query(s).catch(() => {});
		if (readOnly) await conn.query('START TRANSACTION READ ONLY');
	} catch (err) {
		lease.discard = true;
		await release(lease);
		throw err;
	}
	return lease;
}

async function release(lease: Lease) {
	if (lease.closed) return;
	lease.closed = true;
	try {
		// Read-only work is always rolled back; with write access this only undoes a
		// transaction the script opened and never committed.
		await lease.conn.query('ROLLBACK');
		if (lease.switched) {
			const db = lease.entry.conn.database;
			if (db) await lease.conn.query(`USE ${quoteIdent(db)}`);
			else lease.discard = true;
		}
	} catch {
		lease.discard = true;
	}
	if (lease.discard) lease.conn.destroy();
	else lease.conn.release();
}

function isServerError(err: unknown): boolean {
	return !!err && typeof err === 'object' && 'sqlState' in err && typeof (err as { errno?: unknown }).errno === 'number';
}

/**
 * Runs `fn` on a pooled session. Read-only: inside `START TRANSACTION READ ONLY` on a
 * read-only session, always rolled back.
 */
export async function withConnection<T>(
	id: string,
	opts: { readOnly: boolean; timeoutMs?: number },
	fn: (conn: PoolConnection, lease: Lease) => Promise<T>
): Promise<T> {
	const lease = await acquire(id, opts.readOnly, opts.timeoutMs);
	try {
		return await fn(lease.conn, lease);
	} catch (err) {
		if (!isServerError(err)) lease.discard = true;
		throw err;
	} finally {
		await release(lease);
	}
}

/** A read-only query returning plain object rows. */
export async function readQuery<T = Record<string, unknown>>(id: string, sql: string, values: unknown[] = [], timeoutMs?: number): Promise<T[]> {
	return withConnection(id, { readOnly: true, timeoutMs }, async (c) => {
		const [rows] = await c.query({ sql, values });
		return rows as T[];
	});
}

// --- errors --------------------------------------------------------------------

const NETWORK_HINTS: Record<string, string> = {
	ER_ACCESS_DENIED_ERROR: 'The server rejected this user and password from pg·modern’s address. MySQL accounts are per host (user@host) — check the account allows connections from here.',
	ER_DBACCESS_DENIED_ERROR: 'This user can’t open that database. Grant access to it, or pick a database the user can read.',
	ER_BAD_DB_ERROR: 'That database doesn’t exist on this server.',
	ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION: 'This connection is read-only. Unlock writes (or switch the connection to read/write) to change data.',
	ER_QUERY_TIMEOUT: 'The statement ran longer than the statement timeout.',
	ER_LOCK_WAIT_TIMEOUT: 'Another session holds a lock this statement needs. Check the Activity tab, or try again when it finishes.',
	ER_NOT_SUPPORTED_AUTH_MODE: 'The server uses an authentication plugin the driver can’t use.',
	HANDSHAKE_SSL_ERROR: 'The TLS handshake failed. Try SSL mode “Prefer” or “Disable”, or check the server’s certificate.'
};

interface MysqlError extends Error {
	code?: string;
	errno?: number;
	sqlState?: string;
	sqlMessage?: string;
}

export function isMysqlError(err: unknown): err is MysqlError {
	return !!err && typeof err === 'object' && 'sqlState' in err;
}

export function toMysqlError(err: unknown, networkHints: Record<string, string>): QueryError {
	const e = err as MysqlError;
	const code = e.code;
	return {
		message: e.sqlMessage || e.message || (code ? `Connection failed (${code})` : 'Connection failed'),
		code: code && e.errno ? `${code} (${e.errno})` : code,
		sqlState: e.sqlState,
		hint: (code && (NETWORK_HINTS[code] ?? networkHints[code])) || undefined
	};
}

// --- testing -------------------------------------------------------------------

export async function testMysql(t: MysqlTarget): Promise<{ version: string; flavor: Flavor }> {
	const connect = (ssl: PoolOptions['ssl']) => mysql.createConnection(baseOptions(t, ssl));
	let c: mysql.Connection;
	try {
		c = await connect(sslOption(t.sslMode));
	} catch (err) {
		if (t.sslMode === 'prefer' && isSslUnsupported(err)) c = await connect(undefined);
		else throw err;
	}
	try {
		const [rows] = await c.query<mysql.RowDataPacket[]>('SELECT VERSION() AS v, @@version_comment AS c');
		const version = String(rows[0].v);
		const comment = rows[0].c ? ` ${rows[0].c}` : '';
		return { version: `${version}${comment}`, flavor: flavorFromVersion('mysql', `${version}${comment}`) };
	} finally {
		c.end().catch(() => c.destroy());
	}
}

/** The server version and flavor, opening the read-only pool if needed. */
export async function serverInfo(id: string): Promise<{ serverVersion: string; flavor: Flavor }> {
	const entry = await entryFor(id, true);
	return { serverVersion: entry.serverVersion, flavor: entry.flavor };
}

// --- running scripts -------------------------------------------------------------

interface StreamOutcome {
	fields: FieldPacket[] | null;
	rows: unknown[][];
	truncated: boolean;
	header: ResultSetHeader | null;
}

/**
 * Streams one statement's result, keeping at most `maxRows` rows. Past the cap the
 * session stops reading and is closed (`cut`), so a huge result never gets pulled
 * over the wire.
 */
function streamStatement(lease: Lease, sql: string, maxRows: number): Promise<StreamOutcome> {
	return new Promise((resolve, reject) => {
		const raw = lease.conn.connection as unknown as CallbackConnection;
		let fields: FieldPacket[] | null = null;
		let resultSets = 0;
		const rows: unknown[][] = [];
		let header: ResultSetHeader | null = null;
		let settled = false;
		const query = raw.query({ sql, rowsAsArray: true });
		query.on('fields', (f: FieldPacket[]) => {
			resultSets++;
			if (resultSets === 1) fields = f;
		});
		query.on('result', (row: unknown) => {
			if (settled) return;
			if (!Array.isArray(row)) {
				if (!header) header = row as ResultSetHeader;
				return;
			}
			if (resultSets > 1) return; // CALL can return several result sets; show the first
			if (rows.length < maxRows) {
				rows.push(row);
				return;
			}
			settled = true;
			raw.pause();
			lease.discard = true;
			lease.closed = true;
			lease.conn.destroy();
			resolve({ fields, rows, truncated: true, header });
		});
		query.on('error', (err: Error) => {
			if (!settled) {
				settled = true;
				reject(err);
			}
		});
		query.on('end', () => {
			if (!settled) {
				settled = true;
				resolve({ fields, rows, truncated: false, header });
			}
		});
	});
}

async function runStatement(lease: Lease, sql: string, maxRows: number): Promise<QueryResult> {
	const started = performance.now();
	const out = await streamStatement(lease, sql, maxRows);
	const command = (firstKeyword(sql) || 'statement').replace('(', 'select').toUpperCase();
	const fields: QueryField[] = (out.fields ?? []).map((f) => ({ name: f.name, dataTypeID: f.columnType ?? f.type ?? 0, type: fieldTypeName(f) }));
	return {
		command,
		rowCount: out.fields ? (out.truncated ? null : out.rows.length) : (out.header?.affectedRows ?? null),
		fields,
		rows: out.rows.map((r) => r.map(serializeValue)),
		truncated: out.truncated,
		durationMs: Math.round((performance.now() - started) * 10) / 10,
		readOnly: lease.readOnly
	};
}

export interface ScriptOutcome {
	results: (QueryResult & { sql: string })[];
	error?: QueryError & { statementIndex: number; sql: string };
}

const running = new Map<string, { id: string; threadId: number }>();

/**
 * Executes a script statement by statement. Read-only: every statement must pass the
 * allowlist before anything is sent, and all of it runs in one READ ONLY transaction
 * that is rolled back (a fresh one if a capped result closed the session).
 */
export async function runScript(
	id: string,
	script: string,
	opts: { runId?: string; maxRows?: number; readOnly: boolean },
	networkHints: Record<string, string>
): Promise<ScriptOutcome> {
	const statements = splitMysql(script);
	const maxRows = Math.min(opts.maxRows ?? config.maxRows, config.maxRows);
	const conn = getConnection(id);
	if (!conn) throw new NotFound('Connection not found');
	const readOnly = opts.readOnly;

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
						hint: 'Read-only connections run reads only. Unlock writes, or switch the connection to read/write in its settings, if you need this.'
					}
				};
			}
		}
	}

	const outcome: ScriptOutcome = { results: [] };
	let lease: Lease | null = null;
	try {
		for (let i = 0; i < statements.length; i++) {
			const sql = statements[i];
			try {
				if (!lease || lease.closed) {
					lease = await acquire(id, readOnly);
					if (opts.runId) running.set(opts.runId, { id, threadId: lease.conn.threadId });
				}
				if (useTarget(sql) !== null) lease.switched = true;
				if (!readOnly && changesSession(sql)) lease.discard = true;
				const result = await runStatement(lease, sql, maxRows);
				outcome.results.push({ ...result, sql });
			} catch (err) {
				if (lease && !isServerError(err)) lease.discard = true;
				outcome.error = { ...toMysqlError(err, networkHints), statementIndex: i, sql };
				break;
			}
		}
	} finally {
		if (opts.runId) running.delete(opts.runId);
		if (lease) await release(lease);
	}
	return outcome;
}

/** Interrupts a running script with KILL QUERY from another session. */
export async function cancelRun(id: string, runId: string): Promise<boolean> {
	const run = running.get(runId);
	if (!run || run.id !== id) return false;
	const entry = await entryFor(id, true);
	await entry.pool.query(`KILL QUERY ${Math.floor(run.threadId)}`);
	return true;
}

// --- EXPLAIN -------------------------------------------------------------------

export interface MysqlExplainOutcome {
	plan: string;
	format: 'text';
	analyzed: boolean;
	readOnly: boolean;
	executedWrite: false;
	durationMs: number;
}

/** Why a statement can't be explained here, if it can't. */
export function mysqlExplainProblem(sql: string, analyze: boolean, readOnly: boolean): string | null {
	const statements = splitMysql(sql);
	if (statements.length === 0) return 'Nothing to explain.';
	if (statements.length > 1) return 'Explain one statement at a time.';
	const s = statements[0];
	const first = firstKeyword(s);
	if (['explain', 'describe', 'desc', 'analyze'].includes(first)) return 'Leave out EXPLAIN — use Explain or Explain analyze instead.';
	const isRead = ['select', 'with', 'table', 'values', '('].includes(first) && readOnlyProblem(s) === null;
	if (analyze && !isRead) return 'Explain analyze runs the statement, so on MySQL/MariaDB it’s only available for reads.';
	if (!isRead && (readOnly || !['insert', 'update', 'delete', 'replace'].includes(first))) {
		return readOnly ? 'Only reads can be explained on a read-only connection.' : 'MySQL can explain SELECT, INSERT, UPDATE, DELETE and REPLACE statements.';
	}
	return null;
}

/** Renders a classic tabular EXPLAIN as aligned text. */
function textTable(rows: Record<string, unknown>[]): string {
	if (!rows.length) return '';
	const cols = Object.keys(rows[0]);
	const cells = rows.map((r) => cols.map((c) => (r[c] == null ? 'NULL' : String(r[c]))));
	const widths = cols.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i].length)));
	const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
	return [line(cols), widths.map((w) => '─'.repeat(w)).join('  '), ...cells.map(line)].join('\n');
}

/**
 * EXPLAIN for one statement. MySQL 8 returns its tree format (EXPLAIN ANALYZE adds real
 * timings); MariaDB returns JSON (ANALYZE FORMAT=JSON for real timings). ANALYZE is
 * only allowed for reads, which run in a READ ONLY transaction like any query.
 */
export async function explainMysql(
	id: string,
	sql: string,
	opts: { analyze: boolean; readOnly: boolean; runId?: string }
): Promise<MysqlExplainOutcome> {
	const problem = mysqlExplainProblem(sql, opts.analyze, opts.readOnly);
	if (problem) throw new Error(problem);
	const statement = splitMysql(sql)[0];
	const started = performance.now();
	// EXPLAIN never executes a write; reads are explained on a read-only session, and a
	// write's plan (write access only) on the writable one, since some servers refuse
	// EXPLAIN UPDATE inside a READ ONLY transaction.
	const isRead = ['select', 'with', 'table', 'values', '('].includes(firstKeyword(statement));
	return withConnection(id, { readOnly: opts.readOnly || isRead }, async (c, lease) => {
		if (opts.runId) running.set(opts.runId, { id, threadId: c.threadId });
		try {
			let plan: string;
			const mariadb = lease.entry.flavor === 'mariadb';
			if (mariadb) {
				const [rows] = await c.query<mysql.RowDataPacket[]>(`${opts.analyze ? 'ANALYZE' : 'EXPLAIN'} FORMAT=JSON ${statement}`);
				const cell = String(Object.values(rows[0] ?? {})[0] ?? '');
				try {
					plan = JSON.stringify(JSON.parse(cell), null, 2);
				} catch {
					plan = cell;
				}
			} else if (opts.analyze) {
				const [rows] = await c.query<mysql.RowDataPacket[]>(`EXPLAIN ANALYZE ${statement}`);
				plan = rows.map((r) => String(Object.values(r)[0])).join('\n');
			} else {
				try {
					const [rows] = await c.query<mysql.RowDataPacket[]>(`EXPLAIN FORMAT=TREE ${statement}`);
					plan = rows.map((r) => String(Object.values(r)[0])).join('\n');
					// Some statements (single-table UPDATE/DELETE) only have the classic plan.
					if (/not executable by iterator executor/.test(plan)) plan = textTable((await c.query<mysql.RowDataPacket[]>(`EXPLAIN ${statement}`))[0]);
				} catch (err) {
					// Before 8.0.16 there's only the classic table.
					if ((err as MysqlError).code !== 'ER_PARSE_ERROR' && (err as MysqlError).code !== 'ER_UNKNOWN_EXPLAIN_FORMAT') throw err;
					const [rows] = await c.query<mysql.RowDataPacket[]>(`EXPLAIN ${statement}`);
					plan = textTable(rows);
				}
			}
			return {
				plan,
				format: 'text',
				analyzed: opts.analyze,
				readOnly: true,
				executedWrite: false,
				durationMs: Math.round((performance.now() - started) * 10) / 10
			};
		} finally {
			if (opts.runId) running.delete(opts.runId);
		}
	});
}
