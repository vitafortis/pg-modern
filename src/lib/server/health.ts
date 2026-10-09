/**
 * Postgres health checks. Every check is a read-only catalog/statistics query on the
 * read-only path with short statement and lock timeouts; one failing (permission
 * denied on a pg_stat view, a timeout) is reported inline and never hides the rest.
 * Suggested fixes are only text — nothing here changes the database.
 */
import type pg from 'pg';
import { toQueryError, typeParsers, withClient } from './pg.ts';
import { SYSTEM_SCHEMA_FILTER, sizeOf } from './introspect.ts';
import { quoteIdent } from './sql.ts';
import {
	MB,
	XID_LIMIT,
	UNUSED_INDEX_MIN_BYTES,
	bloatSeverity,
	cacheHitSeverity,
	checkInfo,
	checksFor,
	connectionSeverity,
	fkHasIndex,
	humanBytes,
	humanDuration,
	missingIndexSeverity,
	percent,
	redundantIndexes,
	sequenceSeverity,
	sequenceUsage,
	transactionAgeSeverity,
	unusedIndexSeverity,
	vacuumIssue,
	wraparoundSeverity,
	type CheckResult,
	type Finding,
	type HealthReport,
	type IndexShape
} from '#lib/health.ts';

type Row = Record<string, unknown>;
type Query = <T extends Row = Row>(text: string, values?: unknown[]) => Promise<T[]>;
export type CheckOutcome = Omit<CheckResult, 'id' | 'title' | 'durationMs'>;

/** Per-check budget: long enough for a big catalog, short enough that the tab stays snappy. */
export const CHECK_TIMEOUT_MS = 10_000;
/** Don't queue behind someone's ACCESS EXCLUSIVE lock (a migration, VACUUM FULL …). */
export const CHECK_LOCK_TIMEOUT_MS = 1000;
/** Findings per check; the rest are counted as truncated. */
export const MAX_FINDINGS = 25;

const num = (v: unknown) => (v == null ? 0 : Number(v));
const qname = (schema: string, name: string) => `${quoteIdent(schema)}.${quoteIdent(name)}`;
const dname = (schema: string, name: string) => `${schema}.${name}`;

/** Findings in severity order, capped. */
export function finish(findings: Finding[], extra: Partial<CheckOutcome> = {}): CheckOutcome {
	const rank = { critical: 3, warn: 2, info: 1 } as const;
	const sorted = [...findings].sort((a, b) => rank[b.severity] - rank[a.severity]);
	return {
		status: sorted.length ? 'findings' : 'ok',
		findings: sorted.slice(0, MAX_FINDINGS),
		truncated: sorted.length > MAX_FINDINGS || undefined,
		...extra
	};
}

async function runCheck(id: string, checkId: string, fn: (q: Query) => Promise<CheckOutcome>): Promise<CheckResult> {
	const started = performance.now();
	const title = checkInfo(checkId)?.title ?? checkId;
	try {
		const outcome = await withClient(id, { readOnly: true, timeoutMs: CHECK_TIMEOUT_MS, lockTimeoutMs: CHECK_LOCK_TIMEOUT_MS }, (client: pg.PoolClient) => {
			const q: Query = async (text, values = []) => (await client.query({ text, values, types: typeParsers })).rows;
			return fn(q);
		});
		return { id: checkId, title, ...outcome, durationMs: Math.round(performance.now() - started) };
	} catch (err) {
		return { id: checkId, title, status: 'error', findings: [], error: toQueryError(err).message, durationMs: Math.round(performance.now() - started) };
	}
}

// --- checks ---------------------------------------------------------------------------

async function statsResetDays(q: Query): Promise<{ days: number | null; at: string | null }> {
	const [r] = await q(
		`select to_json(stats_reset) as at, extract(epoch from now() - stats_reset)::float8 / 86400 as days
		 from pg_stat_database where datname = current_database()`
	);
	return { days: r?.days == null ? null : Number(r.days), at: (r?.at as string) ?? null };
}

const unusedIndexes = async (q: Query): Promise<CheckOutcome> => {
	const reset = await statsResetDays(q);
	const rows = await q(
		`select * from (
			select s.schemaname as schema, s.relname as table, s.indexrelname as name,
				${sizeOf('s.indexrelid', 'pg_relation_size')} as bytes, pg_get_indexdef(s.indexrelid) as def
			from pg_stat_user_indexes s
			join pg_index i on i.indexrelid = s.indexrelid
			where s.idx_scan = 0 and not i.indisunique and not i.indisprimary and i.indisvalid
				and not exists (select 1 from pg_constraint c where c.conindid = s.indexrelid)
		 ) t where bytes >= $1 order by bytes desc limit 200`,
		[UNUSED_INDEX_MIN_BYTES]
	);
	const since = reset.at ? `since statistics were last reset ${humanDuration((reset.days ?? 0) * 86400)} ago` : 'since statistics were last reset';
	const findings: Finding[] = [];
	for (const r of rows) {
		const bytes = num(r.bytes);
		const sev = unusedIndexSeverity(bytes, reset.days);
		if (!sev) continue;
		findings.push({
			severity: sev,
			title: `${r.name} on ${r.schema}.${r.table} has never been scanned`,
			explanation: `This ${humanBytes(bytes)} index hasn’t been used by a single query ${since}, but every insert and update still has to maintain it. Usage is counted per server, so check read replicas (and rare jobs like month-end reports) before dropping it.`,
			objects: [dname(String(r.schema), String(r.name))],
			fix: `-- ${r.def}\n-- Keep the definition above if you might need to recreate it.\nDROP INDEX CONCURRENTLY ${qname(String(r.schema), String(r.name))};`
		});
	}
	const note = reset.at ? `Index usage counted since ${reset.at.slice(0, 10)} (statistics reset).` : 'Index usage counted since the statistics were last reset.';
	return finish(findings, { note });
};

/** Every index on user tables in a comparable shape (key columns only, no INCLUDE columns). */
async function indexShapes(q: Query): Promise<(IndexShape & { valid: boolean })[]> {
	const rows = await q(
		`select n.nspname as schema, t.relname as table, ic.relname as name, i.indisunique as unique, i.indisprimary as primary,
			i.indisvalid as valid, am.amname as method, pg_get_expr(i.indpred, i.indrelid) as predicate,
			${sizeOf('i.indexrelid', 'pg_relation_size')} as bytes,
			to_json(array(select coalesce(a.attname::text, pg_get_indexdef(i.indexrelid, k.ord::int, true))
				|| case when i.indoption[k.ord - 1] & 1 = 1 then ' desc' else '' end
				from unnest(i.indkey::int2[]) with ordinality k(num, ord)
				left join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.num and k.num > 0
				where k.ord <= i.indnkeyatts order by k.ord)) as columns
		 from pg_index i
		 join pg_class ic on ic.oid = i.indexrelid
		 join pg_class t on t.oid = i.indrelid
		 join pg_namespace n on n.oid = t.relnamespace
		 join pg_am am on am.oid = ic.relam
		 where t.relkind in ('r', 'm', 'p') and ${SYSTEM_SCHEMA_FILTER}`
	);
	return rows.map((r) => ({
		schema: String(r.schema),
		table: String(r.table),
		name: String(r.name),
		unique: r.unique === true,
		primary: r.primary === true,
		valid: r.valid === true,
		method: String(r.method),
		predicate: (r.predicate as string) ?? null,
		bytes: num(r.bytes),
		columns: (r.columns as string[]) ?? []
	}));
}

const duplicateIndexes = async (q: Query): Promise<CheckOutcome> => {
	const shapes = (await indexShapes(q)).filter((i) => i.valid);
	const findings = redundantIndexes(shapes).map(({ index: a, coveredBy: b, exact }): Finding => ({
		severity: (a.bytes ?? 0) >= 100 * MB ? 'warn' : 'info',
		title: exact ? `${a.name} duplicates ${b.name}` : `${a.name} is covered by ${b.name}`,
		explanation: exact
			? `Both indexes on ${a.schema}.${a.table} index (${a.columns.join(', ')}). The duplicate (${humanBytes(a.bytes ?? 0)}) is never needed — the other one serves the same queries — but writes keep paying for it.`
			: `${a.name} indexes (${a.columns.join(', ')}), which are the leading columns of ${b.name} (${b.columns.join(', ')}). Postgres can use the longer index for the same lookups, so ${a.name} (${humanBytes(a.bytes ?? 0)}) is usually redundant. Keep it if the narrower index is much smaller and hot.`,
		objects: [dname(a.schema, a.name), dname(b.schema, b.name)],
		fix: `DROP INDEX CONCURRENTLY ${qname(a.schema, a.name)};`
	}));
	return finish(findings);
};

const missingIndexes = async (q: Query): Promise<CheckOutcome> => {
	const rows = await q(
		`select schemaname as schema, relname as table, seq_scan, seq_tup_read, coalesce(idx_scan, 0) as idx_scan, n_live_tup as live
		 from pg_stat_user_tables
		 where seq_scan >= 50 and n_live_tup >= 10000
		 order by seq_tup_read desc limit 100`
	);
	const findings: Finding[] = [];
	for (const r of rows) {
		const s = { seqScan: num(r.seq_scan), seqTupRead: num(r.seq_tup_read), idxScan: num(r.idx_scan), liveRows: num(r.live) };
		const sev = missingIndexSeverity(s);
		if (!sev) continue;
		const perScan = Math.round(s.seqTupRead / s.seqScan);
		findings.push({
			severity: sev,
			title: `${r.schema}.${r.table} is mostly read by full table scans`,
			explanation: `${s.seqScan.toLocaleString('en-US')} sequential scans read about ${perScan.toLocaleString('en-US')} rows each (the table has ~${s.liveRows.toLocaleString('en-US')}), against ${s.idxScan.toLocaleString('en-US')} index scans. If those scans filter on a few columns, an index could make them much cheaper. This is a heuristic: reporting queries that really need every row are fine as they are.`,
			objects: [dname(String(r.schema), String(r.table))],
			fix: `-- Find the queries behind these scans (pg_stat_statements helps), then index the columns they filter on, e.g.:\n-- CREATE INDEX CONCURRENTLY ON ${qname(String(r.schema), String(r.table))} (some_column);`
		});
	}
	return finish(findings);
};

/**
 * Table bloat estimate after the widely used pgsql-bloat-estimation query
 * (ioguix): expected pages from row count, average row width (pg_stats) and
 * fillfactor versus actual pages. Approximate; tables without statistics are skipped.
 */
export const BLOAT_SQL = `select schema, name, bs * tblpages as real_size,
	case when tblpages - est_tblpages_ff > 0 then (tblpages - est_tblpages_ff) * bs else 0 end as bloat_size,
	case when tblpages > 0 and tblpages - est_tblpages_ff > 0 then (tblpages - est_tblpages_ff) / tblpages::float8 else 0 end as bloat_ratio,
	fillfactor, is_na
from (
	select ceil(reltuples / ((bs - page_hdr) * fillfactor / (tpl_size * 100))) + ceil(toasttuples / 4) as est_tblpages_ff,
		tblpages, fillfactor, bs, schema, name, is_na
	from (
		select (4 + tpl_hdr_size + tpl_data_size + (2 * ma)
				- case when tpl_hdr_size % ma = 0 then ma else tpl_hdr_size % ma end
				- case when ceil(tpl_data_size)::int % ma = 0 then ma else ceil(tpl_data_size)::int % ma end) as tpl_size,
			(heappages + toastpages) as tblpages, reltuples, toasttuples, bs, page_hdr, schema, name, fillfactor, is_na
		from (
			select ns.nspname as schema, tbl.relname as name, tbl.reltuples, tbl.relpages as heappages,
				coalesce(toast.relpages, 0) as toastpages, coalesce(toast.reltuples, 0) as toasttuples,
				coalesce(substring(array_to_string(tbl.reloptions, ' ') from 'fillfactor=([0-9]+)')::smallint, 100) as fillfactor,
				current_setting('block_size')::numeric as bs,
				case when version() ~ 'mingw32' or version() ~ '64-bit|x86_64|ppc64|ia64|amd64|aarch64|arm64' then 8 else 4 end as ma,
				24 as page_hdr,
				23 + case when max(coalesce(s.null_frac, 0)) > 0 then (7 + count(s.attname)) / 8 else 0::int end as tpl_hdr_size,
				sum((1 - coalesce(s.null_frac, 0)) * coalesce(s.avg_width, 0)) as tpl_data_size,
				bool_or(att.atttypid = 'pg_catalog.name'::regtype) or sum(case when att.attnum > 0 then 1 else 0 end) <> count(s.attname) as is_na
			from pg_attribute att
			join pg_class tbl on att.attrelid = tbl.oid
			join pg_namespace ns on ns.oid = tbl.relnamespace
			left join pg_stats s on s.schemaname = ns.nspname and s.tablename = tbl.relname and s.inherited = false and s.attname = att.attname
			left join pg_class toast on tbl.reltoastrelid = toast.oid
			where not att.attisdropped and att.attnum > 0 and tbl.relkind in ('r', 'm') and tbl.relpages > 0 and tbl.reltuples >= 0
				and ns.nspname not in ('pg_catalog', 'information_schema') and ns.nspname not like 'pg\\_toast%'
			group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
		) s
	) s2
) s3
where not is_na
order by bloat_size desc
limit 100`;

const bloat = async (q: Query): Promise<CheckOutcome> => {
	const rows = await q(BLOAT_SQL);
	const findings: Finding[] = [];
	for (const r of rows) {
		const wasted = num(r.bloat_size);
		const ratio = num(r.bloat_ratio);
		const sev = bloatSeverity(wasted, ratio);
		if (!sev) continue;
		const t = qname(String(r.schema), String(r.name));
		findings.push({
			severity: sev,
			title: `${r.schema}.${r.name}: roughly ${percent(ratio)} bloat (estimate)`,
			explanation: `The table takes ${humanBytes(num(r.real_size))} on disk, about ${humanBytes(wasted)} more than its rows should need. This is an estimate from planner statistics, not a measurement. Dead rows that VACUUM has cleaned leave reusable space behind; only a rewrite (VACUUM FULL, CLUSTER or pg_repack) returns it to the operating system.`,
			objects: [dname(String(r.schema), String(r.name))],
			fix: `-- Makes the space reusable and refreshes statistics (no long locks):\nVACUUM (VERBOSE, ANALYZE) ${t};\n-- Returns space to the OS but locks the table (ACCESS EXCLUSIVE) for the whole rewrite:\n-- VACUUM FULL ${t};\n-- pg_repack does the same online, if the extension is installed.`
		});
	}
	return finish(findings, { note: 'Estimated from statistics (pgstattuple-free); run ANALYZE first for better numbers.' });
};

const vacuum = async (q: Query): Promise<CheckOutcome> => {
	const [settings] = await q(`select current_setting('autovacuum') as autovacuum, current_setting('track_counts') as track_counts`);
	const rows = await q(
		`select schemaname as schema, relname as table, n_live_tup as live, n_dead_tup as dead, n_mod_since_analyze as mods,
			extract(epoch from now() - greatest(last_vacuum, last_autovacuum))::float8 / 86400 as vacuum_days,
			extract(epoch from now() - greatest(last_analyze, last_autoanalyze))::float8 / 86400 as analyze_days
		 from pg_stat_user_tables
		 where n_live_tup + n_dead_tup >= 1000
		 order by n_dead_tup desc limit 300`
	);
	const findings: Finding[] = [];
	if (settings?.autovacuum === 'off') {
		findings.push({
			severity: 'warn',
			title: 'Autovacuum is turned off',
			explanation: 'Without autovacuum, dead rows pile up, statistics go stale and — most dangerously — old transaction IDs never get frozen. Unless something else runs VACUUM on a schedule, turn it back on.',
			objects: ['autovacuum'],
			fix: `ALTER SYSTEM SET autovacuum = on;\nSELECT pg_reload_conf();`
		});
	}
	for (const r of rows) {
		const issue = vacuumIssue({
			live: num(r.live),
			dead: num(r.dead),
			vacuumAgeDays: r.vacuum_days == null ? null : Number(r.vacuum_days),
			analyzeAgeDays: r.analyze_days == null ? null : Number(r.analyze_days),
			modsSinceAnalyze: num(r.mods)
		});
		if (!issue) continue;
		const t = qname(String(r.schema), String(r.table));
		const needsVacuum = issue.reasons.some((x) => /dead|vacuum/.test(x));
		findings.push({
			severity: issue.severity,
			title: `${r.schema}.${r.table}: ${issue.reasons.join(', ')}`,
			explanation: `${num(r.live).toLocaleString('en-US')} live and ${num(r.dead).toLocaleString('en-US')} dead rows. Dead rows are left by updates and deletes until VACUUM cleans them; they slow scans and bloat the table. Stale statistics (ANALYZE) lead the planner to bad plans. If autovacuum keeps falling behind here, consider lowering this table’s autovacuum_vacuum_scale_factor.`,
			objects: [dname(String(r.schema), String(r.table))],
			fix: needsVacuum ? `VACUUM (VERBOSE, ANALYZE) ${t};` : `ANALYZE ${t};`
		});
	}
	const note = settings?.track_counts === 'off' ? 'track_counts is off, so table statistics aren’t collected.' : undefined;
	return finish(findings, { note });
};

const wraparound = async (q: Query): Promise<CheckOutcome> => {
	const dbs = await q(`select datname as name, age(datfrozenxid)::float8 as age from pg_database where datallowconn order by 2 desc`);
	const tables = await q(
		`select n.nspname as schema, c.relname as name, c.relkind as kind, age(c.relfrozenxid)::float8 as age,
			t.relname as owner_table, tn.nspname as owner_schema
		 from pg_class c join pg_namespace n on n.oid = c.relnamespace
		 left join pg_class t on c.relkind = 't' and t.reltoastrelid = c.oid
		 left join pg_namespace tn on tn.oid = t.relnamespace
		 where c.relkind in ('r', 'm', 't') and c.relfrozenxid <> '0'
		 order by 4 desc limit 10`
	);
	const findings: Finding[] = [];
	for (const d of dbs) {
		const age = num(d.age);
		const sev = wraparoundSeverity(age);
		if (!sev) continue;
		findings.push({
			severity: sev,
			title: `Database ${d.name} has used ${percent(age / XID_LIMIT)} of its transaction IDs`,
			explanation: `Postgres numbers transactions with 32-bit IDs and must "freeze" old rows before about 2.1 billion IDs go by. This database’s oldest unfrozen row is ${age.toLocaleString('en-US')} transactions old. If nothing freezes it, Postgres eventually stops accepting writes to protect your data. Autovacuum normally handles this; long transactions, stale replication slots or abandoned prepared transactions can hold it back.`,
			objects: [String(d.name)],
			fix: `-- In database ${d.name}, freeze the oldest tables (see the list in this check) or the whole database:\nVACUUM (FREEZE, VERBOSE);`
		});
	}
	for (const t of tables) {
		const age = num(t.age);
		const sev = wraparoundSeverity(age);
		if (!sev) continue;
		const schema = String(t.owner_schema ?? t.schema);
		const name = String(t.owner_table ?? t.name);
		findings.push({
			severity: sev,
			title: `${schema}.${name} needs freezing (${percent(age / XID_LIMIT)} of the limit)`,
			explanation: `The oldest unfrozen row${t.kind === 't' ? ' in this table’s TOAST data' : ''} is ${age.toLocaleString('en-US')} transactions old. A VACUUM FREEZE on this table resets it.`,
			objects: [dname(schema, name)],
			fix: `VACUUM (FREEZE, VERBOSE) ${qname(schema, name)};`
		});
	}
	const oldest = dbs[0];
	const note = oldest ? `Oldest database: ${oldest.name} at ${percent(num(oldest.age) / XID_LIMIT, 1)} of the limit.` : undefined;
	return finish(findings, { note });
};

const sequences = async (q: Query): Promise<CheckOutcome> => {
	const rows = await q(
		`select s.schemaname as schema, s.sequencename as name, s.data_type::text as type, s.last_value, s.min_value, s.max_value,
			s.increment_by, s.cycle, col.tbl_schema, col.tbl_name, col.col_name, col.col_type
		 from pg_sequences s
		 left join lateral (
			select tn.nspname as tbl_schema, t.relname as tbl_name, a.attname as col_name, format_type(a.atttypid, null) as col_type
			from pg_class sc
			join pg_namespace sn on sn.oid = sc.relnamespace
			join pg_depend d on d.objid = sc.oid and d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')
			join pg_class t on t.oid = d.refobjid
			join pg_namespace tn on tn.oid = t.relnamespace
			join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
			where sn.nspname = s.schemaname and sc.relname = s.sequencename
			limit 1
		 ) col on true
		 where s.last_value is not null and not s.cycle`
	);
	const findings: Finding[] = [];
	for (const r of rows) {
		const usage = sequenceUsage({
			last: num(r.last_value),
			min: num(r.min_value),
			max: num(r.max_value),
			increment: num(r.increment_by),
			columnType: (r.col_type as string) ?? null
		});
		const sev = sequenceSeverity(usage);
		if (!sev) continue;
		const seq = qname(String(r.schema), String(r.name));
		const column = r.col_name ? `${r.tbl_schema}.${r.tbl_name}.${r.col_name}` : null;
		const narrowColumn = r.col_type && r.col_type !== 'bigint';
		const fix = [
			narrowColumn
				? `-- Widen the column first (rewrites the table and locks it while it runs):\nALTER TABLE ${qname(String(r.tbl_schema), String(r.tbl_name))} ALTER COLUMN ${quoteIdent(String(r.col_name))} TYPE bigint;`
				: null,
			r.type !== 'bigint' ? `ALTER SEQUENCE ${seq} AS bigint;` : `-- Already bigint: raise MAXVALUE if it was lowered, e.g.\n-- ALTER SEQUENCE ${seq} MAXVALUE 9223372036854775807;`
		]
			.filter(Boolean)
			.join('\n');
		findings.push({
			severity: sev,
			title: `${r.schema}.${r.name} has used ${percent(usage)} of its values`,
			explanation: `The sequence is at ${num(r.last_value).toLocaleString('en-US')}${column ? ` and fills ${column} (${r.col_type})` : ''}. When it runs out, every insert that needs a new value fails with “reached maximum value of sequence”.`,
			objects: column ? [dname(String(r.schema), String(r.name)), column] : [dname(String(r.schema), String(r.name))],
			fix
		});
	}
	return finish(findings, { note: rows.length ? undefined : 'Only sequences this role may read are checked.' });
};

const invalidIndexes = async (q: Query): Promise<CheckOutcome> => {
	const rows = await q(
		`select n.nspname as schema, ic.relname as name, t.relname as table, pg_get_indexdef(i.indexrelid) as def
		 from pg_index i
		 join pg_class ic on ic.oid = i.indexrelid
		 join pg_class t on t.oid = i.indrelid
		 join pg_namespace n on n.oid = ic.relnamespace
		 where not i.indisvalid and ${SYSTEM_SCHEMA_FILTER}`
	);
	const findings = rows.map((r): Finding => ({
		severity: 'warn',
		title: `${r.schema}.${r.name} is invalid`,
		explanation: `A CREATE INDEX CONCURRENTLY (or REINDEX CONCURRENTLY) on ${r.schema}.${r.table} failed part-way. The planner ignores this index, yet writes still maintain it. Rebuild it, or drop it if it’s no longer wanted.`,
		objects: [dname(String(r.schema), String(r.name))],
		fix: `REINDEX INDEX CONCURRENTLY ${qname(String(r.schema), String(r.name))};\n-- or drop it and recreate from the definition:\n-- DROP INDEX CONCURRENTLY ${qname(String(r.schema), String(r.name))};\n-- ${r.def};`
	}));
	return finish(findings);
};

const idleInTransaction = async (q: Query): Promise<CheckOutcome> => {
	const rows = await q(
		`select pid, usename as user, datname as database, application_name as app, state,
			extract(epoch from clock_timestamp() - state_change)::float8 as idle_seconds,
			left(query, 200) as query
		 from pg_stat_activity
		 where state in ('idle in transaction', 'idle in transaction (aborted)') and pid <> pg_backend_pid()
		 order by state_change limit 100`
	);
	const [timeout] = await q(`select current_setting('idle_in_transaction_session_timeout') as v, current_database() as db`);
	const findings: Finding[] = [];
	for (const r of rows) {
		const seconds = num(r.idle_seconds);
		const sev = transactionAgeSeverity(seconds);
		if (!sev || sev === 'info') continue;
		findings.push({
			severity: sev,
			title: `Session ${r.pid} has been idle in a transaction for ${humanDuration(seconds)}`,
			explanation: `${r.user ?? 'A client'}${r.app ? ` (${r.app})` : ''} opened a transaction on ${r.database ?? 'the server'} and stopped sending queries without committing. While it’s open, VACUUM can’t remove rows that changed since it began, and any locks it took stay held. Usually an application bug or a forgotten interactive session. Last query: ${String(r.query ?? '').replace(/\s+/g, ' ').trim() || '(hidden)'}`,
			objects: [`pid ${r.pid}`],
			fix: `SELECT pg_terminate_backend(${Number(r.pid)});\n-- Stop this recurring automatically (pick a limit that suits your apps):\n-- ALTER DATABASE ${quoteIdent(String(r.database ?? timeout?.db ?? 'postgres'))} SET idle_in_transaction_session_timeout = '15min';`
		});
	}
	const note = timeout?.v && timeout.v !== '0' ? `idle_in_transaction_session_timeout is ${timeout.v}.` : 'Only sessions this role may see are checked (pg_read_all_stats shows all).';
	return finish(findings, { note });
};

const cacheHit = async (q: Query): Promise<CheckOutcome> => {
	const [r] = await q(
		`select sum(blks_hit)::float8 as hit, sum(blks_read)::float8 as read, current_setting('shared_buffers') as shared_buffers
		 from pg_stat_database where datname = current_database()`
	);
	const hit = num(r?.hit);
	const read = num(r?.read);
	const total = hit + read;
	const ratio = total > 0 ? hit / total : null;
	const sev = cacheHitSeverity(ratio, total);
	const findings: Finding[] = [];
	if (sev && ratio != null) {
		findings.push({
			severity: sev,
			title: `Cache hit ratio is ${percent(ratio, 1)}`,
			explanation: `Only ${percent(ratio, 1)} of block reads in this database were served from shared_buffers (${r?.shared_buffers}); the rest came from the OS page cache or disk. Busy OLTP databases usually sit above 99%. A lower number can be fine for large analytical scans, but if it’s your everyday workload, more memory (shared_buffers, or simply RAM for the OS cache) helps.`,
			objects: ['shared_buffers'],
			fix: `-- Check the current value, then raise it (needs a restart), e.g. to ~25% of RAM:\nSHOW shared_buffers;\n-- ALTER SYSTEM SET shared_buffers = '2GB';`
		});
	}
	return finish(findings, { note: ratio == null ? 'Not enough reads yet to judge.' : `Hit ratio ${percent(ratio, 2)} over ${total.toLocaleString('en-US')} block reads.` });
};

const connections = async (q: Query): Promise<CheckOutcome> => {
	const [r] = await q(
		`select current_setting('max_connections')::int as max,
			current_setting('superuser_reserved_connections')::int + coalesce(current_setting('reserved_connections', true), '0')::int as reserved,
			(select count(*) from pg_stat_activity where backend_type = 'client backend')::int as used`
	);
	const max = num(r?.max);
	const usable = Math.max(1, max - num(r?.reserved));
	const used = num(r?.used);
	const sev = connectionSeverity(used, usable);
	const findings: Finding[] = [];
	if (sev) {
		findings.push({
			severity: sev,
			title: `${used} of ${usable} connections in use`,
			explanation: `Client connections are at ${percent(used / usable)} of what ordinary roles can open (max_connections ${max} minus ${num(r?.reserved)} reserved). When they run out, new clients get “too many clients already”. Each Postgres connection is a process; a pooler such as PgBouncer is usually a better fix than raising the limit.`,
			objects: ['max_connections'],
			fix: `-- Who holds the connections?\nSELECT usename, application_name, state, count(*) FROM pg_stat_activity GROUP BY 1, 2, 3 ORDER BY 4 DESC;\n-- Raising the limit needs a restart:\n-- ALTER SYSTEM SET max_connections = ${Math.max(max * 2, 200)};`
		});
	}
	return finish(findings, { note: `${used} of ${usable} usable connections (max_connections ${max}).` });
};

const primaryKeys = async (q: Query): Promise<CheckOutcome> => {
	const rows = await q(
		`select n.nspname as schema, c.relname as name, greatest(c.reltuples, 0)::bigint as rows,
			exists (select 1 from pg_index i where i.indrelid = c.oid and i.indisunique and i.indpred is null and i.indexprs is null
				and not exists (select 1 from unnest(i.indkey::int2[]) k(num) join pg_attribute a on a.attrelid = c.oid and a.attnum = k.num where not a.attnotnull)) as has_unique
		 from pg_class c join pg_namespace n on n.oid = c.relnamespace
		 where c.relkind in ('r', 'p') and not c.relispartition and ${SYSTEM_SCHEMA_FILTER}
			and not exists (select 1 from pg_constraint con where con.conrelid = c.oid and con.contype = 'p')
			and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
		 order by 3 desc limit 200`
	);
	const findings = rows.map((r): Finding => {
		const t = qname(String(r.schema), String(r.name));
		return {
			severity: r.has_unique === true ? 'info' : num(r.rows) >= 10_000 ? 'warn' : 'info',
			title: `${r.schema}.${r.name} has no primary key`,
			explanation: `Without a primary key, rows can’t be addressed reliably: duplicates can creep in, tools (including row editing) can’t update a single row safely, and logical replication can’t replicate updates or deletes.${r.has_unique === true ? ' It does have a unique index on NOT NULL columns, which could be promoted to the primary key.' : ''}`,
			objects: [dname(String(r.schema), String(r.name))],
			fix:
				r.has_unique === true
					? `-- Promote the existing unique index (find its name in the table’s Structure view):\n-- ALTER TABLE ${t} ADD CONSTRAINT ${quoteIdent(`${r.name}_pkey`)} PRIMARY KEY USING INDEX some_unique_index;`
					: `-- Either declare the natural key, e.g.\n-- ALTER TABLE ${t} ADD PRIMARY KEY (some_column);\n-- or add a surrogate key (rewrites the table):\n-- ALTER TABLE ${t} ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY;`
		};
	});
	return finish(findings);
};

const fkIndexes = async (q: Query): Promise<CheckOutcome> => {
	const shapes = await indexShapes(q);
	const fks = await q(
		`select con.conname as name, n.nspname as schema, c.relname as table, greatest(c.reltuples, 0)::bigint as rows,
			fn.nspname as ref_schema, fc.relname as ref_table,
			to_json(array(select a.attname::text from unnest(con.conkey) with ordinality k(num, ord)
				join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.num order by k.ord)) as columns
		 from pg_constraint con
		 join pg_class c on c.oid = con.conrelid
		 join pg_namespace n on n.oid = c.relnamespace
		 join pg_class fc on fc.oid = con.confrelid
		 join pg_namespace fn on fn.oid = fc.relnamespace
		 where con.contype = 'f' and con.conparentid = 0 and ${SYSTEM_SCHEMA_FILTER}`
	);
	const byTable = new Map<string, IndexShape[]>();
	for (const s of shapes) {
		if (!s.valid) continue;
		const k = `${s.schema}\u0000${s.table}`;
		if (!byTable.has(k)) byTable.set(k, []);
		byTable.get(k)!.push(s);
	}
	const findings: Finding[] = [];
	for (const fk of fks) {
		const cols = (fk.columns as string[]) ?? [];
		if (fkHasIndex(cols, byTable.get(`${fk.schema}\u0000${fk.table}`) ?? [])) continue;
		const rows = num(fk.rows);
		findings.push({
			severity: rows >= 10_000 ? 'warn' : 'info',
			title: `${fk.schema}.${fk.table} (${cols.join(', ')}) has no index for foreign key ${fk.name}`,
			explanation: `Deleting or updating a row in ${fk.ref_schema}.${fk.ref_table} makes Postgres look up matching rows in ${fk.schema}.${fk.table} (~${rows.toLocaleString('en-US')} rows). Without an index on the referencing columns, every such lookup is a full table scan, and joins on this key are slower too.`,
			objects: [dname(String(fk.schema), String(fk.table))],
			fix: `CREATE INDEX CONCURRENTLY ON ${qname(String(fk.schema), String(fk.table))} (${cols.map(quoteIdent).join(', ')});`
		});
	}
	return finish(findings);
};

const settings = async (q: Query): Promise<CheckOutcome> => {
	const [r] = await q(
		`select current_setting('shared_buffers') as shared_buffers,
			(select setting::bigint * pg_size_bytes(coalesce(unit, '8kB')) from pg_settings where name = 'shared_buffers')::float8 as shared_bytes,
			(select coalesce(sum(case when has_database_privilege(oid, 'CONNECT') then pg_database_size(oid) end), 0) from pg_database)::float8 as total_bytes,
			current_setting('work_mem') as work_mem, current_setting('maintenance_work_mem') as maintenance_work_mem,
			current_setting('random_page_cost') as random_page_cost, current_setting('track_counts') as track_counts`
	);
	const findings: Finding[] = [];
	const shared = num(r?.shared_bytes);
	const total = num(r?.total_bytes);
	if (shared > 0 && shared <= 128 * MB && total >= 2 * shared * 8) {
		findings.push({
			severity: 'info',
			title: `shared_buffers is still the default ${r?.shared_buffers}`,
			explanation: `Your databases add up to ${humanBytes(total)}, but Postgres keeps only ${r?.shared_buffers} of hot data in its own cache. The default is deliberately small; on a dedicated server around 25% of RAM is the usual starting point. Worth a look if the cache hit ratio is low — not urgent otherwise.`,
			objects: ['shared_buffers'],
			fix: `-- Needs a restart; size it to your machine:\n-- ALTER SYSTEM SET shared_buffers = '1GB';`
		});
	}
	if (r?.maintenance_work_mem === '64MB' && total >= 10 * 1024 * MB) {
		findings.push({
			severity: 'info',
			title: 'maintenance_work_mem is the default 64MB',
			explanation: `VACUUM and CREATE INDEX on ${humanBytes(total)} of data go faster with more memory. 256MB–1GB is common when RAM allows.`,
			objects: ['maintenance_work_mem'],
			fix: `-- ALTER SYSTEM SET maintenance_work_mem = '512MB';\n-- SELECT pg_reload_conf();`
		});
	}
	if (r?.track_counts === 'off') {
		findings.push({
			severity: 'warn',
			title: 'track_counts is off',
			explanation: 'Without table statistics autovacuum can’t tell which tables need work, and several checks here (unused indexes, vacuum) have nothing to go on.',
			objects: ['track_counts'],
			fix: `ALTER SYSTEM SET track_counts = on;\nSELECT pg_reload_conf();`
		});
	}
	return finish(findings, { note: `shared_buffers ${r?.shared_buffers}, work_mem ${r?.work_mem}, maintenance_work_mem ${r?.maintenance_work_mem}, random_page_cost ${r?.random_page_cost}.` });
};

const CHECKS: Record<string, (q: Query) => Promise<CheckOutcome>> = {
	wraparound,
	sequences,
	'invalid-indexes': invalidIndexes,
	'idle-in-transaction': idleInTransaction,
	connections,
	'cache-hit': cacheHit,
	vacuum,
	bloat,
	'unused-indexes': unusedIndexes,
	'duplicate-indexes': duplicateIndexes,
	'missing-indexes': missingIndexes,
	'fk-indexes': fkIndexes,
	'primary-keys': primaryKeys,
	settings
};

/**
 * Runs `fn` over `items` with at most `limit` in flight, keeping order. The first item
 * runs alone so the connection pool is opened once rather than by every check at once.
 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	if (!items.length) return out;
	out[0] = await fn(items[0]);
	let next = 1;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length - 1) }, worker));
	return out;
}

export async function health(id: string): Promise<HealthReport> {
	const started = performance.now();
	const checks = await mapLimit(checksFor('postgres'), 3, (c) => runCheck(id, c.id, CHECKS[c.id]));
	return { engine: 'postgres', ranAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started), checks };
}
