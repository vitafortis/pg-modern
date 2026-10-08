import pg from 'pg';
import Cursor from 'pg-cursor';
import { config } from './config.ts';
import { getConnection, getPassword, touchConnection } from './store.ts';
import { escapesReadOnly, returnsRows, splitStatements } from './sql.ts';
import type { Connection, QueryError, QueryField, QueryResult, SslMode } from '#lib/types.ts';

const { Pool, types: pgTypes } = pg;

/**
 * Values are kept as the server's text representation except for types with an
 * exact JS equivalent. This avoids timezone shifts on timestamps and precision
 * loss on bigint/numeric.
 */
const PASSTHROUGH_PARSERS: Record<number, (v: string) => unknown> = {
	16: (v) => v === 't', // bool
	21: Number, // int2
	23: Number, // int4
	26: Number, // oid
	700: Number, // float4
	701: Number, // float8
	114: (v) => JSON.parse(v), // json
	3802: (v) => JSON.parse(v) // jsonb
};

export const typeParsers = {
	getTypeParser(oid: number, format?: 'text' | 'binary') {
		if (format === 'binary') return pgTypes.getTypeParser(oid, 'binary');
		return PASSTHROUGH_PARSERS[oid] ?? ((v: string) => v);
	}
} as pg.CustomTypesConfig;

interface PoolEntry {
	pool: pg.Pool;
	version: string;
	typeNames: Map<number, string>;
}

const pools = new Map<string, PoolEntry>();

function sslOption(mode: SslMode): pg.PoolConfig['ssl'] {
	switch (mode) {
		case 'disable':
			return false;
		case 'verify-full':
			return { rejectUnauthorized: true };
		default:
			return { rejectUnauthorized: false };
	}
}

export interface Target {
	host: string;
	port: number;
	database: string;
	user: string;
	password?: string;
	sslMode: SslMode;
	readOnly: boolean;
}

function poolConfig(t: Target, ssl: pg.PoolConfig['ssl']): pg.PoolConfig {
	return {
		host: t.host,
		port: t.port,
		database: t.database,
		user: t.user,
		password: t.password,
		ssl,
		max: 4,
		idleTimeoutMillis: 60_000,
		connectionTimeoutMillis: 8_000,
		application_name: 'pg-modern',
		// Belt and braces: the session default is read-only too, on top of the
		// explicit READ ONLY transaction every read-only query runs in.
		options: t.readOnly ? '-c default_transaction_read_only=on' : undefined,
		types: typeParsers
	};
}

function isSslUnsupported(err: unknown) {
	return err instanceof Error && /does not support SSL/i.test(err.message);
}

/** Opens a pool, resolving `prefer` to SSL or plaintext depending on what the server supports. */
async function openPool(t: Target): Promise<pg.Pool> {
	let pool = new Pool(poolConfig(t, sslOption(t.sslMode)));
	try {
		const client = await pool.connect();
		client.release();
	} catch (err) {
		await pool.end().catch(() => {});
		if (t.sslMode === 'prefer' && isSslUnsupported(err)) {
			pool = new Pool(poolConfig(t, false));
			const client = await pool.connect();
			client.release();
		} else throw err;
	}
	pool.on('error', () => {}); // idle client errors (e.g. server restart) must not crash the app
	return pool;
}

function targetFor(conn: Connection): Target {
	return { ...conn, password: getPassword(conn.id) };
}

async function entryFor(id: string): Promise<PoolEntry & { conn: Connection }> {
	const conn = getConnection(id);
	if (!conn) throw new NotFound('Connection not found');
	const existing = pools.get(id);
	if (existing && existing.version === conn.updatedAt) return { ...existing, conn };
	if (existing) {
		pools.delete(id);
		existing.pool.end().catch(() => {});
	}
	const entry: PoolEntry = { pool: await openPool(targetFor(conn)), version: conn.updatedAt, typeNames: new Map() };
	pools.set(id, entry);
	touchConnection(id);
	return { ...entry, conn };
}

export function closePool(id: string) {
	const entry = pools.get(id);
	if (entry) {
		pools.delete(id);
		entry.pool.end().catch(() => {});
	}
}

export class NotFound extends Error {}

export function toQueryError(err: unknown): QueryError {
	if (err && typeof err === 'object' && 'message' in err) {
		const e = err as pg.DatabaseError;
		return {
			message: e.message,
			code: e.code,
			position: e.position ? Number(e.position) : undefined,
			detail: e.detail,
			hint: e.hint
		};
	}
	return { message: String(err) };
}

/** Tests credentials without persisting anything. */
export async function testTarget(t: Target): Promise<{ ok: true; version: string; latencyMs: number } | { ok: false; error: QueryError }> {
	const started = performance.now();
	let pool: pg.Pool | undefined;
	try {
		pool = await openPool(t);
		const { rows } = await pool.query<{ v: string }>('select version() as v');
		return { ok: true, version: rows[0].v, latencyMs: Math.round(performance.now() - started) };
	} catch (err) {
		return { ok: false, error: toQueryError(err) };
	} finally {
		pool?.end().catch(() => {});
	}
}

export async function testConnection(id: string) {
	const conn = getConnection(id);
	if (!conn) throw new NotFound('Connection not found');
	const result = await testTarget(targetFor(conn));
	if (result.ok) touchConnection(id);
	return result;
}

async function resolveTypeNames(entry: PoolEntry, client: pg.PoolClient, oids: number[]) {
	const missing = [...new Set(oids)].filter((o) => !entry.typeNames.has(o));
	if (missing.length) {
		const { rows } = await client.query<{ oid: number; name: string }>(
			'select oid::int as oid, format_type(oid, null) as name from pg_type where oid = any($1::oid[])',
			[missing]
		);
		for (const r of rows) entry.typeNames.set(r.oid, r.name);
	}
}

type RawField = { name: string; dataTypeID: number };

/**
 * Runs `fn` on a pooled client. With `readOnly`, everything happens inside a
 * READ ONLY transaction that is always rolled back.
 */
export async function withClient<T>(
	id: string,
	opts: { readOnly: boolean; timeoutMs?: number },
	fn: (client: pg.PoolClient, entry: PoolEntry) => Promise<T>
): Promise<T> {
	const entry = await entryFor(id);
	const readOnly = opts.readOnly || entry.conn.readOnly;
	const client = await entry.pool.connect();
	let broken = false;
	try {
		if (readOnly) {
			await client.query('BEGIN TRANSACTION READ ONLY');
			await client.query(`SET LOCAL statement_timeout = ${Math.floor(opts.timeoutMs ?? config.statementTimeoutMs)}`);
		} else {
			await client.query(`SET statement_timeout = ${Math.floor(opts.timeoutMs ?? config.statementTimeoutMs)}`);
		}
		return await fn(client, entry);
	} catch (err) {
		broken = !(err instanceof Error && 'code' in err); // non-server errors may leave the socket unusable
		throw err;
	} finally {
		if (readOnly) await client.query('ROLLBACK').catch(() => (broken = true));
		client.release(broken);
	}
}

async function runStatement(
	client: pg.PoolClient,
	entry: PoolEntry,
	sql: string,
	readOnly: boolean,
	maxRows: number
): Promise<QueryResult> {
	const started = performance.now();
	let fields: RawField[];
	let rows: unknown[][];
	let command: string;
	let rowCount: number | null;
	let truncated = false;

	if (returnsRows(sql)) {
		const cursor = client.query(new Cursor(sql, undefined, { rowMode: 'array', types: typeParsers }));
		rows = (await cursor.read(maxRows + 1)) as unknown[][];
		if (rows.length > maxRows) {
			truncated = true;
			rows = rows.slice(0, maxRows);
		}
		await cursor.close();
		// pg-cursor keeps the result metadata on its internal Result object.
		const result = (cursor as unknown as { _result: pg.QueryResult })._result;
		fields = result.fields ?? [];
		command = result.command ?? 'SELECT';
		rowCount = truncated ? null : (result.rowCount ?? rows.length);
	} else {
		// Extended protocol rejects multiple statements in one call, so a single
		// "statement" can't smuggle a COMMIT past the read-only transaction.
		const result = await client.query({
			text: sql,
			rowMode: 'array',
			queryMode: 'extended',
			types: typeParsers
		} as pg.QueryArrayConfig);
		fields = result.fields ?? [];
		rows = (result.rows ?? []) as unknown[][];
		command = result.command;
		rowCount = result.rowCount;
	}

	await resolveTypeNames(entry, client, fields.map((f) => f.dataTypeID));
	const outFields: QueryField[] = fields.map((f) => ({
		name: f.name,
		dataTypeID: f.dataTypeID,
		type: entry.typeNames.get(f.dataTypeID) ?? String(f.dataTypeID)
	}));

	return {
		command,
		rowCount,
		fields: outFields,
		rows: rows.map((r) => r.map(serializeValue)),
		truncated,
		durationMs: Math.round((performance.now() - started) * 10) / 10,
		readOnly
	};
}

/** Makes driver values JSON-safe (Buffers for bytea when binary, Dates, bigint). */
function serializeValue(v: unknown): unknown {
	if (v instanceof Date) return v.toISOString();
	if (typeof v === 'bigint') return v.toString();
	if (Buffer.isBuffer(v)) return `\\x${v.toString('hex')}`;
	if (Array.isArray(v)) return v.map(serializeValue);
	return v;
}

export interface ScriptOutcome {
	results: (QueryResult & { sql: string })[];
	error?: QueryError & { statementIndex: number; sql: string };
}

const running = new Map<string, number>();

/**
 * Executes a script statement by statement. Read-only connections run all of it in
 * a single READ ONLY transaction that is rolled back afterwards.
 */
export async function runScript(id: string, script: string, opts: { runId?: string; maxRows?: number } = {}): Promise<ScriptOutcome> {
	const statements = splitStatements(script);
	const maxRows = Math.min(opts.maxRows ?? config.maxRows, config.maxRows);
	const conn = getConnection(id);
	if (!conn) throw new NotFound('Connection not found');

	if (conn.readOnly) {
		const blocked = statements.findIndex(escapesReadOnly);
		if (blocked !== -1) {
			return {
				results: [],
				error: {
					statementIndex: blocked,
					sql: statements[blocked],
					message: 'Transaction and session control statements are blocked on read-only connections.',
					hint: 'Switch the connection to read/write in its settings if you need this.'
				}
			};
		}
	}

	return withClient(id, { readOnly: conn.readOnly }, async (client, entry) => {
		const outcome: ScriptOutcome = { results: [] };
		const pid = (client as unknown as { processID?: number }).processID;
		if (opts.runId && pid) running.set(opts.runId, pid);
		try {
			for (let i = 0; i < statements.length; i++) {
				try {
					const result = await runStatement(client, entry, statements[i], conn.readOnly, maxRows);
					outcome.results.push({ ...result, sql: statements[i] });
				} catch (err) {
					outcome.error = { ...toQueryError(err), statementIndex: i, sql: statements[i] };
					break;
				}
			}
		} finally {
			if (opts.runId) running.delete(opts.runId);
		}
		return outcome;
	});
}

export async function cancelRun(id: string, runId: string): Promise<boolean> {
	const pid = running.get(runId);
	if (!pid) return false;
	const entry = await entryFor(id);
	const { rows } = await entry.pool.query<{ ok: boolean }>('select pg_cancel_backend($1) as ok', [pid]);
	return rows[0]?.ok ?? false;
}

/** Runs a read-only, parameterised query and returns plain object rows. */
export async function readQuery<T extends pg.QueryResultRow>(
	id: string,
	text: string,
	values: unknown[] = [],
	timeoutMs?: number
): Promise<T[]> {
	return withClient(id, { readOnly: true, timeoutMs }, async (client) => {
		const { rows } = await client.query<T>({ text, values, types: typeParsers });
		return rows;
	});
}

export { runStatement };
