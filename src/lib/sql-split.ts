export interface StatementRange {
	from: number;
	to: number;
	text: string;
}

export type Dialect = 'postgres' | 'mysql' | 'sqlite';

function hasCode(stmt: string): boolean {
	return !!stmt.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
}

function hasMysqlCode(stmt: string): boolean {
	return !!stmt.replace(/(--\s|#)[^\n]*/g, '').replace(/--$/gm, '').replace(/\/\*(?![!+]|M!)[\s\S]*?\*\//g, '').trim();
}

/** A `DELIMITER` line, which MySQL clients (not servers) use around procedure bodies. */
const DELIMITER_LINE = /^[ \t]*delimiter[ \t]+(\S+)[ \t]*(?:\r?\n|$)/i;

/**
 * Splits a SQL script into statements with their source offsets, respecting
 * quotes, dollar-quoted bodies, and (nested) comments. Shared by the server,
 * which executes statements one by one, and the editor, which finds the
 * statement under the cursor.
 */
export function splitRanges(sql: string, dialect: Dialect = 'postgres'): StatementRange[] {
	if (dialect === 'mysql') return splitMysql(sql);
	if (dialect === 'sqlite') return splitSqlite(sql);
	const out: StatementRange[] = [];
	let start = 0;
	let i = 0;
	const n = sql.length;

	const push = (from: number, to: number) => {
		const raw = sql.slice(from, to);
		if (!hasCode(raw)) return;
		const lead = raw.length - raw.trimStart().length;
		const text = raw.trim();
		out.push({ from: from + lead, to: from + lead + text.length, text });
	};

	while (i < n) {
		const ch = sql[i];
		const next = sql[i + 1];
		if (ch === '-' && next === '-') {
			const end = sql.indexOf('\n', i);
			i = end === -1 ? n : end + 1;
		} else if (ch === '/' && next === '*') {
			let depth = 1;
			i += 2;
			while (i < n && depth > 0) {
				if (sql[i] === '/' && sql[i + 1] === '*') {
					depth++;
					i += 2;
				} else if (sql[i] === '*' && sql[i + 1] === '/') {
					depth--;
					i += 2;
				} else i++;
			}
		} else if (ch === "'" || ch === '"') {
			i++;
			while (i < n) {
				if (sql[i] === ch) {
					if (sql[i + 1] === ch) i += 2;
					else break;
				} else i++;
			}
			i++;
		} else if (ch === '$') {
			const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
			if (tag && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? '')) {
				const end = sql.indexOf(tag[0], i + tag[0].length);
				i = end === -1 ? n : end + tag[0].length;
			} else i++;
		} else if (ch === ';') {
			push(start, i);
			start = ++i;
		} else i++;
	}
	push(start, n);
	return out;
}

/**
 * MySQL flavour: backtick identifiers, backslash escapes in strings, `#` and `-- `
 * comments, no dollar quoting, and the client-side `DELIMITER` command, so procedure
 * and trigger bodies containing `;` stay one statement.
 */
function splitMysql(sql: string): StatementRange[] {
	const out: StatementRange[] = [];
	let delimiter = ';';
	let start = 0;
	let i = 0;
	const n = sql.length;

	const push = (from: number, to: number) => {
		const raw = sql.slice(from, to);
		if (!hasMysqlCode(raw)) return;
		const lead = raw.length - raw.trimStart().length;
		const text = raw.trim();
		out.push({ from: from + lead, to: from + lead + text.length, text });
	};
	/** True when only whitespace/comments precede `i` in the current statement. */
	const atStatementStart = () => !hasMysqlCode(sql.slice(start, i));

	while (i < n) {
		const ch = sql[i];
		const next = sql[i + 1];
		if ((ch === 'd' || ch === 'D') && (i === 0 || sql[i - 1] === '\n' || /[ \t]/.test(sql[i - 1])) && atStatementStart()) {
			const lineStart = sql.lastIndexOf('\n', i - 1) + 1;
			const m = DELIMITER_LINE.exec(sql.slice(lineStart));
			if (m && !sql.slice(lineStart, i).trim()) {
				push(start, lineStart);
				delimiter = m[1];
				i = lineStart + m[0].length;
				start = i;
				continue;
			}
		}
		if (ch === '#' || (ch === '-' && next === '-' && (i + 2 >= n || /\s/.test(sql[i + 2])))) {
			const end = sql.indexOf('\n', i);
			i = end === -1 ? n : end + 1;
		} else if (ch === '/' && next === '*') {
			const end = sql.indexOf('*/', i + 2);
			i = end === -1 ? n : end + 2;
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
		} else if (sql.startsWith(delimiter, i)) {
			push(start, i);
			i += delimiter.length;
			start = i;
		} else i++;
	}
	push(start, n);
	return out;
}

/**
 * SQLite flavour: '…' strings, "…", `…` and […] identifiers, non-nesting comments, and
 * CREATE TRIGGER bodies (BEGIN … END, with CASE … END inside) kept as one statement.
 */
function splitSqlite(sql: string): StatementRange[] {
	const out: StatementRange[] = [];
	let start = 0;
	let i = 0;
	const n = sql.length;
	/** Words seen at the start of the current statement (to spot CREATE TRIGGER). */
	let head: string[] = [];
	let trigger = false;
	let inBody = false;
	let caseDepth = 0;

	const push = (from: number, to: number) => {
		const raw = sql.slice(from, to);
		if (!hasCode(raw)) return;
		const lead = raw.length - raw.trimStart().length;
		const text = raw.trim();
		out.push({ from: from + lead, to: from + lead + text.length, text });
	};

	while (i < n) {
		const ch = sql[i];
		const next = sql[i + 1];
		if (ch === '-' && next === '-') {
			const end = sql.indexOf('\n', i);
			i = end === -1 ? n : end + 1;
		} else if (ch === '/' && next === '*') {
			const end = sql.indexOf('*/', i + 2);
			i = end === -1 ? n : end + 2;
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
		} else if (/[A-Za-z_]/.test(ch) && !/[\w$]/.test(sql[i - 1] ?? '')) {
			let j = i + 1;
			while (j < n && /[\w$]/.test(sql[j])) j++;
			const word = sql.slice(i, j).toLowerCase();
			if (head.length < 4) {
				head.push(word);
				if (head[0] === 'create' && (word === 'trigger' || (head.length === 3 && head[2] === 'trigger'))) trigger = true;
			}
			if (trigger) {
				if (!inBody && word === 'begin') inBody = true;
				else if (inBody && word === 'case') caseDepth++;
				else if (inBody && word === 'end') {
					if (caseDepth > 0) caseDepth--;
					else inBody = false;
				}
			}
			i = j;
		} else if (ch === ';' && !inBody) {
			push(start, i);
			start = ++i;
			head = [];
			trigger = false;
			caseDepth = 0;
		} else i++;
	}
	push(start, n);
	return out;
}

/** Whether a MySQL script uses the client-side DELIMITER command. */
export function usesDelimiter(sql: string): boolean {
	return /^[ \t]*delimiter[ \t]+\S+/im.test(sql);
}

/** The statement containing (or immediately before) `pos`. */
export function statementAt(sql: string, pos: number, dialect: Dialect = 'postgres'): StatementRange | undefined {
	const ranges = splitRanges(sql, dialect);
	return ranges.find((r) => pos >= r.from && pos <= r.to + 1) ?? ranges.filter((r) => r.to <= pos).at(-1) ?? ranges[0];
}
