/**
 * CSV parsing (RFC 4180) and column type inference, shared by the import dialog
 * (preview, mapping) and the server (which parses the upload again itself).
 */

export class CsvError extends Error {
	line: number;
	constructor(message: string, line: number) {
		super(message);
		this.line = line;
	}
}

export interface CsvRecord {
	fields: string[];
	/** 1-based line where the record starts (records can span lines inside quotes). */
	line: number;
}

export const DELIMITERS = [',', ';', '\t', '|'] as const;

export function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Yields records one at a time: quoted fields may contain the delimiter, newlines
 * and doubled quotes (`""`). Accepts CRLF, LF and lone CR line endings. Blank lines
 * are skipped. A quote inside an unquoted field is kept literally (lenient, like
 * most spreadsheet exports expect).
 */
export function* csvRecords(input: string, delimiter = ','): Generator<CsvRecord> {
	if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') throw new Error('Invalid delimiter');
	const text = stripBom(input);
	const d = delimiter.charCodeAt(0);
	const QUOTE = 34;
	const LF = 10;
	const CR = 13;
	const n = text.length;
	let i = 0;
	let line = 1;
	while (i < n) {
		const startLine = line;
		const fields: string[] = [];
		let done = false;
		while (!done) {
			// One field.
			if (i < n && text.charCodeAt(i) === QUOTE) {
				i++;
				let value = '';
				let chunk = i;
				for (;;) {
					if (i >= n) throw new CsvError(`Unterminated quoted field starting on line ${startLine}`, startLine);
					const c = text.charCodeAt(i);
					if (c === QUOTE) {
						if (i + 1 < n && text.charCodeAt(i + 1) === QUOTE) {
							value += text.slice(chunk, i + 1);
							i += 2;
							chunk = i;
							continue;
						}
						value += text.slice(chunk, i);
						i++;
						break;
					}
					if (c === LF) line++;
					else if (c === CR && text.charCodeAt(i + 1) !== LF) line++;
					i++;
				}
				// Anything between the closing quote and the delimiter is kept (lenient).
				const rest = i;
				while (i < n) {
					const c = text.charCodeAt(i);
					if (c === d || c === LF || c === CR) break;
					i++;
				}
				fields.push(value + text.slice(rest, i));
			} else {
				const start = i;
				while (i < n) {
					const c = text.charCodeAt(i);
					if (c === d || c === LF || c === CR) break;
					i++;
				}
				fields.push(text.slice(start, i));
			}
			// After a field: delimiter, line end, or end of input.
			if (i >= n) done = true;
			else {
				const c = text.charCodeAt(i);
				if (c === d) i++;
				else {
					i += c === CR && text.charCodeAt(i + 1) === LF ? 2 : 1;
					line++;
					done = true;
				}
			}
		}
		if (fields.length === 1 && fields[0] === '') continue; // blank line
		yield { fields, line: startLine };
	}
}

export function parseCsv(text: string, delimiter = ','): string[][] {
	const out: string[][] = [];
	for (const r of csvRecords(text, delimiter)) out.push(r.fields);
	return out;
}

/** The delimiter that splits the first lines into the most consistent number of fields. */
export function detectDelimiter(text: string): string {
	const sample = stripBom(text).slice(0, 64 * 1024);
	let best = ',';
	let bestScore = -1;
	for (const d of DELIMITERS) {
		const counts: number[] = [];
		try {
			for (const r of csvRecords(sample, d)) {
				counts.push(r.fields.length);
				if (counts.length >= 20) break;
			}
		} catch {
			// The sample may end inside a quoted field; use what was read.
		}
		if (counts.length > 1 && sample.length >= 64 * 1024) counts.pop(); // last record may be cut off
		if (!counts.length || counts[0] < 2) continue;
		const same = counts.filter((c) => c === counts[0]).length / counts.length;
		const score = same * 1000 + counts[0];
		if (score > bestScore) {
			bestScore = score;
			best = d;
		}
	}
	return best;
}

const NUMBERISH = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Whether the first row looks like column names: every value present, distinct, and
 * not a number/date/boolean where a later row has the same kind of value.
 */
export function detectHeader(rows: string[][]): boolean {
	if (!rows.length) return false;
	const [first, ...rest] = rows;
	if (first.some((v) => !v.trim())) return false;
	if (new Set(first.map((v) => v.trim().toLowerCase())).size !== first.length) return false;
	if (!rest.length) return first.every((v) => !NUMBERISH.test(v.trim()));
	for (let c = 0; c < first.length; c++) {
		const kind = valueKind(first[c]);
		if (kind !== 'text' && rest.some((r) => r[c] !== undefined && valueKind(r[c]) === kind)) return false;
	}
	return true;
}

// --- type inference -------------------------------------------------------------

export type InferredKind = 'boolean' | 'integer' | 'bigint' | 'decimal' | 'double' | 'date' | 'timestamp' | 'timestamptz' | 'uuid' | 'json' | 'text';

export interface InferredType {
	kind: InferredKind;
	/** Some values were empty (they'd become NULL, or empty strings for text). */
	nullable: boolean;
	/** Longest value, in characters. */
	maxLength: number;
	/** decimal: digits before and after the point. */
	intDigits: number;
	scale: number;
	/** timestamp: has fractional seconds. */
	fraction: boolean;
}

const BOOL = /^(true|false|t|f|yes|no|y|n)$/i;
const INT = /^[+-]?\d+$/;
const DEC = /^[+-]?(\d+\.\d*|\.\d+|\d+)$/;
const DOUBLE = /^[+-]?(\d+\.?\d*|\.\d+)[eE][+-]?\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/;
const TSTZ = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}(:?\d{2})?)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT32 = 2147483647n;
const INT64 = 9223372036854775807n;

function intKind(v: string): 'integer' | 'bigint' | 'decimal' {
	const n = BigInt(v);
	const abs = n < 0n ? -n : n;
	if (abs <= INT32) return 'integer';
	return abs <= INT64 ? 'bigint' : 'decimal';
}

function validDate(v: string): boolean {
	const [y, m, d] = v.slice(0, 10).split('-').map(Number);
	const date = new Date(Date.UTC(y, m - 1, d));
	return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function isJson(v: string): boolean {
	if (!/^[[{]/.test(v)) return false;
	try {
		JSON.parse(v);
		return true;
	} catch {
		return false;
	}
}

/** The narrowest kind a single non-empty value fits. */
export function valueKind(raw: string): InferredKind {
	const v = raw.trim();
	if (!v) return 'text';
	if (BOOL.test(v)) return 'boolean';
	if (INT.test(v)) return intKind(v);
	if (DEC.test(v)) return 'decimal';
	if (DOUBLE.test(v)) return 'double';
	if (DATE.test(v) && validDate(v)) return 'date';
	if (TS.test(v) && validDate(v)) return 'timestamp';
	if (TSTZ.test(v) && validDate(v)) return 'timestamptz';
	if (UUID.test(v)) return 'uuid';
	if (isJson(v)) return 'json';
	return 'text';
}

/** Which kind covers both (e.g. integer + decimal = decimal, date + text = text). */
function widen(a: InferredKind, b: InferredKind): InferredKind {
	if (a === b) return a;
	const numeric: InferredKind[] = ['integer', 'bigint', 'decimal', 'double'];
	if (numeric.includes(a) && numeric.includes(b)) {
		if (a === 'double' || b === 'double') return 'double';
		return numeric[Math.max(numeric.indexOf(a), numeric.indexOf(b))];
	}
	const temporal: InferredKind[] = ['date', 'timestamp'];
	if (temporal.includes(a) && temporal.includes(b)) return 'timestamp';
	return 'text';
}

/** Infers a column's type from its values; empty values count as missing (NULL). */
export function inferType(values: Iterable<string>): InferredType {
	let kind: InferredKind | null = null;
	let nullable = false;
	let maxLength = 0;
	let intDigits = 0;
	let scale = 0;
	let fraction = false;
	for (const raw of values) {
		maxLength = Math.max(maxLength, raw.length);
		const v = raw.trim();
		if (!v) {
			nullable = true;
			continue;
		}
		const k = valueKind(v);
		kind = kind === null ? k : widen(kind, k);
		if (k === 'integer' || k === 'bigint' || k === 'decimal') {
			const [int, frac = ''] = v.replace(/^[+-]/, '').split('.');
			intDigits = Math.max(intDigits, int.replace(/^0+(?=\d)/, '').length);
			scale = Math.max(scale, frac.length);
		}
		if ((k === 'timestamp' || k === 'timestamptz') && /\.\d/.test(v)) fraction = true;
	}
	return { kind: kind ?? 'text', nullable, maxLength, intDigits, scale, fraction };
}

/** A SQL type for an inferred column, in the engine's dialect. */
export function sqlTypeFor(engine: string, t: InferredType): string {
	const precision = Math.min(Math.max(t.intDigits + t.scale, 1), engine === 'mysql' ? 65 : 1000);
	const scale = Math.min(t.scale, 30);
	if (engine === 'mysql') {
		switch (t.kind) {
			case 'boolean':
				return 'tinyint(1)';
			case 'integer':
				return 'int';
			case 'bigint':
				return 'bigint';
			case 'decimal':
				return `decimal(${Math.max(precision, scale)},${scale})`;
			case 'double':
				return 'double';
			case 'date':
				return 'date';
			case 'timestamp':
				return t.fraction ? 'datetime(6)' : 'datetime';
			case 'uuid':
				return 'char(36)';
			case 'json':
				return 'json';
			case 'timestamptz':
			case 'text':
				return t.maxLength <= 255 ? 'varchar(255)' : t.maxLength <= 16383 ? 'text' : 'longtext';
		}
	}
	if (engine === 'sqlite') {
		switch (t.kind) {
			case 'boolean':
			case 'integer':
			case 'bigint':
				return 'INTEGER';
			case 'decimal':
			case 'double':
				return 'REAL';
			default:
				return 'TEXT';
		}
	}
	switch (t.kind) {
		case 'boolean':
			return 'boolean';
		case 'integer':
			return 'integer';
		case 'bigint':
			return 'bigint';
		case 'decimal':
			return 'numeric';
		case 'double':
			return 'double precision';
		case 'date':
			return 'date';
		case 'timestamp':
			return 'timestamp';
		case 'timestamptz':
			return 'timestamptz';
		case 'uuid':
			return 'uuid';
		case 'json':
			return 'jsonb';
		case 'text':
			return 'text';
	}
}

/** A column name from a CSV header: lower-case words joined by underscores. */
export function columnNameFrom(header: string, index: number): string {
	const name = header
		.trim()
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}_]+/gu, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 63);
	if (!name) return `column_${index + 1}`;
	return /^\p{N}/u.test(name) ? `c_${name}`.slice(0, 63) : name;
}
