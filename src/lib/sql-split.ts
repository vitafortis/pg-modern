export interface StatementRange {
	from: number;
	to: number;
	text: string;
}

function hasCode(stmt: string): boolean {
	return !!stmt.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
}

/**
 * Splits a SQL script into statements with their source offsets, respecting
 * quotes, dollar-quoted bodies, and (nested) comments. Shared by the server,
 * which executes statements one by one, and the editor, which finds the
 * statement under the cursor.
 */
export function splitRanges(sql: string): StatementRange[] {
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

/** The statement containing (or immediately before) `pos`. */
export function statementAt(sql: string, pos: number): StatementRange | undefined {
	const ranges = splitRanges(sql);
	return ranges.find((r) => pos >= r.from && pos <= r.to + 1) ?? ranges.filter((r) => r.to <= pos).at(-1) ?? ranges[0];
}
