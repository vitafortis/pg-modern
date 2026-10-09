/**
 * Statement classification for SQLite. Pure (no driver imports) so it can be tested
 * on its own.
 *
 * Read-only access is layered: the file is opened with SQLITE_OPEN_READONLY (and a
 * `mode=ro` URI), `PRAGMA query_only` is on, scripts run inside a transaction that is
 * rolled back, and — because a read-only handle still lets `VACUUM INTO` write a new
 * file and `ATTACH` open other files — only an allowlist of statements runs at all.
 */

/**
 * Lower-cased statement with comments removed and every string literal and quoted
 * identifier replaced by a placeholder, so keyword checks can't be fooled by text
 * inside quotes.
 */
export function normalize(sql: string): string {
	let out = '';
	let i = 0;
	const n = sql.length;
	while (i < n) {
		const ch = sql[i];
		const next = sql[i + 1];
		if (ch === '-' && next === '-') {
			const end = sql.indexOf('\n', i);
			i = end === -1 ? n : end + 1;
			out += ' ';
		} else if (ch === '/' && next === '*') {
			const end = sql.indexOf('*/', i + 2);
			i = end === -1 ? n : end + 2;
			out += ' ';
		} else if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
			const close = ch === '[' ? ']' : ch;
			i++;
			while (i < n) {
				if (sql[i] === close) {
					if (close !== ']' && sql[i + 1] === close) i += 2;
					else break;
				} else i++;
			}
			i++;
			out += ch === "'" ? " 'str' " : ' "id" ';
		} else {
			out += ch.toLowerCase();
			i++;
		}
	}
	return out.replace(/\s+/g, ' ').trim();
}

/** First keyword, lower-cased (`(` for a parenthesised query). */
export function firstKeyword(sql: string): string {
	const s = normalize(sql);
	return /^[a-z_]+/.exec(s)?.[0] ?? s[0] ?? '';
}

const READ_START = /^(select|with|values|\()/;

/** Pragmas that only report something when read bare (`PRAGMA name` / `PRAGMA schema.name`). */
const READ_PRAGMAS = new Set([
	'application_id', 'auto_vacuum', 'automatic_index', 'busy_timeout', 'cache_size', 'cache_spill', 'case_sensitive_like',
	'cell_size_check', 'checkpoint_fullfsync', 'collation_list', 'compile_options', 'data_version', 'database_list',
	'defer_foreign_keys', 'encoding', 'foreign_key_check', 'foreign_keys', 'freelist_count', 'fullfsync', 'function_list',
	'hard_heap_limit', 'ignore_check_constraints', 'integrity_check', 'journal_mode', 'journal_size_limit', 'legacy_alter_table',
	'locking_mode', 'max_page_count', 'mmap_size', 'module_list', 'page_count', 'page_size', 'pragma_list', 'query_only',
	'quick_check', 'read_uncommitted', 'recursive_triggers', 'reverse_unordered_selects', 'schema_version', 'secure_delete',
	'soft_heap_limit', 'synchronous', 'table_list', 'temp_store', 'threads', 'trusted_schema', 'user_version', 'wal_autocheckpoint'
]);

/** Pragmas whose argument names a thing to describe rather than a new value. */
const READ_PRAGMAS_WITH_ARG = new Set([
	'table_info', 'table_xinfo', 'table_list', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list', 'foreign_key_check',
	'integrity_check', 'quick_check'
]);

/** Functions a read must not call (extension loading is also disabled on the handle). */
const BLOCKED_FUNCTIONS = /\b(load_extension|writefile|edit|fts3_tokenizer)\s*\(/;

/**
 * Why a statement can't run on a read-only connection, or null if it may. Allowed:
 * SELECT / WITH / VALUES that don't modify anything, EXPLAIN [QUERY PLAN] of those,
 * and pragmas that only read.
 */
export function readOnlyProblem(sql: string): string | null {
	const s = normalize(sql);
	if (!s) return null;
	const first = /^[a-z_(]+/.exec(s)?.[0] ?? s[0];
	if (first === 'explain') {
		const rest = s.replace(/^explain\s+(query\s+plan\s+)?/, '');
		if (READ_START.test(rest)) return readProblem(rest);
		return 'Only reads can be explained on read-only connections.';
	}
	if (first === 'pragma') return pragmaProblem(s);
	if (READ_START.test(s)) return readProblem(s);
	if (first === 'vacuum') return 'VACUUM (including VACUUM INTO, which writes a new file) is blocked on read-only connections.';
	if (first === 'attach' || first === 'detach') return 'ATTACH / DETACH are blocked on read-only connections — they open other files.';
	if (['begin', 'commit', 'end', 'rollback', 'savepoint', 'release'].includes(first)) {
		return 'Transaction control is blocked on read-only connections (every script already runs in a transaction that is rolled back).';
	}
	return `${first.toUpperCase()} statements are blocked on read-only connections — only SELECT, VALUES, EXPLAIN and read-only PRAGMAs run here.`;
}

function readProblem(s: string): string | null {
	// WITH … INSERT/UPDATE/DELETE is a write; REPLACE( and INSERT( are no keywords here but replace() is a function.
	if (/\b(update|delete|insert)\b|\breplace\b(?!\s*\()/.test(s)) return 'Data-modifying statements are blocked on read-only connections.';
	if (BLOCKED_FUNCTIONS.test(s)) return 'That function is blocked on read-only connections.';
	return null;
}

function pragmaProblem(s: string): string | null {
	const m = /^pragma\s+(?:("id"|[a-z_]\w*)\s*\.\s*)?([a-z_]\w*)\s*(.*)$/.exec(s);
	if (!m) return 'Not a read-only PRAGMA.';
	const name = m[2];
	const rest = m[3].trim();
	if (!rest) return READ_PRAGMAS.has(name) ? null : `PRAGMA ${name} is blocked on read-only connections.`;
	if (/^\(\s*("id"|'str'|[a-z_]\w*)\s*\)$/.test(rest) && READ_PRAGMAS_WITH_ARG.has(name)) return null;
	return 'Pragmas that change settings are blocked on read-only connections.';
}

/** Heuristic flag for statements the UI should confirm before running with write access. */
export function isDestructiveSqlite(sql: string): boolean {
	const s = normalize(sql);
	if (/^drop\b/.test(s)) return true;
	if (/^alter\s+table\s+\S+\s+drop\b/.test(s)) return true;
	// WITH … DELETE / UPDATE: look at the statement after the common table expressions.
	const at = s.startsWith('with') ? s.search(/\)\s*(delete|update)\b/) : -1;
	const body = at >= 0 ? s.slice(at + 1).trim() : s;
	return /^(delete|update)\b/.test(body) && !/\bwhere\b/.test(body);
}

/** Why a statement can't be explained here, if it can't. EXPLAIN QUERY PLAN never executes it. */
export function sqliteExplainProblem(statements: string[], analyze: boolean): string | null {
	if (statements.length === 0) return 'Nothing to explain.';
	if (statements.length > 1) return 'Explain one statement at a time.';
	if (analyze) return 'SQLite has no EXPLAIN ANALYZE — use Explain, which shows EXPLAIN QUERY PLAN.';
	const first = firstKeyword(statements[0]);
	if (first === 'explain') return 'Leave out EXPLAIN — use Explain instead.';
	if (!['select', 'with', 'values', '(', 'insert', 'update', 'delete', 'replace'].includes(first)) {
		return 'SQLite can explain SELECT, INSERT, UPDATE and DELETE statements.';
	}
	return null;
}
