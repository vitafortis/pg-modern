/**
 * Statement classification for MySQL/MariaDB. Pure (no driver imports) so it can be
 * tested on its own.
 *
 * Read-only access is layered: the session is `transaction_read_only`, every request
 * runs in `START TRANSACTION READ ONLY` and is rolled back, the driver sends one
 * statement per call, and — because DDL commits implicitly and isn't stopped by a
 * read-only transaction everywhere — only an allowlist of statements reaches the
 * server at all.
 */

/**
 * Lower-cased statement with comments removed and every string literal and quoted
 * identifier replaced by a placeholder, so keyword checks can't be fooled by text
 * inside quotes. Executable comments (`/*! … *\/`, `/*M! … *\/`) are kept as code,
 * because the server runs them.
 */
export function normalize(sql: string): string {
	let out = '';
	let i = 0;
	const n = sql.length;
	while (i < n) {
		const ch = sql[i];
		const next = sql[i + 1];
		if (ch === '#' || (ch === '-' && next === '-' && (i + 2 >= n || /\s/.test(sql[i + 2])))) {
			const end = sql.indexOf('\n', i);
			i = end === -1 ? n : end + 1;
			out += ' ';
		} else if (ch === '/' && next === '*') {
			const exec = /^\/\*(M?!)(\d{5,6})?/.exec(sql.slice(i, i + 10));
			if (exec) {
				// Executable comment: drop the markers, keep the body as code.
				i += exec[0].length;
				out += ' ';
				continue;
			}
			const end = sql.indexOf('*/', i + 2);
			i = end === -1 ? n : end + 2;
			out += ' ';
		} else if (ch === '*' && next === '/') {
			// The end of an executable comment whose start we unwrapped.
			i += 2;
			out += ' ';
		} else if (ch === "'" || ch === '"' || ch === '`') {
			i++;
			while (i < n) {
				if (sql[i] === '\\' && ch !== '`') i += 2;
				else if (sql[i] === ch) {
					if (sql[i + 1] === ch) i += 2;
					else break;
				} else i++;
			}
			i++;
			out += ch === '`' ? ' `id` ' : " 'str' ";
		} else {
			out += ch.toLowerCase();
			i++;
		}
	}
	return out.replace(/\s+/g, ' ').trim();
}

const READ_START = /^(select|with|table|values|\()/;

/** Options EXPLAIN / DESCRIBE accept before the statement or table they describe. */
const EXPLAIN_OPTIONS = /^(analyze|extended|partitions|format\s*=\s*\w+|into\s+@\w+)\s*/;

/**
 * Why a statement can't run on a read-only connection, or null if it may. Only
 * reads are allowed: SELECT / WITH / TABLE / VALUES, SHOW, DESCRIBE, EXPLAIN of a
 * read, HELP and USE (pg·modern resets the default database afterwards).
 */
export function readOnlyProblem(sql: string): string | null {
	const s = normalize(sql);
	if (!s) return null;
	const first = /^[a-z_(]+/.exec(s)?.[0] ?? s[0];

	if (first === 'show' || first === 'help') {
		return null;
	}
	if (first === 'use') {
		return /^use\s+(`id`|[\w$]+)\s*$/.test(s) ? null : 'USE takes a single database name.';
	}
	if (first === 'describe' || first === 'desc' || first === 'explain') {
		let rest = s.slice(first.length).trim();
		for (let m = EXPLAIN_OPTIONS.exec(rest); m; m = EXPLAIN_OPTIONS.exec(rest)) {
			if (/^into\b/.test(m[1])) return 'EXPLAIN … INTO a variable isn’t allowed on read-only connections.';
			rest = rest.slice(m[0].length);
		}
		if (/^for\s+connection\b/.test(rest)) return null;
		if (READ_START.test(rest)) return readProblem(rest);
		if (/^(insert|update|delete|replace)\b/.test(rest)) return 'Only reads can be explained on read-only connections.';
		// EXPLAIN / DESCRIBE <table> [column]
		return /^(`id`|[\w$]+)(\s*\.\s*(`id`|[\w$]+))?(\s+(`id`|'str'|[\w$%]+))?$/.test(rest) ? null : 'Not a read-only statement.';
	}
	if (READ_START.test(s)) return readProblem(s);
	return `${first.toUpperCase()} statements are blocked on read-only connections — only SELECT, SHOW, DESCRIBE and EXPLAIN run here.`;
}

/** Checks a SELECT-like statement for the clauses that make it more than a read. */
function readProblem(s: string): string | null {
	if (/\binto\s+(outfile|dumpfile)\b/.test(s)) return 'SELECT … INTO OUTFILE/DUMPFILE writes files on the server and is blocked on read-only connections.';
	if (/\binto\b/.test(s)) return 'SELECT … INTO is blocked on read-only connections.';
	if (/\bfor\s+(update|share)\b|\block\s+in\s+share\s+mode\b/.test(s)) return 'Locking reads (FOR UPDATE / FOR SHARE) are blocked on read-only connections.';
	// INSERT( and REPLACE( are string functions; as keywords they start a write (e.g. WITH … DELETE).
	if (/\b(update|delete)\b|\binsert\b(?!\s*\()|\breplace\b(?!\s*\()/.test(s)) return 'Data-modifying statements are blocked on read-only connections.';
	return null;
}

/** The database a `USE` statement switches to, if that's what it is. */
export function useTarget(sql: string): string | null {
	const s = sql.replace(/^\s*(?:(?:#|--\s)[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*/, '');
	const m = /^use\s+(?:`((?:[^`]|``)+)`|([\w$]+))\s*;?\s*$/i.exec(s);
	return m ? (m[1]?.replace(/``/g, '`') ?? m[2]) : null;
}

/** First keyword, lower-cased (`(` for a parenthesised query). */
export function firstKeyword(sql: string): string {
	const s = normalize(sql);
	return /^[a-z_]+/.exec(s)?.[0] ?? s[0] ?? '';
}

/** Statements that only read, so they can stay on a shared pooled session afterwards. */
const SESSION_NEUTRAL = new Set([
	'select', 'with', 'table', 'values', '(', 'show', 'describe', 'desc', 'explain', 'help', 'use',
	'insert', 'update', 'delete', 'replace', 'create', 'alter', 'drop', 'truncate', 'rename',
	'grant', 'revoke', 'analyze', 'optimize', 'check', 'repair', 'checksum', 'call'
]);

/**
 * Whether a statement may leave state on the session (variables, locks, temporary
 * tables, prepared statements, open transactions). Such sessions are closed instead
 * of going back to the pool.
 */
export function changesSession(sql: string): boolean {
	const s = normalize(sql);
	const first = /^[a-z_(]+/.exec(s)?.[0] ?? '';
	if (!SESSION_NEUTRAL.has(first)) return true;
	if (/\btemporary\b/.test(s)) return true;
	if (/@\w+\s*:=/.test(s)) return true;
	if (/\bget_lock\s*\(/.test(s)) return true;
	return false;
}

/** Heuristic flag for statements the UI should confirm before running with write access. */
export function isDestructiveMysql(sql: string): boolean {
	const s = normalize(sql);
	if (/^(drop|truncate)\b/.test(s)) return true;
	if (/^alter\s+(online\s+|ignore\s+)?table\s+\S+\s+.*\bdrop\b/.test(s)) return true;
	if (/^alter\s+\w+\s+\S+\s+drop\b/.test(s)) return true;
	if (/^(delete|update)\b/.test(s) && !/\bwhere\b/.test(s)) return true;
	return false;
}
