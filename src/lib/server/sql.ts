import { splitRanges } from '#lib/sql-split.ts';

/** Splits a SQL script into individual statements (see `splitRanges`). */
export function splitStatements(sql: string): string[] {
	return splitRanges(sql).map((r) => r.text);
}

export function stripComments(sql: string): string {
	return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function firstWords(sql: string, count = 4): string {
	return stripComments(sql).trim().split(/\s+/).slice(0, count).join(' ').toLowerCase();
}

/** Statements that could end or reconfigure the read-only transaction we wrap queries in. */
export function escapesReadOnly(sql: string): boolean {
	const head = firstWords(sql, 5);
	return (
		/^(begin|start|commit|end|rollback|abort|savepoint|release|prepare transaction|commit prepared|rollback prepared|reset|discard)\b/.test(head) ||
		/^set (session |local )?(characteristics|transaction|session characteristics)/.test(head) ||
		/^set (session |local )?(default_)?transaction_read_only\b/.test(head) ||
		/^set (session |local )?(role|session authorization)\b/.test(head)
	);
}

/** Statements that stream rows and should go through a cursor so we can cap them. */
export function returnsRows(sql: string): boolean {
	const s = stripComments(sql).trim().toLowerCase();
	return /^(select|with|values|table|show|explain|fetch|\()/.test(s) || /\breturning\b/.test(s);
}

/** Heuristic flag for statements the UI should confirm before running on a writable connection. */
export function isDestructive(sql: string): boolean {
	const s = stripComments(sql).trim().toLowerCase();
	if (/^(drop|truncate|alter\s+\w+\s+\S+\s+drop)\b/.test(s)) return true;
	if (/^(delete|update)\b/.test(s) && !/\bwhere\b/.test(s)) return true;
	return false;
}

export function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}
