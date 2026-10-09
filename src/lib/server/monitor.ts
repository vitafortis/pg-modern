/**
 * Read-only monitoring queries for background jobs (alert checks, size sampling).
 * Each call uses a single pooled session through the normal read-only path, with
 * short statement and lock timeouts.
 */
import type pg from 'pg';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { withClient } from './pg.ts';
import { sizeOf, SYSTEM_SCHEMA_FILTER } from './introspect.ts';
import { withConnection } from './mysql/client.ts';
import { SYSTEM_DATABASES } from './mysql/introspect.ts';
import { getConnection } from './store.ts';
import { NotFound } from './pg.ts';
import type { TableSample } from './size-history.ts';

const CHECK_TIMEOUT_MS = 10_000;
const LOCK_TIMEOUT_MS = 2_000;
/** Upper bound for one whole check, including connecting. */
const OVERALL_TIMEOUT_MS = 30_000;

export interface LongQuery {
	pid: number;
	user: string | null;
	seconds: number;
	query: string | null;
}

export interface Snapshot {
	maxConnections: number | null;
	usedConnections: number | null;
	dbBytes: number | null;
	/** Postgres: max age(datfrozenxid) across databases. */
	xidAge: number | null;
	/** Queries running at least the requested time, longest first. */
	longQueries: LongQuery[] | null;
	/** Worst replay lag in seconds; null when there's no replication (or it can't be read). */
	replicationLagSeconds: number | null;
}

export interface SnapshotOptions {
	/** Report active queries running longer than this; omit to skip. */
	longQueryMinutes?: number;
	replication?: boolean;
	xid?: boolean;
}

function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	return Promise.race([
		p.finally(() => clearTimeout(timer)),
		new Promise<T>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
			timer.unref?.();
		})
	]);
}

const num = (v: unknown): number | null => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

// --- Postgres ------------------------------------------------------------------------

/** Runs an optional query inside a savepoint, so a failure (permissions, old version) doesn't abort the rest. */
async function optional<T extends pg.QueryResultRow>(client: pg.PoolClient, text: string, values: unknown[] = []): Promise<T[] | null> {
	await client.query('SAVEPOINT pgm_monitor');
	try {
		const { rows } = await client.query<T>({ text, values });
		await client.query('RELEASE SAVEPOINT pgm_monitor');
		return rows;
	} catch {
		await client.query('ROLLBACK TO SAVEPOINT pgm_monitor').catch(() => {});
		return null;
	}
}

async function pgSnapshot(id: string, opts: SnapshotOptions): Promise<Snapshot> {
	return withClient(id, { readOnly: true, timeoutMs: CHECK_TIMEOUT_MS, lockTimeoutMs: LOCK_TIMEOUT_MS }, async (client) => {
		const {
			rows: [base]
		} = await client.query<Record<string, unknown>>(
			`select current_setting('max_connections')::int as max_conn,
				(select count(*) from pg_stat_activity where backend_type = 'client backend')::int as used,
				pg_database_size(current_database())::bigint as db_bytes,
				pg_is_in_recovery() as in_recovery`
		);
		let xidAge: number | null = null;
		if (opts.xid) {
			const r = await optional<{ age: string }>(client, 'select max(age(datfrozenxid))::bigint as age from pg_database');
			xidAge = num(r?.[0]?.age);
		}
		let longQueries: LongQuery[] | null = null;
		if (opts.longQueryMinutes) {
			// Only client backends: autovacuum workers, WAL senders and other background
			// processes have their own backend_type.
			const r = await optional<Record<string, unknown>>(
				client,
				`select pid, usename as user, extract(epoch from clock_timestamp() - query_start)::float8 as seconds, left(query, 300) as query
				 from pg_stat_activity
				 where state = 'active' and backend_type = 'client backend' and pid <> pg_backend_pid()
					and query_start < clock_timestamp() - make_interval(secs => $1)
				 order by query_start limit 5`,
				[opts.longQueryMinutes * 60]
			);
			longQueries = r?.map((q) => ({ pid: Number(q.pid), user: (q.user as string) ?? null, seconds: Number(q.seconds), query: (q.query as string) || null })) ?? null;
		}
		let replicationLagSeconds: number | null = null;
		if (opts.replication) {
			const r =
				base.in_recovery === true
					? await optional<{ lag: number | null }>(
							client,
							`select case when pg_last_wal_receive_lsn() is null then null
								when pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() then 0
								else extract(epoch from clock_timestamp() - pg_last_xact_replay_timestamp())::float8 end as lag`
						)
					: await optional<{ lag: number | null }>(
							client,
							`select coalesce(extract(epoch from replay_lag), 0)::float8 as lag from pg_stat_replication`
						);
			const lags = (r ?? []).map((x) => num(x.lag)).filter((x): x is number => x != null);
			replicationLagSeconds = lags.length ? Math.max(...lags) : null;
		}
		return {
			maxConnections: num(base.max_conn),
			usedConnections: num(base.used),
			dbBytes: num(base.db_bytes),
			xidAge,
			longQueries,
			replicationLagSeconds
		};
	});
}

async function pgSizes(id: string): Promise<{ dbBytes: number; tables: TableSample[] }> {
	return withClient(id, { readOnly: true, timeoutMs: 20_000, lockTimeoutMs: LOCK_TIMEOUT_MS }, async (client) => {
		const {
			rows: [db]
		} = await client.query<{ bytes: string }>('select pg_database_size(current_database())::bigint as bytes');
		const { rows } = await client.query<{ schema: string; name: string; bytes: string | null }>(
			`select * from (
				select n.nspname as schema, c.relname as name, ${sizeOf('c.oid')} as bytes
				from pg_class c join pg_namespace n on n.oid = c.relnamespace
				where c.relkind in ('r', 'm') and ${SYSTEM_SCHEMA_FILTER}
			 ) t where bytes is not null order by bytes desc limit 50`
		);
		return { dbBytes: Number(db.bytes), tables: rows.map((r) => ({ schema: r.schema, name: r.name, bytes: Number(r.bytes) })) };
	});
}

// --- MySQL / MariaDB -----------------------------------------------------------------

const SYSTEM_IN = SYSTEM_DATABASES.map((d) => `'${d}'`).join(', ');

/** The connection's database, or every user database for a login without one. */
function schemaScope(database: string): { where: string; values: unknown[] } {
	return database ? { where: 'TABLE_SCHEMA = ?', values: [database] } : { where: `TABLE_SCHEMA NOT IN (${SYSTEM_IN})`, values: [] };
}

async function rows(c: PoolConnection, sql: string, values: unknown[] = []): Promise<Record<string, unknown>[] | null> {
	try {
		const [r] = await c.query<RowDataPacket[]>({ sql, values });
		return r as Record<string, unknown>[];
	} catch {
		return null;
	}
}

async function mysqlSnapshot(id: string, database: string, opts: SnapshotOptions): Promise<Snapshot> {
	return withConnection(id, { readOnly: true, timeoutMs: CHECK_TIMEOUT_MS }, async (c) => {
		const [[base]] = await c.query<RowDataPacket[]>('SELECT @@max_connections AS max_conn');
		const status = await rows(c, `SHOW GLOBAL STATUS LIKE 'Threads_connected'`);
		const scope = schemaScope(database);
		const size = await rows(c, `SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS bytes FROM information_schema.TABLES WHERE ${scope.where}`, scope.values);
		let longQueries: LongQuery[] | null = null;
		if (opts.longQueryMinutes) {
			// Commands other than Query/Execute cover idle sessions (Sleep), replication
			// (Binlog Dump, Connect) and daemons.
			const r = await rows(
				c,
				`SELECT ID AS pid, USER AS user, TIME AS seconds, LEFT(INFO, 300) AS query FROM information_schema.PROCESSLIST
				 WHERE COMMAND IN ('Query', 'Execute') AND TIME >= ? AND ID <> CONNECTION_ID()
					AND USER NOT IN ('system user', 'event_scheduler')
				 ORDER BY TIME DESC LIMIT 5`,
				[opts.longQueryMinutes * 60]
			);
			longQueries = r?.map((q) => ({ pid: Number(q.pid), user: (q.user as string) ?? null, seconds: Number(q.seconds), query: (q.query as string) || null })) ?? null;
		}
		let replicationLagSeconds: number | null = null;
		if (opts.replication) {
			const r = (await rows(c, 'SHOW REPLICA STATUS')) ?? (await rows(c, 'SHOW SLAVE STATUS'));
			const lags = (r ?? []).map((x) => num(x.Seconds_Behind_Source ?? x.Seconds_Behind_Master)).filter((x): x is number => x != null);
			replicationLagSeconds = lags.length ? Math.max(...lags) : null;
		}
		const threads = status?.find((s) => String(s.Variable_name ?? s.VARIABLE_NAME).toLowerCase() === 'threads_connected');
		return {
			maxConnections: num(base.max_conn),
			usedConnections: num(threads?.Value ?? threads?.VARIABLE_VALUE),
			dbBytes: num(size?.[0]?.bytes),
			xidAge: null,
			longQueries,
			replicationLagSeconds
		};
	});
}

async function mysqlSizes(id: string, database: string): Promise<{ dbBytes: number; tables: TableSample[] }> {
	return withConnection(id, { readOnly: true, timeoutMs: 20_000 }, async (c) => {
		const scope = schemaScope(database);
		const [[total]] = await c.query<RowDataPacket[]>({
			sql: `SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS bytes FROM information_schema.TABLES WHERE ${scope.where}`,
			values: scope.values
		});
		const [top] = await c.query<RowDataPacket[]>({
			sql: `SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name, DATA_LENGTH + INDEX_LENGTH AS bytes FROM information_schema.TABLES
			 WHERE TABLE_TYPE = 'BASE TABLE' AND ${scope.where} ORDER BY bytes DESC LIMIT 50`,
			values: scope.values
		});
		return {
			dbBytes: Number(total.bytes ?? 0),
			tables: top.map((r) => ({ schema: String(r.schema), name: String(r.name), bytes: Number(r.bytes ?? 0) }))
		};
	});
}

// --- dispatch ------------------------------------------------------------------------

/** Engines these checks know (others, added later, are skipped by the jobs). */
export function monitorable(conn: { engine: string }): boolean {
	return conn.engine === 'postgres' || conn.engine === 'mysql';
}

export async function snapshot(id: string, opts: SnapshotOptions = {}): Promise<Snapshot> {
	const conn = getConnection(id);
	if (!conn) throw new NotFound('Connection not found');
	if (!monitorable(conn)) throw new Error(`Monitoring isn't supported for ${conn.engine}`);
	const run = conn.engine === 'mysql' ? mysqlSnapshot(id, conn.database, opts) : pgSnapshot(id, opts);
	return withDeadline(run, OVERALL_TIMEOUT_MS, 'Check');
}

export async function sampleSizes(id: string): Promise<{ dbBytes: number; tables: TableSample[] }> {
	const conn = getConnection(id);
	if (!conn) throw new NotFound('Connection not found');
	if (!monitorable(conn)) throw new Error(`Size history isn't supported for ${conn.engine}`);
	const run = conn.engine === 'mysql' ? mysqlSizes(id, conn.database) : pgSizes(id);
	return withDeadline(run, 60_000, 'Size sample');
}
