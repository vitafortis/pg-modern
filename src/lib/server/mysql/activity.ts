/**
 * Live activity for MySQL / MariaDB: the process list, InnoDB transactions and lock
 * waits (when this account may see them), and database/table/index sizes — in the
 * same shape as the Postgres activity panel.
 */
import type mysql from 'mysql2/promise';
import { getConnection } from '../store.ts';
import { NotFound } from '../pg.ts';
import { ownThreadIds, readQuery, serverInfo, toMysqlError, withConnection } from './client.ts';
import { SYSTEM_DATABASES, grants, summarizeGrants } from './introspect.ts';
import { QUERY_LIMIT, type Activity, type ActivityLock, type ActivityServer, type ActivitySession, type DatabaseSize, type IndexStat, type Section, type TableStat } from '#lib/activity.ts';
import type { SignalOutcome } from '../activity.ts';

type Row = Record<string, unknown>;
const SYSTEM_IN = SYSTEM_DATABASES.map((d) => `'${d}'`).join(', ');
const num = (v: unknown) => (v == null ? null : Number(v));
const str = (v: unknown) => (v == null || v === '' ? null : String(v));

async function section<T>(fn: () => Promise<T>): Promise<Section<T>> {
	try {
		return { data: await fn(), error: null };
	} catch (err) {
		return { data: null, error: toMysqlError(err, {}).message };
	}
}

/**
 * Who waits on whom: MySQL 8's performance_schema, MariaDB's information_schema
 * tables, then the sys schema view. Each needs privileges this account may not have;
 * the first error is reported if none works.
 */
async function lockWaits(id: string, flavor: string): Promise<Row[]> {
	const perfSchema = `SELECT rt.PROCESSLIST_ID AS waiting, bt.PROCESSLIST_ID AS blocking,
			CONCAT(rl.OBJECT_SCHEMA, '.', rl.OBJECT_NAME) AS relation, rl.LOCK_TYPE AS locktype,
			rl.LOCK_MODE AS waiting_mode, bl.LOCK_MODE AS blocking_mode, TIMESTAMPDIFF(SECOND, trx.trx_wait_started, NOW()) AS seconds
		 FROM performance_schema.data_lock_waits w
		 JOIN performance_schema.threads rt ON rt.THREAD_ID = w.REQUESTING_THREAD_ID
		 JOIN performance_schema.threads bt ON bt.THREAD_ID = w.BLOCKING_THREAD_ID
		 JOIN performance_schema.data_locks rl ON rl.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
		 JOIN performance_schema.data_locks bl ON bl.ENGINE_LOCK_ID = w.BLOCKING_ENGINE_LOCK_ID
		 LEFT JOIN information_schema.INNODB_TRX trx ON trx.trx_id = w.REQUESTING_ENGINE_TRANSACTION_ID
		 LIMIT 200`;
	const mariadb = `SELECT r.trx_mysql_thread_id AS waiting, b.trx_mysql_thread_id AS blocking, rl.lock_table AS relation, rl.lock_type AS locktype,
			rl.lock_mode AS waiting_mode, bl.lock_mode AS blocking_mode, TIMESTAMPDIFF(SECOND, r.trx_wait_started, NOW()) AS seconds
		 FROM information_schema.INNODB_LOCK_WAITS w
		 JOIN information_schema.INNODB_TRX r ON r.trx_id = w.requesting_trx_id
		 JOIN information_schema.INNODB_TRX b ON b.trx_id = w.blocking_trx_id
		 LEFT JOIN information_schema.INNODB_LOCKS rl ON rl.lock_id = w.requested_lock_id
		 LEFT JOIN information_schema.INNODB_LOCKS bl ON bl.lock_id = w.blocking_lock_id
		 LIMIT 200`;
	const sys = `SELECT waiting_pid AS waiting, blocking_pid AS blocking, locked_table AS relation, locked_type AS locktype,
			waiting_lock_mode AS waiting_mode, blocking_lock_mode AS blocking_mode, wait_age_secs AS seconds
		 FROM sys.innodb_lock_waits LIMIT 200`;
	let first: unknown;
	for (const sql of flavor === 'mariadb' ? [mariadb, sys] : [perfSchema, sys]) {
		try {
			return await readQuery<Row>(id, sql);
		} catch (err) {
			first ??= err;
		}
	}
	throw first;
}

/** Maps a process-list row onto the Postgres-shaped session. */
function toSession(r: Row, trx: Map<number, Row>, blockedBy: Map<number, Set<number>>, self: number, own: Set<number>): ActivitySession {
	const pid = Number(r.id);
	const command = String(r.command ?? '');
	const user = str(r.user);
	const t = trx.get(pid);
	const background = /^(daemon|binlog dump|binlog dump gtid|connect|register slave|slave_\w+)$/i.test(command) || user === 'system user' || user === 'event_scheduler';
	const info = str(r.info);
	let state: string | null;
	if (background) state = null;
	else if (/^sleep$/i.test(command)) state = t ? 'idle in transaction' : 'idle';
	else if (/^(query|execute|fetch)$/i.test(command)) state = 'active';
	else if (/^killed$/i.test(command)) state = 'killed';
	else state = command.toLowerCase() || null;
	const procState = str(r.state);
	const waitingOnLock = !!procState && /lock/i.test(procState) && state === 'active';
	const seconds = num(r.time);
	const now = Date.now();
	const ago = (s: number | null) => (s == null ? null : new Date(now - s * 1000).toISOString());
	const xactSeconds = t ? num(t.seconds) : null;
	return {
		pid,
		user,
		database: str(r.db),
		app: null,
		client: str(r.host),
		backendType: background ? (user === 'system user' || user === 'event_scheduler' ? user : command.toLowerCase()) : 'client backend',
		state,
		waitEventType: waitingOnLock ? 'Lock' : procState && state === 'active' ? 'State' : null,
		waitEvent: state === 'active' || background ? procState : null,
		backendStart: null,
		xactStart: ago(xactSeconds),
		queryStart: state === 'active' ? ago(seconds) : null,
		stateChange: ago(seconds),
		querySeconds: state === 'active' ? seconds : null,
		xactSeconds,
		stateSeconds: seconds,
		query: info ? info.slice(0, QUERY_LIMIT) : null,
		queryTruncated: !!info && info.length > QUERY_LIMIT,
		xidAge: null,
		xminAge: null,
		blockedBy: [...(blockedBy.get(pid) ?? [])],
		pgModern: own.has(pid),
		self: pid === self
	};
}

export async function mysqlActivity(id: string): Promise<Activity> {
	const conn = getConnection(id);
	if (!conn) throw new NotFound('Connection not found');
	const grantList = await grants(id).catch(() => [] as string[]);
	const g = summarizeGrants(grantList);

	const [server, sessionsAndLocks, databases, tables, indexes] = await Promise.all([
		section<ActivityServer>(async () => {
			const [r] = await readQuery<Row>(id, 'SELECT @@max_connections AS max_connections, DATABASE() AS db, CURRENT_USER() AS cu');
			return {
				maxConnections: Number(r.max_connections),
				reservedConnections: 1, // MySQL keeps one extra connection for CONNECTION_ADMIN / SUPER
				currentDatabase: String(r.db ?? conn.database ?? ''),
				currentUser: String(r.cu),
				superuser: g.superuser,
				readAllStats: g.superuser || g.process,
				canSignalOthers: g.superuser || g.connectionAdmin
			};
		}),
		(async () => {
			// One session for the list itself, so "this request" can be marked.
			const listing = await section(() =>
				withConnection(id, { readOnly: true }, async (c) => {
					const [[me]] = await c.query<mysql.RowDataPacket[]>('SELECT CONNECTION_ID() AS id');
					const [rows] = await c.query<mysql.RowDataPacket[]>(
						`SELECT ID AS id, USER AS user, HOST AS host, DB AS db, COMMAND AS command, TIME AS time, STATE AS state, INFO AS info
						 FROM information_schema.PROCESSLIST ORDER BY COMMAND = 'Sleep', TIME DESC, ID`
					);
					return { self: Number(me.id), rows: rows as Row[] };
				})
			);
			const trxRows = await readQuery<Row>(
				id,
				`SELECT trx_mysql_thread_id AS pid, TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS seconds, trx_state AS state FROM information_schema.INNODB_TRX`
			).catch(() => [] as Row[]);
			const { flavor } = await serverInfo(id);
			const waits = await section(() => lockWaits(id, flavor));
			const trx = new Map(trxRows.map((t) => [Number(t.pid), t]));
			const blockedBy = new Map<number, Set<number>>();
			for (const w of waits.data ?? []) {
				const set = blockedBy.get(Number(w.waiting)) ?? new Set<number>();
				set.add(Number(w.blocking));
				blockedBy.set(Number(w.waiting), set);
			}
			const own = ownThreadIds(conn);
			const list = listing.data;
			const sessions: Section<ActivitySession[]> = list
				? { data: list.rows.map((r) => toSession(r, trx, blockedBy, list.self, own)), error: null }
				: { data: null, error: listing.error ?? 'Could not read the process list' };
			const users = new Map((listing.data?.rows ?? []).map((r) => [Number(r.id), { user: str(r.user), db: str(r.db) }]));
			const locks: Section<ActivityLock[]> = waits.error
				? { data: null, error: `Lock waits need the PROCESS privilege (and performance_schema access on MySQL 8): ${waits.error}` }
				: {
						data: (waits.data ?? []).flatMap((w): ActivityLock[] => {
							const relation = str(w.relation);
							const seconds = num(w.seconds);
							const waiting = Number(w.waiting);
							const blocking = Number(w.blocking);
							return [
								{ pid: waiting, locktype: String(w.locktype ?? 'record').toLowerCase(), mode: String(w.waiting_mode ?? ''), granted: false, relation, database: users.get(waiting)?.db ?? null, user: users.get(waiting)?.user ?? null, seconds },
								{ pid: blocking, locktype: String(w.locktype ?? 'record').toLowerCase(), mode: String(w.blocking_mode ?? ''), granted: true, relation, database: users.get(blocking)?.db ?? null, user: users.get(blocking)?.user ?? null, seconds: num(trx.get(blocking)?.seconds) }
							];
						}),
						error: null
					};
			return { sessions, locks };
		})(),
		section<DatabaseSize[]>(async () => {
			const [rows, procs, [cur]] = await Promise.all([
				readQuery<Row>(
					id,
					`SELECT s.SCHEMA_NAME AS name, SUM(t.DATA_LENGTH + t.INDEX_LENGTH) AS bytes
					 FROM information_schema.SCHEMATA s LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
					 WHERE s.SCHEMA_NAME NOT IN (${SYSTEM_IN}) GROUP BY s.SCHEMA_NAME ORDER BY 2 DESC, 1`
				),
				readQuery<Row>(id, 'SELECT DB AS db, COUNT(*) AS n FROM information_schema.PROCESSLIST GROUP BY DB'),
				readQuery<Row>(id, 'SELECT DATABASE() AS db')
			]);
			const sessions = new Map(procs.map((p) => [String(p.db), Number(p.n)]));
			return rows.map((r) => ({
				name: String(r.name),
				bytes: Number(r.bytes ?? 0),
				current: String(r.name) === String(cur.db ?? conn.database),
				sessions: sessions.get(String(r.name)) ?? 0
			}));
		}),
		section<TableStat[]>(async () =>
			(
				await readQuery<Row>(
					id,
					`SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name, ENGINE AS engine, DATA_LENGTH AS data, INDEX_LENGTH AS idx,
						DATA_FREE AS free, TABLE_ROWS AS est_rows, UPDATE_TIME AS updated
					 FROM information_schema.TABLES WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA NOT IN (${SYSTEM_IN})
					 ORDER BY DATA_LENGTH + INDEX_LENGTH DESC, 1, 2 LIMIT 15`
				)
			).map((r) => ({
				schema: String(r.schema),
				name: String(r.name),
				totalBytes: Number(r.data ?? 0) + Number(r.idx ?? 0),
				tableBytes: Number(r.data ?? 0),
				indexBytes: Number(r.idx ?? 0),
				sizeEstimated: false,
				liveTuples: Number(r.est_rows ?? 0),
				deadTuples: 0,
				seqScans: null,
				idxScans: null,
				lastAutovacuum: null,
				lastVacuum: null,
				lastAutoanalyze: null,
				lastAnalyze: null,
				storageEngine: str(r.engine),
				freeBytes: num(r.free),
				updatedAt: str(r.updated)
			}))
		),
		section<IndexStat[]>(async () => {
			const rows = await readQuery<Row>(
				id,
				`SELECT s.database_name AS \`schema\`, s.table_name AS \`table\`, s.index_name AS name, s.stat_value * @@innodb_page_size AS bytes
				 FROM mysql.innodb_index_stats s
				 WHERE s.stat_name = 'size' AND s.database_name NOT IN (${SYSTEM_IN})
				 ORDER BY bytes DESC LIMIT 15`
			);
			const uniques = await readQuery<Row>(
				id,
				`SELECT DISTINCT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS \`table\`, INDEX_NAME AS name FROM information_schema.STATISTICS
				 WHERE NON_UNIQUE = 0 AND TABLE_SCHEMA NOT IN (${SYSTEM_IN})`
			);
			const unique = new Set(uniques.map((u) => `${u.schema}.${u.table}.${u.name}`));
			return rows.map((r) => ({
				schema: String(r.schema),
				table: String(r.table),
				name: String(r.name),
				bytes: Number(r.bytes ?? 0),
				scans: null,
				unique: unique.has(`${r.schema}.${r.table}.${r.name}`)
			}));
		})
	]);

	return {
		fetchedAt: new Date().toISOString(),
		engine: 'mysql',
		server,
		sessions: sessionsAndLocks.sessions,
		locks: sessionsAndLocks.locks,
		databases,
		tables,
		indexes
	};
}

/**
 * KILL QUERY (cancel) or KILL (terminate). Callers check the user's write access first;
 * the server decides whether this account may kill other users' threads.
 */
export async function mysqlSignal(id: string, pid: number, terminate: boolean): Promise<SignalOutcome> {
	return withConnection(id, { readOnly: true }, async (c) => {
		const [[me]] = await c.query<mysql.RowDataPacket[]>('SELECT CONNECTION_ID() AS id');
		if (Number(me.id) === pid) return { status: 'self' } as const;
		const [rows] = await c.query<mysql.RowDataPacket[]>(
			'SELECT ID AS id, USER AS user, DB AS db, TIME AS time, LEFT(INFO, 300) AS info FROM information_schema.PROCESSLIST WHERE ID = ?',
			[pid]
		);
		const r = rows[0];
		if (!r) return { status: 'missing' } as const;
		// KILL ends whatever that thread runs; done outside our READ ONLY transaction.
		await c.query('ROLLBACK');
		await c.query(`KILL ${terminate ? 'CONNECTION' : 'QUERY'} ${Math.floor(pid)}`);
		await c.query('START TRANSACTION READ ONLY');
		return {
			status: 'done',
			ok: true,
			target: {
				pid,
				user: str(r.user),
				app: null,
				database: str(r.db),
				queryStart: r.time != null && r.info ? new Date(Date.now() - Number(r.time) * 1000).toISOString() : null,
				query: str(r.info)
			}
		} as const;
	});
}
