/**
 * MySQL / MariaDB health checks, in the same shape as the Postgres ones: read-only
 * queries on the read-only session with a short statement timeout, each check's
 * failure reported inline. Index usage needs performance_schema; when it's off (the
 * MariaDB default) that check says so instead of guessing.
 */
import { quoteIdent, toMysqlError, withConnection } from './client.ts';
import { SYSTEM_DATABASES } from './introspect.ts';
import { CHECK_TIMEOUT_MS, finish, mapLimit, type CheckOutcome } from '../health.ts';
import {
	cacheHitSeverity,
	checkInfo,
	checksFor,
	connectionSeverity,
	fragmentationSeverity,
	humanBytes,
	humanDuration,
	percent,
	redundantIndexes,
	transactionAgeSeverity,
	type CheckResult,
	type Finding,
	type HealthReport,
	type IndexShape
} from '#lib/health.ts';

type Row = Record<string, unknown>;
type Query = (sql: string, values?: unknown[]) => Promise<Row[]>;

const SYSTEM_IN = SYSTEM_DATABASES.map((d) => `'${d}'`).join(', ');
const num = (v: unknown) => (v == null || v === '' ? 0 : Number(v));
const qname = (schema: string, name: string) => `${quoteIdent(schema)}.${quoteIdent(name)}`;
const dname = (schema: string, name: string) => `${schema}.${name}`;

async function runCheck(id: string, checkId: string, fn: (q: Query) => Promise<CheckOutcome>): Promise<CheckResult> {
	const started = performance.now();
	const title = checkInfo(checkId)?.title ?? checkId;
	try {
		const outcome = await withConnection(id, { readOnly: true, timeoutMs: CHECK_TIMEOUT_MS }, (c) => {
			const q: Query = async (sql, values = []) => (await c.query({ sql, values }))[0] as Row[];
			return fn(q);
		});
		return { id: checkId, title, ...outcome, durationMs: Math.round(performance.now() - started) };
	} catch (err) {
		return { id: checkId, title, status: 'error', findings: [], error: toMysqlError(err, {}).message, durationMs: Math.round(performance.now() - started) };
	}
}

async function status(q: Query, names: string[]): Promise<Record<string, number>> {
	const rows = await q(`SHOW GLOBAL STATUS WHERE Variable_name IN (${names.map(() => '?').join(', ')})`, names);
	return Object.fromEntries(rows.map((r) => [String(r.Variable_name ?? r.VARIABLE_NAME), Number(r.Value ?? r.VARIABLE_VALUE)]));
}

const primaryKeys = async (q: Query): Promise<CheckOutcome> => {
	const rows = await q(
		`SELECT t.TABLE_SCHEMA AS \`schema\`, t.TABLE_NAME AS name, t.TABLE_ROWS AS est_rows,
			EXISTS (SELECT 1 FROM information_schema.STATISTICS s WHERE s.TABLE_SCHEMA = t.TABLE_SCHEMA AND s.TABLE_NAME = t.TABLE_NAME AND s.NON_UNIQUE = 0) AS has_unique
		 FROM information_schema.TABLES t
		 WHERE t.TABLE_TYPE = 'BASE TABLE' AND t.TABLE_SCHEMA NOT IN (${SYSTEM_IN})
			AND NOT EXISTS (SELECT 1 FROM information_schema.TABLE_CONSTRAINTS c
				WHERE c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME AND c.CONSTRAINT_TYPE = 'PRIMARY KEY')
		 ORDER BY t.TABLE_ROWS DESC LIMIT 200`
	);
	const findings = rows.map((r): Finding => {
		const schema = String(r.schema);
		const name = String(r.name);
		const unique = num(r.has_unique) === 1;
		return {
			severity: unique ? 'info' : num(r.est_rows) >= 10_000 ? 'warn' : 'info',
			title: `${schema}.${name} has no primary key`,
			explanation: `InnoDB clusters rows by the primary key. Without one it picks ${unique ? 'the first unique NOT NULL index' : 'a hidden internal row id'}, so rows can’t be addressed reliably, row-based replication has to scan the table for every changed row, and tools can’t update a single row safely.`,
			objects: [dname(schema, name)],
			fix: `-- Either declare the natural key, e.g.\n-- ALTER TABLE ${qname(schema, name)} ADD PRIMARY KEY (some_column);\n-- or add a surrogate key (rebuilds the table):\n-- ALTER TABLE ${qname(schema, name)} ADD COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST;`
		};
	});
	return finish(findings);
};

const storageEngines = async (q: Query): Promise<CheckOutcome> => {
	const rows = await q(
		`SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name, ENGINE AS engine, DATA_LENGTH + INDEX_LENGTH AS bytes
		 FROM information_schema.TABLES
		 WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA NOT IN (${SYSTEM_IN}) AND ENGINE IS NOT NULL AND ENGINE <> 'InnoDB'
		 ORDER BY bytes DESC LIMIT 200`
	);
	const findings = rows.map((r): Finding => {
		const engine = String(r.engine);
		const schema = String(r.schema);
		const name = String(r.name);
		const volatile = /^(memory|heap)$/i.test(engine);
		const special = /^(csv|archive|blackhole|federated|connect|sequence|spider|columnstore|rocksdb|s3|mroonga)$/i.test(engine);
		return {
			severity: /^(myisam|aria)$/i.test(engine) ? 'warn' : 'info',
			title: `${schema}.${name} uses ${engine}`,
			explanation: volatile
				? `${engine} tables live only in memory and are emptied when the server restarts. Fine for scratch data; anything you want to keep belongs in InnoDB.`
				: special
					? `${engine} is a special-purpose engine. If that’s deliberate, ignore this; otherwise InnoDB gives you transactions and crash safety.`
					: `${engine} has no transactions, locks the whole table on writes and can be left corrupted by a crash. InnoDB is the default for good reason; converting is usually a one-liner.`,
			objects: [dname(schema, name)],
			fix: `-- Rebuilds the table; check FULLTEXT/SPATIAL index support on old servers first.\nALTER TABLE ${qname(schema, name)} ENGINE = InnoDB;`
		};
	});
	return finish(findings);
};

const unusedIndexes = async (q: Query): Promise<CheckOutcome> => {
	const [ps] = await q('SELECT @@performance_schema AS on_');
	const st = await status(q, ['Uptime']);
	if (num(ps?.on_) !== 1) {
		return {
			status: 'skipped',
			findings: [],
			note: 'performance_schema is off on this server, so index usage isn’t tracked. Enable it (performance_schema = ON in the server config, needs a restart) to get this check.'
		};
	}
	let rows: Row[];
	try {
		rows = await q(
			`SELECT u.OBJECT_SCHEMA AS \`schema\`, u.OBJECT_NAME AS \`table\`, u.INDEX_NAME AS name
			 FROM performance_schema.table_io_waits_summary_by_index_usage u
			 WHERE u.INDEX_NAME IS NOT NULL AND u.INDEX_NAME <> 'PRIMARY' AND u.COUNT_STAR = 0 AND u.OBJECT_SCHEMA NOT IN (${SYSTEM_IN})
				AND EXISTS (SELECT 1 FROM information_schema.STATISTICS s
					WHERE s.TABLE_SCHEMA = u.OBJECT_SCHEMA AND s.TABLE_NAME = u.OBJECT_NAME AND s.INDEX_NAME = u.INDEX_NAME AND s.NON_UNIQUE = 1)
			 ORDER BY 1, 2, 3 LIMIT 200`
		);
	} catch (err) {
		// Some accounts can read the sys schema view but not performance_schema directly.
		try {
			rows = await q(`SELECT object_schema AS \`schema\`, object_name AS \`table\`, index_name AS name FROM sys.schema_unused_indexes WHERE object_schema NOT IN (${SYSTEM_IN}) LIMIT 200`);
		} catch {
			throw err;
		}
	}
	const uptime = st.Uptime ?? 0;
	const findings = rows.map((r): Finding => {
		const schema = String(r.schema);
		const table = String(r.table);
		return {
			severity: 'info',
			title: `${r.name} on ${schema}.${table} hasn’t been used since the server started`,
			explanation: `No query has read through this index in the ${humanDuration(uptime)} since the server last started, but every write still updates it. Counters reset on restart, so rare jobs (monthly reports, backups) may not have run yet — and replicas count separately.`,
			objects: [dname(schema, String(r.name))],
			fix: `ALTER TABLE ${qname(schema, table)} DROP INDEX ${quoteIdent(String(r.name))};`
		};
	});
	return finish(findings, { note: `Usage counted by performance_schema since the server started ${humanDuration(uptime)} ago.${uptime < 7 * 86400 ? ' That’s recent — give it a while before trusting this list.' : ''}` });
};

const duplicateIndexes = async (q: Query): Promise<CheckOutcome> => {
	const rows = await q(
		`SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS \`table\`, INDEX_NAME AS name, NON_UNIQUE AS non_unique, INDEX_TYPE AS method,
			SEQ_IN_INDEX AS seq, COLUMN_NAME AS col, SUB_PART AS sub_part, \`COLLATION\` AS coll
		 FROM information_schema.STATISTICS
		 WHERE TABLE_SCHEMA NOT IN (${SYSTEM_IN})
		 ORDER BY 1, 2, 3, SEQ_IN_INDEX`
	);
	const shapes = new Map<string, IndexShape>();
	for (const r of rows) {
		const key = `${r.schema}\u0000${r.table}\u0000${r.name}`;
		let s = shapes.get(key);
		if (!s) {
			s = {
				schema: String(r.schema),
				table: String(r.table),
				name: String(r.name),
				unique: num(r.non_unique) === 0,
				primary: r.name === 'PRIMARY',
				method: String(r.method ?? 'BTREE').toLowerCase(),
				columns: []
			};
			shapes.set(key, s);
		}
		const column = r.col == null ? '(expression)' : String(r.col);
		s.columns.push(`${column}${r.sub_part != null ? `(${r.sub_part})` : ''}${r.coll === 'D' ? ' desc' : ''}`);
	}
	const usable = [...shapes.values()].filter((s) => !s.columns.includes('(expression)'));
	const findings = redundantIndexes(usable).map(({ index: a, coveredBy: b, exact }): Finding => ({
		severity: 'info',
		title: exact ? `${a.name} duplicates ${b.name}` : `${a.name} is covered by ${b.name}`,
		explanation: exact
			? `Both indexes on ${a.schema}.${a.table} index (${a.columns.join(', ')}). One of them is enough; the other only slows writes and takes space.`
			: `${a.name} indexes (${a.columns.join(', ')}), the leading columns of ${b.name} (${b.columns.join(', ')}). The longer index serves the same lookups (including foreign key checks), so ${a.name} is usually redundant.`,
		objects: [dname(a.schema, a.name), dname(b.schema, b.name)],
		fix: `ALTER TABLE ${qname(a.schema, a.table)} DROP INDEX ${quoteIdent(a.name)};`
	}));
	return finish(findings);
};

const fragmentation = async (q: Query): Promise<CheckOutcome> => {
	const [v] = await q('SELECT @@innodb_file_per_table AS fpt');
	const rows = await q(
		`SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name, ENGINE AS engine, DATA_LENGTH + INDEX_LENGTH AS used, DATA_FREE AS free
		 FROM information_schema.TABLES
		 WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA NOT IN (${SYSTEM_IN}) AND DATA_FREE > 0
		 ORDER BY DATA_FREE DESC LIMIT 200`
	);
	// In a shared tablespace every table reports the tablespace's free space; that says nothing per table.
	const counts = new Map<number, number>();
	for (const r of rows) if (String(r.engine) === 'InnoDB') counts.set(num(r.free), (counts.get(num(r.free)) ?? 0) + 1);
	const findings: Finding[] = [];
	for (const r of rows) {
		const free = num(r.free);
		if (String(r.engine) === 'InnoDB' && (num(v?.fpt) !== 1 || (counts.get(free) ?? 0) > 3)) continue;
		const sev = fragmentationSeverity(free, num(r.used));
		if (!sev) continue;
		const schema = String(r.schema);
		const name = String(r.name);
		findings.push({
			severity: sev,
			title: `${schema}.${name} has ${humanBytes(free)} of free space inside its file`,
			explanation: `Deleted rows left ${humanBytes(free)} unused in a table that holds ${humanBytes(num(r.used))} of data and indexes. New rows reuse that space, so it’s only worth reclaiming if the table won’t grow back. These figures come from information_schema and can be cached for up to a day (information_schema_stats_expiry).`,
			objects: [dname(schema, name)],
			fix: `-- Rebuilds the table (online for InnoDB, but needs free disk space for a full copy):\nOPTIMIZE TABLE ${qname(schema, name)};`
		});
	}
	return finish(findings, { note: num(v?.fpt) === 1 ? undefined : 'innodb_file_per_table is off, so InnoDB free space is shared and not reported per table.' });
};

const connections = async (q: Query): Promise<CheckOutcome> => {
	const [v] = await q('SELECT @@max_connections AS max');
	const st = await status(q, ['Threads_connected', 'Max_used_connections']);
	const max = num(v?.max);
	const used = st.Threads_connected ?? 0;
	const peak = st.Max_used_connections ?? 0;
	const sev = connectionSeverity(used, max) ?? (connectionSeverity(peak, max) === 'critical' ? 'info' : null);
	const findings: Finding[] = [];
	if (sev) {
		findings.push({
			severity: sev,
			title: used / max >= 0.75 ? `${used} of ${max} connections in use` : `Connections peaked at ${peak} of ${max}`,
			explanation: `When all ${max} connections are taken, new clients get “Too many connections”. ${used} are open now and the peak since startup was ${peak}. Look for apps with oversized pools or leaked connections before raising max_connections.`,
			objects: ['max_connections'],
			fix: `-- Who holds the connections?\nSELECT USER, HOST, DB, COMMAND, COUNT(*) FROM information_schema.PROCESSLIST GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC;\n-- SET GLOBAL max_connections = ${Math.max(max * 2, 300)};  -- also set it in the config file to survive restarts`
		});
	}
	return finish(findings, { note: `${used} of ${max} connections in use; peak ${peak} since startup.` });
};

const cacheHit = async (q: Query): Promise<CheckOutcome> => {
	const st = await status(q, ['Innodb_buffer_pool_reads', 'Innodb_buffer_pool_read_requests']);
	const [v] = await q(
		`SELECT @@innodb_buffer_pool_size AS pool, (SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) FROM information_schema.TABLES WHERE ENGINE = 'InnoDB') AS data`
	);
	const requests = st.Innodb_buffer_pool_read_requests ?? 0;
	const reads = st.Innodb_buffer_pool_reads ?? 0;
	const ratio = requests > 0 ? 1 - reads / requests : null;
	const sev = cacheHitSeverity(ratio, requests);
	const pool = num(v?.pool);
	const data = num(v?.data);
	const findings: Finding[] = [];
	if (sev && ratio != null) {
		findings.push({
			severity: sev,
			title: `Buffer pool hit rate is ${percent(ratio, 1)}`,
			explanation: `${percent(1 - ratio, 1)} of InnoDB page reads had to go to disk. The buffer pool is ${humanBytes(pool)} for ${humanBytes(data)} of InnoDB data and indexes. On a dedicated database server, giving the buffer pool 50–70% of RAM is typical.`,
			objects: ['innodb_buffer_pool_size'],
			fix: `-- Resizable online on MySQL 5.7+ / MariaDB 10.2+; also set it in the config file:\n-- SET GLOBAL innodb_buffer_pool_size = ${Math.max(pool * 2, 1024 ** 3)};`
		});
	}
	return finish(findings, {
		note: ratio == null ? 'Not enough reads yet to judge.' : `Hit rate ${percent(ratio, 2)}; buffer pool ${humanBytes(pool)} for ${humanBytes(data)} of InnoDB data.`
	});
};

const longTransactions = async (q: Query): Promise<CheckOutcome> => {
	const rows = await q(
		`SELECT t.trx_mysql_thread_id AS thread, TIMESTAMPDIFF(SECOND, t.trx_started, NOW()) AS seconds, t.trx_state AS state,
			t.trx_rows_modified AS modified, t.trx_rows_locked AS locked, p.USER AS user, p.HOST AS host, p.DB AS db, p.COMMAND AS command,
			LEFT(COALESCE(t.trx_query, p.INFO), 200) AS query
		 FROM information_schema.INNODB_TRX t
		 LEFT JOIN information_schema.PROCESSLIST p ON p.ID = t.trx_mysql_thread_id
		 WHERE t.trx_mysql_thread_id <> CONNECTION_ID() AND t.trx_started < NOW() - INTERVAL 60 SECOND
		 ORDER BY t.trx_started LIMIT 100`
	);
	const findings: Finding[] = [];
	for (const r of rows) {
		const seconds = num(r.seconds);
		const sev = transactionAgeSeverity(seconds);
		if (!sev) continue;
		const idle = /^sleep$/i.test(String(r.command ?? ''));
		findings.push({
			severity: sev,
			title: `Transaction on thread ${r.thread} has been open for ${humanDuration(seconds)}`,
			explanation: `${r.user ? `${r.user}@${r.host}` : 'A session'}${r.db ? ` on ${r.db}` : ''} ${idle ? 'is idle but hasn’t committed' : 'is still running'} (${num(r.modified).toLocaleString('en-US')} rows modified, ${num(r.locked).toLocaleString('en-US')} locked). Long transactions hold locks, stop InnoDB from purging old row versions (the history list grows) and can block DDL. ${r.query ? `Current query: ${String(r.query).replace(/\s+/g, ' ').trim()}` : ''}`.trim(),
			objects: [`thread ${r.thread}`],
			fix: `-- Ends the session and rolls its transaction back:\nKILL ${Number(r.thread)};`
		});
	}
	return finish(findings);
};

const CHECKS: Record<string, (q: Query) => Promise<CheckOutcome>> = {
	'long-transactions': longTransactions,
	connections,
	'cache-hit': cacheHit,
	fragmentation,
	'unused-indexes': unusedIndexes,
	'duplicate-indexes': duplicateIndexes,
	'primary-keys': primaryKeys,
	'storage-engines': storageEngines
};

export async function mysqlHealth(id: string): Promise<HealthReport> {
	const started = performance.now();
	const checks = await mapLimit(checksFor('mysql'), 3, (c) => runCheck(id, c.id, CHECKS[c.id]));
	return { engine: 'mysql', ranAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started), checks };
}
