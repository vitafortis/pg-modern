import { readQuery, toQueryError, withClient } from './pg.ts';
import { QUERY_LIMIT, type Activity, type ActivityLock, type ActivityServer, type ActivitySession, type DatabaseSize, type IndexStat, type Section, type TableStat } from '#lib/activity.ts';

const num = (v: unknown) => (v == null ? null : Number(v));

async function section<T>(fn: () => Promise<T>): Promise<Section<T>> {
	try {
		return { data: await fn(), error: null };
	} catch (err) {
		return { data: null, error: toQueryError(err).message };
	}
}

// `case` keeps role-membership checks from failing on servers without these roles.
const SERVER_SQL = `select current_setting('max_connections')::int as max_connections,
	current_setting('superuser_reserved_connections')::int + coalesce(current_setting('reserved_connections', true), '0')::int as reserved,
	current_database() as current_database,
	current_user as current_user,
	coalesce((select rolsuper from pg_roles where rolname = current_user), false) as superuser,
	case when exists (select 1 from pg_roles where rolname = 'pg_read_all_stats')
		then pg_has_role(current_user, 'pg_read_all_stats', 'member') else false end as read_all_stats,
	case when exists (select 1 from pg_roles where rolname = 'pg_signal_backend')
		then pg_has_role(current_user, 'pg_signal_backend', 'member') else false end as signal_backend`;

// pg_blocking_pids briefly locks the lock manager, so only ask for sessions waiting on a lock.
const SESSIONS_SQL = `select a.pid, a.usename as user, a.datname as database, a.application_name as app,
	case when a.client_addr is not null then host(a.client_addr) || coalesce(':' || nullif(a.client_port, -1), '')
		when a.client_port = -1 then 'local socket' end as client,
	a.backend_type, a.state, a.wait_event_type, a.wait_event,
	to_json(a.backend_start) as backend_start, to_json(a.xact_start) as xact_start,
	to_json(a.query_start) as query_start, to_json(a.state_change) as state_change,
	extract(epoch from clock_timestamp() - a.query_start)::float8 as query_seconds,
	extract(epoch from clock_timestamp() - a.xact_start)::float8 as xact_seconds,
	extract(epoch from clock_timestamp() - a.state_change)::float8 as state_seconds,
	left(a.query, ${QUERY_LIMIT}) as query, coalesce(length(a.query) > ${QUERY_LIMIT}, false) as query_truncated,
	age(a.backend_xid) as xid_age, age(a.backend_xmin) as xmin_age,
	case when a.wait_event_type = 'Lock' then to_json(pg_blocking_pids(a.pid)) else '[]'::json end as blocked_by,
	coalesce(a.application_name = 'pg-modern', false) as pg_modern,
	a.pid = pg_backend_pid() as self
from pg_stat_activity a
order by (a.state is null), (a.state = 'idle'), a.xact_start nulls last, a.query_start nulls last, a.pid`;

// Lock waits, plus strong relation locks held by transactions open for over a minute.
const LOCKS_SQL = `select l.pid, l.locktype, l.mode, l.granted,
	case when l.relation is null then null
		when c.oid is not null then quote_ident(n.nspname) || '.' || quote_ident(c.relname)
		else l.relation::text end as relation,
	coalesce(d.datname, a.datname) as database, a.usename as user,
	extract(epoch from clock_timestamp() - case when l.granted then a.xact_start else a.query_start end)::float8 as seconds
from pg_locks l
left join pg_stat_activity a on a.pid = l.pid
left join pg_database d on d.oid = l.database
left join pg_class c on c.oid = l.relation and l.database = (select oid from pg_database where datname = current_database())
left join pg_namespace n on n.oid = c.relnamespace
where l.pid is distinct from pg_backend_pid()
	and (not l.granted
		or (l.locktype = 'relation' and l.mode not in ('AccessShareLock', 'RowShareLock', 'RowExclusiveLock')
			and a.xact_start < clock_timestamp() - interval '1 minute'
			and (c.oid is null or c.relkind in ('r', 'p', 'm'))))
order by l.granted, seconds desc nulls last
limit 200`;

const DATABASES_SQL = `select d.datname as name,
	case when has_database_privilege(d.oid, 'CONNECT') then pg_database_size(d.oid) end as bytes,
	d.datname = current_database() as current,
	(select count(*) from pg_stat_activity a where a.datid = d.oid)::int as sessions
from pg_database d
where not d.datistemplate
order by 2 desc nulls last, 1`;

/*
 * The size functions take an ACCESS SHARE lock, so they'd queue behind (and add to)
 * the very lock pile-up this panel is meant to show. Relations with an ACCESS
 * EXCLUSIVE lock held or requested fall back to the planner's page estimate.
 */
const LOCKED_CTE = `locked as (
	select distinct l.relation from pg_locks l
	where l.locktype = 'relation' and l.mode = 'AccessExclusiveLock'
		and l.database = (select oid from pg_database where datname = current_database()))`;
const PAGES = `current_setting('block_size')::bigint`;

const TABLES_SQL = `with ${LOCKED_CTE},
sized as (
	select s.*, c.relpages, s.relid in (select relation from locked) as locked,
		(select coalesce(sum(ic.relpages), 0) from pg_index i join pg_class ic on ic.oid = i.indexrelid where i.indrelid = s.relid) as index_pages
	from pg_stat_user_tables s join pg_class c on c.oid = s.relid),
measured as (
	select sized.*,
		case when locked then (relpages + index_pages) * ${PAGES} else pg_total_relation_size(relid) end as total_bytes,
		case when locked then relpages * ${PAGES} else pg_relation_size(relid) end as table_bytes,
		case when locked then index_pages * ${PAGES} else pg_indexes_size(relid) end as index_bytes
	from sized)
select schemaname as schema, relname as name, total_bytes, table_bytes, index_bytes, locked,
	n_live_tup as live, n_dead_tup as dead, seq_scan, idx_scan,
	to_json(last_autovacuum) as last_autovacuum, to_json(last_vacuum) as last_vacuum,
	to_json(last_autoanalyze) as last_autoanalyze, to_json(last_analyze) as last_analyze
from measured
order by total_bytes desc, 1, 2
limit 15`;

const INDEXES_SQL = `with ${LOCKED_CTE},
measured as (
	select s.*, i.indisunique,
		case when s.indexrelid in (select relation from locked) or s.relid in (select relation from locked)
			then c.relpages * ${PAGES} else pg_relation_size(s.indexrelid) end as bytes
	from pg_stat_user_indexes s join pg_index i on i.indexrelid = s.indexrelid join pg_class c on c.oid = s.indexrelid)
select schemaname as schema, relname as table, indexrelname as name, bytes, idx_scan as scans, indisunique as unique
from measured
order by bytes desc, 1, 3
limit 15`;

/** Like readQuery, but gives up quickly instead of queueing behind someone else's lock. */
function readNoWait<T extends Record<string, unknown>>(id: string, text: string): Promise<T[]> {
	return withClient(id, { readOnly: true }, async (client) => {
		await client.query(`SET LOCAL lock_timeout = '1s'`);
		return (await client.query<T>(text)).rows;
	});
}

export async function activity(id: string): Promise<Activity> {
	const [server, sessions, locks, databases, tables, indexes] = await Promise.all([
		section<ActivityServer>(async () => {
			const [r] = await readQuery<Record<string, unknown>>(id, SERVER_SQL);
			return {
				maxConnections: Number(r.max_connections),
				reservedConnections: Number(r.reserved),
				currentDatabase: String(r.current_database),
				currentUser: String(r.current_user),
				superuser: r.superuser === true,
				readAllStats: r.superuser === true || r.read_all_stats === true,
				canSignalOthers: r.superuser === true || r.signal_backend === true
			};
		}),
		section<ActivitySession[]>(async () =>
			(await readQuery<Record<string, unknown>>(id, SESSIONS_SQL)).map((r) => ({
				pid: Number(r.pid),
				user: (r.user as string) ?? null,
				database: (r.database as string) ?? null,
				app: (r.app as string) || null,
				client: (r.client as string) ?? null,
				backendType: (r.backend_type as string) ?? null,
				state: (r.state as string) ?? null,
				waitEventType: (r.wait_event_type as string) ?? null,
				waitEvent: (r.wait_event as string) ?? null,
				backendStart: (r.backend_start as string) ?? null,
				xactStart: (r.xact_start as string) ?? null,
				queryStart: (r.query_start as string) ?? null,
				stateChange: (r.state_change as string) ?? null,
				querySeconds: num(r.query_seconds),
				xactSeconds: num(r.xact_seconds),
				stateSeconds: num(r.state_seconds),
				query: (r.query as string) || null,
				queryTruncated: r.query_truncated === true,
				xidAge: num(r.xid_age),
				xminAge: num(r.xmin_age),
				blockedBy: Array.isArray(r.blocked_by) ? (r.blocked_by as number[]).map(Number) : [],
				pgModern: r.pg_modern === true,
				self: r.self === true
			}))
		),
		section<ActivityLock[]>(async () =>
			(await readQuery<Record<string, unknown>>(id, LOCKS_SQL)).map((r) => ({
				pid: Number(r.pid),
				locktype: String(r.locktype),
				mode: String(r.mode),
				granted: r.granted === true,
				relation: (r.relation as string) ?? null,
				database: (r.database as string) ?? null,
				user: (r.user as string) ?? null,
				seconds: num(r.seconds)
			}))
		),
		section<DatabaseSize[]>(async () =>
			(await readQuery<Record<string, unknown>>(id, DATABASES_SQL)).map((r) => ({
				name: String(r.name),
				bytes: num(r.bytes),
				current: r.current === true,
				sessions: Number(r.sessions)
			}))
		),
		section<TableStat[]>(async () =>
			(await readNoWait(id, TABLES_SQL)).map((r) => ({
				schema: String(r.schema),
				name: String(r.name),
				totalBytes: Number(r.total_bytes),
				tableBytes: Number(r.table_bytes),
				indexBytes: Number(r.index_bytes),
				sizeEstimated: r.locked === true,
				liveTuples: Number(r.live ?? 0),
				deadTuples: Number(r.dead ?? 0),
				seqScans: num(r.seq_scan),
				idxScans: num(r.idx_scan),
				lastAutovacuum: (r.last_autovacuum as string) ?? null,
				lastVacuum: (r.last_vacuum as string) ?? null,
				lastAutoanalyze: (r.last_autoanalyze as string) ?? null,
				lastAnalyze: (r.last_analyze as string) ?? null
			}))
		),
		section<IndexStat[]>(async () =>
			(await readNoWait(id, INDEXES_SQL)).map((r) => ({
				schema: String(r.schema),
				table: String(r.table),
				name: String(r.name),
				bytes: Number(r.bytes),
				scans: num(r.scans),
				unique: r.unique === true
			}))
		)
	]);
	return { fetchedAt: new Date().toISOString(), server, sessions, locks, databases, tables, indexes };
}

export interface SignalTarget {
	pid: number;
	user: string | null;
	app: string | null;
	database: string | null;
	queryStart: string | null;
	query: string | null;
}

export type SignalOutcome =
	| { status: 'self' }
	| { status: 'missing' }
	| { status: 'done'; ok: boolean; target: SignalTarget };

/**
 * pg_cancel_backend / pg_terminate_backend. Both work inside a READ ONLY
 * transaction, so this uses the ordinary read-only client; callers check the
 * user's write access first.
 */
export async function signalBackend(id: string, pid: number, terminate: boolean): Promise<SignalOutcome> {
	return withClient(id, { readOnly: true }, async (client) => {
		const { rows } = await client.query<Record<string, unknown>>(
			`select pg_backend_pid() as self, a.pid, a.usename as user, a.application_name as app, a.datname as database,
				to_json(a.query_start) as query_start, left(a.query, 300) as query
			 from (select 1) x left join pg_stat_activity a on a.pid = $1`,
			[pid]
		);
		const r = rows[0];
		if (Number(r.self) === pid) return { status: 'self' };
		if (r.pid == null) return { status: 'missing' };
		const fn = terminate ? 'pg_terminate_backend' : 'pg_cancel_backend';
		const { rows: res } = await client.query<{ ok: boolean }>(`select ${fn}($1) as ok`, [pid]);
		return {
			status: 'done',
			ok: res[0]?.ok === true,
			target: {
				pid,
				user: (r.user as string) ?? null,
				app: (r.app as string) || null,
				database: (r.database as string) ?? null,
				queryStart: (r.query_start as string) ?? null,
				query: (r.query as string) ?? null
			}
		};
	});
}
