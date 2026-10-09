import { basename } from 'node:path';
import { extractCandidates, fingerprint, parsePostgresUrl, sslFromParam } from './env.ts';
import { looksLikePostgresServer } from './detect.ts';
import type { Candidate, ConnectionSource, SslMode } from '#lib/types.ts';

// ───────────────────────────── HCL parsing ─────────────────────────────

/** An expression that isn't a plain literal (reference, function call, conditional, …), kept as source text. */
export class HclExpr {
	text: string;
	constructor(text: string) {
		this.text = text;
	}
}

export type HclValue = string | number | boolean | null | HclExpr | HclValue[] | { [key: string]: HclValue };

export interface HclBlock {
	type: string;
	labels: string[];
	body: HclBody;
}

export interface HclBody {
	attrs: Record<string, HclValue>;
	blocks: HclBlock[];
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[\w-]/;
/** `name =` (but not `==` or `=>`): the start of another attribute. */
const ATTR_AHEAD = /^[A-Za-z_][\w-]*[ \t]*=(?![=>])/;

/**
 * Lenient HCL2 parser: blocks, attributes, strings (template interpolations are kept verbatim),
 * heredocs, numbers, bools, null, lists, objects and comments. Anything else is kept as an
 * {@link HclExpr}. It never throws; a broken file yields whatever parsed before the damage.
 */
export function parseHcl(src: string): HclBody {
	let pos = 0;
	const n = src.length;

	function skipComment(): boolean {
		if (src[pos] === '#' || (src[pos] === '/' && src[pos + 1] === '/')) {
			while (pos < n && src[pos] !== '\n') pos++;
			return true;
		}
		if (src[pos] === '/' && src[pos + 1] === '*') {
			const end = src.indexOf('*/', pos + 2);
			pos = end === -1 ? n : end + 2;
			return true;
		}
		return false;
	}

	/** Skips blanks and comments, and newlines too when `nl`. */
	function skip(nl: boolean) {
		while (pos < n) {
			const c = src[pos];
			if (c === ' ' || c === '\t' || c === '\r' || c === '﻿' || (nl && c === '\n')) pos++;
			else if (!skipComment()) break;
		}
	}

	function ident(): string | null {
		if (pos >= n || !IDENT_START.test(src[pos])) return null;
		const start = pos;
		while (pos < n && IDENT_CHAR.test(src[pos])) pos++;
		return src.slice(start, pos);
	}

	/** Index just past the `}` closing an interpolation whose `{` is at `open`. */
	function templateEnd(open: number): number {
		let depth = 0;
		let i = open;
		while (i < n) {
			const c = src[i];
			if (c === '"') {
				const save = pos;
				pos = i;
				str();
				i = pos;
				pos = save;
				continue;
			}
			if (c === '{') depth++;
			else if (c === '}' && --depth === 0) return i + 1;
			i++;
		}
		return n;
	}

	/** A quoted string; `${…}` / `%{…}` sequences are kept verbatim for later evaluation. */
	function str(): string {
		pos++;
		let out = '';
		while (pos < n && src[pos] !== '"' && src[pos] !== '\n') {
			const c = src[pos];
			if (c === '\\') {
				const e = src[pos + 1];
				if (e === 'u' || e === 'U') {
					const len = e === 'u' ? 4 : 8;
					const code = parseInt(src.slice(pos + 2, pos + 2 + len), 16);
					out += Number.isNaN(code) ? '' : String.fromCodePoint(code);
					pos += 2 + len;
					continue;
				}
				out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : (e ?? '');
				pos += 2;
				continue;
			}
			if ((c === '$' || c === '%') && src[pos + 1] === c && src[pos + 2] === '{') {
				out += src.slice(pos, pos + 3);
				pos += 3;
				continue;
			}
			if ((c === '$' || c === '%') && src[pos + 1] === '{') {
				const end = templateEnd(pos + 1);
				out += src.slice(pos, end);
				pos = end;
				continue;
			}
			out += c;
			pos++;
		}
		if (src[pos] === '"') pos++;
		return out;
	}

	function heredoc(): string | null {
		const m = /^<<(-?)([A-Za-z_][\w-]*)[ \t]*\r?\n/.exec(src.slice(pos, pos + 200));
		if (!m) return null;
		pos += m[0].length;
		const lines: string[] = [];
		while (pos < n) {
			let end = src.indexOf('\n', pos);
			if (end === -1) end = n;
			const line = src.slice(pos, end).replace(/\r$/, '');
			pos = end;
			if (line.trim() === m[2]) break;
			lines.push(line);
			if (pos < n) pos++;
		}
		if (m[1]) {
			const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length);
			const strip = indents.length ? Math.min(...indents) : 0;
			for (let i = 0; i < lines.length; i++) lines[i] = lines[i].slice(strip);
		}
		return lines.length ? lines.join('\n') + '\n' : '';
	}

	/** Raw source of an expression up to the end of its context (newline, `,`, or a closing bracket). */
	function raw(nl: boolean): string {
		const start = pos;
		let depth = 0;
		while (pos < n) {
			const c = src[pos];
			const comment = c === '#' || (c === '/' && (src[pos + 1] === '/' || src[pos + 1] === '*'));
			if (depth === 0) {
				if (c === ',' || c === '}' || c === ']' || c === ')' || comment) break;
				if (nl && c === '\n') break;
				if (nl && pos > start && /\s/.test(src[pos - 1]) && ATTR_AHEAD.test(src.slice(pos, pos + 80))) break;
			} else if (comment) {
				skipComment();
				continue;
			}
			if (c === '"') {
				str();
				continue;
			}
			if (c === '<' && src[pos + 1] === '<' && heredoc() !== null) continue;
			if (c === '(' || c === '[' || c === '{') depth++;
			else if (c === ')' || c === ']' || c === '}') depth--;
			pos++;
		}
		return src.slice(start, pos).trim();
	}

	function atEnd(nl: boolean): boolean {
		if (pos >= n) return true;
		const c = src[pos];
		if (c === ',' || c === '}' || c === ']' || c === ')') return true;
		return nl && (c === '\n' || ATTR_AHEAD.test(src.slice(pos, pos + 80)));
	}

	function isFor(): boolean {
		return /^for\s/.test(src.slice(pos, pos + 4));
	}

	function list(nl: boolean): HclValue {
		const start = pos;
		pos++;
		skip(true);
		if (isFor()) {
			pos = start;
			return new HclExpr(raw(nl));
		}
		const items: HclValue[] = [];
		while (pos < n && src[pos] !== ']') {
			const before = pos;
			const v = expr(false);
			if (!(v instanceof HclExpr && v.text === '')) items.push(v);
			skip(true);
			if (src[pos] === ',') {
				pos++;
				skip(true);
			} else if (src[pos] !== ']' && pos === before) pos++;
		}
		if (src[pos] === ']') pos++;
		return items;
	}

	function object(nl: boolean): HclValue {
		const start = pos;
		pos++;
		skip(true);
		if (isFor()) {
			pos = start;
			return new HclExpr(raw(nl));
		}
		const obj: { [key: string]: HclValue } = {};
		while (pos < n && src[pos] !== '}') {
			const before = pos;
			let key: string | null = null;
			if (src[pos] === '"') key = str();
			else if (src[pos] === '(') {
				pos++;
				key = raw(false);
				if (src[pos] === ')') pos++;
			} else key = ident();
			skip(false);
			if (key !== null && (src[pos] === '=' || src[pos] === ':')) {
				pos++;
				skip(false);
				obj[key] = expr(true);
			}
			skip(false);
			if (src[pos] === ',') pos++;
			skip(true);
			if (pos === before) pos++;
		}
		if (src[pos] === '}') pos++;
		return obj;
	}

	function primary(nl: boolean): HclValue {
		const c = src[pos];
		if (c === '"') return str();
		if (c === '<' && src[pos + 1] === '<') {
			const h = heredoc();
			if (h !== null) return h;
		}
		const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(pos, pos + 40));
		if (num && !IDENT_CHAR.test(src[pos + num[0].length] ?? '')) {
			pos += num[0].length;
			return Number(num[0]);
		}
		if (c === '[') return list(nl);
		if (c === '{') return object(nl);
		const lit = /^(true|false|null)(?![\w-])/.exec(src.slice(pos, pos + 6));
		if (lit) {
			pos += lit[1].length;
			return lit[1] === 'null' ? null : lit[1] === 'true';
		}
		return new HclExpr(raw(nl));
	}

	/** An expression; `nl` means a newline ends it (attribute/object context, not inside a list). */
	function expr(nl: boolean): HclValue {
		skip(!nl);
		const start = pos;
		const v = primary(nl);
		if (v instanceof HclExpr) return v;
		skip(!nl);
		if (atEnd(nl)) return v;
		// A literal followed by an operator, index or conditional: keep the whole thing raw.
		pos = start;
		return new HclExpr(raw(nl));
	}

	function skipLine(nested: boolean) {
		while (pos < n && src[pos] !== '\n' && !(nested && src[pos] === '}')) {
			if (src[pos] === '"') str();
			else pos++;
		}
	}

	function body(nested: boolean): HclBody {
		const out: HclBody = { attrs: {}, blocks: [] };
		while (pos < n) {
			skip(true);
			if (pos >= n) break;
			const before = pos;
			if (src[pos] === '}') {
				pos++;
				if (nested) return out;
				continue;
			}
			const name = src[pos] === '"' ? str() : ident();
			if (name === null) {
				skipLine(nested);
			} else {
				skip(false);
				if ((src[pos] === '=' && src[pos + 1] !== '=') || src[pos] === ':') {
					pos++;
					skip(false);
					out.attrs[name] = expr(true);
					skip(false);
					if (src[pos] === ',') pos++;
					else if (!atEnd(true)) skipLine(nested);
				} else {
					const labels: string[] = [];
					while (pos < n && (src[pos] === '"' || IDENT_START.test(src[pos]))) {
						labels.push(src[pos] === '"' ? str() : ident()!);
						skip(false);
					}
					if (src[pos] === '{') {
						pos++;
						out.blocks.push({ type: name, labels, body: body(true) });
					} else skipLine(nested);
				}
			}
			if (pos === before) pos++;
		}
		return out;
	}

	try {
		return body(false);
	} catch {
		return { attrs: {}, blocks: [] };
	}
}

/** Parses a single expression's source text. */
function parseExprText(text: string): HclValue | undefined {
	return parseHcl(`v = ${text}\n`).attrs.v;
}

// ───────────────────────────── evaluation ─────────────────────────────

/** Stands in for an interpolation that couldn't be resolved. */
const UNRESOLVED = '\u0000';

interface Located {
	block: HclBlock;
	file: string;
}

interface Module {
	vars: Map<string, { value: unknown; file?: string }>;
	declared: Set<string>;
	locals: Map<string, { value: HclValue; file: string }>;
	resources: Map<string, Located>;
	state: Map<string, Record<string, unknown>>;
	hasState: boolean;
}

interface Eval {
	/** Why parts of the value are unknown, e.g. "var.pw, which has no value in this folder". */
	missing: string[];
	/** tfvars files whose values were used. */
	files: string[];
	depth: number;
}

const newEval = (): Eval => ({ missing: [], files: [], depth: 0 });

function evaluate(v: HclValue | undefined, m: Module, ev: Eval): unknown {
	if (v === undefined) return undefined;
	if (typeof v === 'string') return template(v, m, ev);
	if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
	if (v instanceof HclExpr) return evalExpr(v.text, m, ev);
	if (Array.isArray(v)) return v.map((x) => evaluate(x, m, ev));
	return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, evaluate(x, m, ev)]));
}

function interpolationEnd(s: string, open: number): number {
	let depth = 0;
	let quoted = false;
	for (let i = open; i < s.length; i++) {
		const c = s[i];
		if (quoted) {
			if (c === '\\') i++;
			else if (c === '"') quoted = false;
		} else if (c === '"') quoted = true;
		else if (c === '{') depth++;
		else if (c === '}' && --depth === 0) return i;
	}
	return s.length;
}

function template(s: string, m: Module, ev: Eval): unknown {
	if (!s.includes('{')) return s;
	// A string that is a single interpolation evaluates to that value (which may not be a string).
	if (s.startsWith('${') && interpolationEnd(s, 1) === s.length - 1) {
		return evalExpr(s.slice(2, -1).replace(/^~|~$/g, ''), m, ev);
	}
	let out = '';
	let i = 0;
	while (i < s.length) {
		if ((s[i] === '$' || s[i] === '%') && s[i + 1] === s[i] && s[i + 2] === '{') {
			out += s[i] + '{';
			i += 3;
		} else if (s[i] === '$' && s[i + 1] === '{') {
			const end = interpolationEnd(s, i + 1);
			const v = evalExpr(s.slice(i + 2, end).replace(/^~|~$/g, ''), m, ev);
			out += typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : UNRESOLVED;
			i = end + 1;
		} else if (s[i] === '%' && s[i + 1] === '{') {
			ev.missing.push('a template directive pg·modern can’t evaluate');
			out += UNRESOLVED;
			i = interpolationEnd(s, i + 1) + 1;
		} else out += s[i++];
	}
	return out;
}

const REFERENCE = /^([A-Za-z_][\w-]*)((?:\.[\w-]+|\[\s*(?:"[^"]*"|\d+)\s*\])*)$/;
const PASSTHROUGH_FN = /^(tostring|tonumber|sensitive|nonsensitive|trimspace)\(([\s\S]*)\)$/;

function evalExpr(text: string, m: Module, ev: Eval): unknown {
	text = text.trim();
	if (ev.depth > 30) return undefined;
	ev.depth++;
	try {
		const fn = PASSTHROUGH_FN.exec(text);
		if (fn) {
			const v = evalExpr(fn[2], m, ev);
			if (fn[1] === 'tonumber') return v === undefined ? v : Number(v);
			if (fn[1] === 'trimspace' && typeof v === 'string') return v.trim();
			return fn[1] === 'tostring' && typeof v !== 'string' && v !== undefined ? String(v) : v;
		}
		const ref = REFERENCE.exec(text);
		if (!ref) {
			const parsed = parseExprText(text);
			if (parsed !== undefined && !(parsed instanceof HclExpr)) return evaluate(parsed, m, ev);
			ev.missing.push(`\`${text.length > 60 ? text.slice(0, 57) + '…' : text}\`, an expression pg·modern can’t evaluate`);
			return undefined;
		}
		const segs = [...ref[2].matchAll(/\.([\w-]+)|\[\s*(?:"([^"]*)"|(\d+))\s*\]/g)].map((s) => s[1] ?? s[2] ?? Number(s[3]));
		return lookup(ref[1], segs, text, m, ev);
	} finally {
		ev.depth--;
	}
}

function walkPath(v: unknown, path: (string | number)[]): unknown {
	for (const p of path) {
		if (v == null || typeof v !== 'object') return undefined;
		v = (v as Record<string | number, unknown>)[p];
	}
	return v;
}

function lookup(root: string, segs: (string | number)[], text: string, m: Module, ev: Eval): unknown {
	const [first, ...rest] = segs;
	if (root === 'var' && typeof first === 'string') {
		const v = m.vars.get(first);
		if (v === undefined || v.value == null) {
			ev.missing.push(
				m.declared.has(first) || v ? `var.${first}, which has no value in this folder` : `var.${first}, which isn’t declared in this folder`
			);
			return undefined;
		}
		if (v.file) ev.files.push(v.file);
		return walkPath(v.value, rest);
	}
	if (root === 'local' && typeof first === 'string') {
		const l = m.locals.get(first);
		if (!l) {
			ev.missing.push(`local.${first}, which isn’t defined in this folder`);
			return undefined;
		}
		return walkPath(evaluate(l.value, m, ev), rest);
	}
	if (['each', 'count', 'self', 'path', 'terraform', 'module'].includes(root)) {
		ev.missing.push(`${text}, which pg·modern can’t evaluate`);
		return undefined;
	}
	const isData = root === 'data';
	const [type, name, attr, ...tail] = (isData ? segs : [root, ...segs]).map(String);
	if (!type || !name) {
		ev.missing.push(`\`${text}\`, an expression pg·modern can’t evaluate`);
		return undefined;
	}
	const key = `${isData ? 'data.' : ''}${type}.${name}`;
	const located = isData ? undefined : m.resources.get(key);
	if (located && attr) {
		// Config only knows an image's name; its ID is computed, but the name works just as well here.
		const field = type === 'docker_image' && ['image_id', 'latest', 'repo_digest', 'id'].includes(attr) ? 'name' : attr;
		if (field in located.block.body.attrs) return walkPath(evaluate(located.block.body.attrs[field], m, ev), tail);
	}
	const state = m.state.get(key);
	if (state && attr && state[attr] !== undefined) return walkPath(state[attr], tail);
	ev.missing.push(
		`${text}, which is only known after \`terraform apply\`${m.hasState ? '' : ' (no terraform.tfstate in this folder)'}`
	);
	return undefined;
}

interface Field {
	value?: string;
	files: string[];
	missing: string[];
}

/** Evaluates a scalar attribute to a string; undefined (with reasons) if any part is unknown. */
function scalar(v: HclValue | undefined, m: Module): Field {
	const ev = newEval();
	const r = evaluate(v, m, ev);
	const ok = (typeof r === 'string' && !r.includes(UNRESOLVED)) || typeof r === 'number' || typeof r === 'boolean';
	return { value: ok ? String(r) : undefined, files: ev.files, missing: ev.missing };
}

function noteMissing(label: string, f: Field, notes: string[]) {
	if (f.value === undefined && f.missing.length) notes.push(`${label} comes from ${f.missing[0]}.`);
}

// ───────────────────────────── candidates ─────────────────────────────

export interface TerraformFile {
	path: string;
	content: string;
}

export interface TerraformContext {
	/** Module name used in candidate names, usually the folder name. */
	project: string;
	/** Address that reaches ports published on the Docker host (default: the docker provider's host, else localhost). */
	publishedHost?: string;
}

const TFVARS = /\.tfvars(\.json)?$/i;
const STATE = /(^|\/)terraform\.tfstate$/i;
const PG_URL = /postgres(?:ql)?(?:\+\w+)?:\/\/[^\s"'`<>]+/gi;

function tfvarsRank(path: string): number {
	const name = basename(path).toLowerCase();
	if (/\.auto\.tfvars(\.json)?$/.test(name)) return 3;
	if (name === 'terraform.tfvars' || name === 'terraform.tfvars.json') return 2;
	return 1;
}

function blockAddr(b: HclBlock): string {
	return [b.type, ...b.labels].join('.');
}

interface TfContainer {
	name: string;
	image: string;
	env: Record<string, string>;
	/** Why an env value is unknown, per key. */
	envMissing: Record<string, string>;
	ports: { internal: number; external?: number; ip?: string }[];
	source: ConnectionSource;
}

function containerCandidates(containers: TfContainer[], project: string, dockerHost: string): Candidate[] {
	const out: Candidate[] = [];
	const servers = new Map<string, { addrs: { host: string; port: number; label: string }[]; server: Candidate }>();
	const bind = (ip?: string) => (!ip || ip === '0.0.0.0' || ip === '::' ? dockerHost : ip);
	for (const c of containers) {
		const exposed = c.ports.some((p) => p.internal === 5432);
		if (!looksLikePostgresServer(c.image, c.env, exposed ? ['5432/tcp'] : [])) continue;
		const internal = Number(c.env.PGPORT) || 5432;
		const pub = c.ports.find((p) => p.internal === internal && p.external);
		const addrs = [
			...(pub ? [{ host: bind(pub.ip), port: pub.external!, label: 'published port' }] : []),
			{ host: c.name, port: internal, label: 'container name' }
		];
		const user = c.env.POSTGRES_USER || c.env.POSTGRESQL_USERNAME || 'postgres';
		const password = c.env.POSTGRES_PASSWORD || c.env.POSTGRESQL_PASSWORD || undefined;
		const notes: string[] = [];
		for (const k of ['POSTGRES_USER', 'POSTGRES_DB']) {
			if (c.envMissing[k]) notes.push(`${k} comes from ${c.envMissing[k]}.`);
		}
		const pwMissing = c.envMissing.POSTGRES_PASSWORD ?? c.envMissing.POSTGRESQL_PASSWORD;
		if (!password && pwMissing) notes.push(`Password comes from ${pwMissing}.`);
		else if (!password && c.env.POSTGRES_PASSWORD_FILE) notes.push('Password comes from a secret file; enter it manually.');
		if (!pub) notes.push('No published port — reachable only from the Docker network.');
		const base = { host: addrs[0].host, port: addrs[0].port, database: c.env.POSTGRES_DB || c.env.POSTGRESQL_DATABASE || user, user };
		const server: Candidate = {
			...base,
			fingerprint: fingerprint(base),
			name: `${project}/${c.name}`,
			password,
			hasPassword: !!password,
			sslMode: 'prefer',
			source: c.source,
			alternates: addrs.slice(1),
			notes
		};
		out.push(server);
		servers.set(c.name.toLowerCase(), { addrs, server });
	}
	for (const c of containers) {
		if (servers.has(c.name.toLowerCase())) continue;
		for (const cand of extractCandidates(c.env, { label: `${project}/${c.name}`, source: c.source })) {
			const target = servers.get(cand.host.toLowerCase());
			if (target) {
				cand.alternates = [{ host: cand.host, port: cand.port, label: 'as configured' }, ...target.addrs.slice(1)];
				cand.host = target.addrs[0].host;
				cand.port = target.addrs[0].port;
				if (cand.user === target.server.user && cand.database === cand.user) cand.database = target.server.database;
				cand.fingerprint = fingerprint(cand);
			}
			out.push(cand);
		}
	}
	return out;
}

function splitEnv(line: string): [string, string] {
	const i = line.indexOf('=');
	return i === -1 ? [line, ''] : [line.slice(0, i), line.slice(i + 1)];
}

/** Collects every string inside a (possibly nested) value, with a dotted path. */
function strings(v: unknown, path: string, out: { path: string; value: string }[]) {
	if (typeof v === 'string') out.push({ path, value: v });
	else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${path}[${i}]`, out));
	else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) strings(x, path ? `${path}.${k}` : k, out);
}

/** Candidates for every `postgres://` URL in the given strings. */
function urlCandidates(found: { path: string; value: string }[], label: string, source: ConnectionSource, missing: string[]): Candidate[] {
	const out: Candidate[] = [];
	for (const { path, value } of found) {
		for (const [url] of value.matchAll(PG_URL)) {
			const parsed = parsePostgresUrl(url.replaceAll(UNRESOLVED, 'tfunresolved'));
			if (!parsed) continue;
			if ([parsed.host, parsed.user, parsed.database].some((x) => x.includes('tfunresolved'))) continue;
			const notes: string[] = [];
			if (parsed.password?.includes('tfunresolved')) {
				parsed.password = undefined;
				notes.push(`Password comes from ${missing[0] ?? 'an expression pg·modern can’t evaluate'}.`);
			}
			out.push({ ...parsed, name: `${label}${path ? `.${path}` : ''}`, fingerprint: fingerprint(parsed), hasPassword: !!parsed.password, source, notes });
		}
	}
	return out;
}

function dockerHostOf(url: string | undefined): string | undefined {
	const m = /^(?:tcp|ssh|https?):\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/]+)/i.exec(url ?? '');
	return m ? m[1].replace(/^\[|\]$/g, '') : undefined;
}

/**
 * Postgres candidates from one Terraform module (all files of a single directory): the
 * `postgresql` provider and its login roles, Docker containers, RDS instances in
 * `terraform.tfstate`, and `postgres://` URLs in any attribute.
 */
export function terraformCandidates(files: TerraformFile[], ctx: TerraformContext): Candidate[] {
	const project = ctx.project;
	const m: Module = { vars: new Map(), declared: new Set(), locals: new Map(), resources: new Map(), state: new Map(), hasState: false };
	const blocks: Located[] = [];
	let stateDoc: { resources?: StateResource[]; outputs?: Record<string, { value?: unknown }> } | null = null;
	let statePath = '';

	for (const f of files) {
		if (STATE.test(f.path)) {
			try {
				const doc = JSON.parse(f.content);
				if (doc && typeof doc === 'object' && Array.isArray(doc.resources)) {
					stateDoc = doc;
					statePath = f.path;
				}
			} catch {
				/* not a usable state file */
			}
		} else if (/\.tf$/i.test(f.path)) {
			for (const block of parseHcl(f.content).blocks) {
				// A resource without both labels is broken; skip it rather than guess.
				if ((block.type === 'resource' || block.type === 'data') && block.labels.length < 2) continue;
				blocks.push({ block, file: f.path });
			}
		}
	}

	if (stateDoc) {
		m.hasState = true;
		for (const r of stateDoc.resources ?? []) {
			const attrs = r.instances?.[0]?.attributes;
			if (r.type && r.name && attrs) m.state.set(`${r.mode === 'data' ? 'data.' : ''}${r.type}.${r.name}`, attrs);
		}
	}

	for (const { block, file } of blocks) {
		if (block.type === 'variable' && block.labels[0]) {
			m.declared.add(block.labels[0]);
			const def = block.body.attrs.default;
			if (def !== undefined) m.vars.set(block.labels[0], { value: evaluate(def, m, newEval()) });
		} else if (block.type === 'locals') {
			for (const [k, v] of Object.entries(block.body.attrs)) m.locals.set(k, { value: v, file });
		} else if (block.type === 'resource' && block.labels.length >= 2) {
			m.resources.set(`${block.labels[0]}.${block.labels[1]}`, { block, file });
		}
	}

	// tfvars: later (higher-precedence) files override earlier ones, as Terraform does.
	const varFiles = files.filter((f) => TFVARS.test(f.path)).sort((a, b) => tfvarsRank(a.path) - tfvarsRank(b.path) || a.path.localeCompare(b.path));
	for (const f of varFiles) {
		let values: Record<string, unknown> = {};
		if (/\.json$/i.test(f.path)) {
			try {
				const doc = JSON.parse(f.content);
				if (doc && typeof doc === 'object' && !Array.isArray(doc)) values = doc;
			} catch {
				continue;
			}
		} else {
			const attrs = parseHcl(f.content).attrs;
			values = Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, evaluate(v, m, newEval())]));
		}
		for (const [k, v] of Object.entries(values)) if (v != null) m.vars.set(k, { value: v, file: f.path });
	}

	const out: Candidate[] = [];
	const refFor = (files: string[], fallback: string): ConnectionSource => ({ kind: 'terraform', ref: files[0] ?? fallback });

	// Docker host, for published ports.
	const dockerProvider = blocks.find((b) => b.block.type === 'provider' && b.block.labels[0] === 'docker');
	const dockerHost = ctx.publishedHost ?? dockerHostOf(dockerProvider ? scalar(dockerProvider.block.body.attrs.host, m).value : undefined) ?? 'localhost';

	// postgresql providers (and their login roles).
	type Provider = { host: string; port: number; user: string; database: string; sslMode: SslMode; notes: string[] };
	const providers = new Map<string, Provider>();
	for (const { block, file } of blocks) {
		if (block.type !== 'provider' || block.labels[0] !== 'postgresql') continue;
		const a = block.body.attrs;
		const notes: string[] = [];
		const host = scalar(a.host, m);
		const pw = scalar(a.password, m);
		const user = scalar(a.username, m);
		const db = scalar(a.database, m);
		noteMissing('Host', host, notes);
		noteMissing('Password', pw, notes);
		noteMissing('Username', user, notes);
		if (host.value === undefined && !host.missing.length) notes.push('No host set — assuming localhost.');
		const alias = scalar(a.alias, m).value ?? '';
		const p: Provider = {
			host: host.value || 'localhost',
			port: Number(scalar(a.port, m).value) || 5432,
			user: user.value || 'postgres',
			database: db.value || 'postgres',
			sslMode: sslFromParam(scalar(a.sslmode, m).value ?? null),
			notes
		};
		providers.set(alias, p);
		const base = { host: p.host, port: p.port, user: p.user, database: p.database };
		out.push({
			...base,
			fingerprint: fingerprint(base),
			name: `${project} · postgresql provider${alias ? ` (${alias})` : ''}`,
			password: pw.value,
			hasPassword: !!pw.value,
			sslMode: p.sslMode,
			source: refFor(pw.files, file),
			notes
		});
	}

	if (providers.size) {
		const databases = blocks.filter((b) => b.block.type === 'resource' && b.block.labels[0] === 'postgresql_database');
		for (const { block, file } of blocks) {
			if (block.type !== 'resource' || block.labels[0] !== 'postgresql_role') continue;
			const a = block.body.attrs;
			if (evaluate(a.login, m, newEval()) !== true) continue;
			const providerRef = a.provider instanceof HclExpr ? a.provider.text : '';
			const provider = providers.get(providerRef.split('.')[1] ?? '') ?? providers.get('');
			if (!provider) continue;
			const role = scalar(a.name, m).value ?? block.labels[1];
			const pw = scalar(a.password, m);
			let password = pw.value;
			if (password === undefined) {
				const st = m.state.get(`postgresql_role.${block.labels[1]}`)?.password;
				if (typeof st === 'string' && st) password = st;
			}
			if (!password) continue;
			const owned = databases.find((d) => scalar(d.block.body.attrs.owner, m).value === role);
			const database = owned ? (scalar(owned.block.body.attrs.name, m).value ?? owned.block.labels[1]) : provider.database;
			const base = { host: provider.host, port: provider.port, user: role, database };
			out.push({
				...base,
				fingerprint: fingerprint(base),
				name: `${project} · role ${role}`,
				password,
				hasPassword: true,
				sslMode: provider.sslMode,
				source: refFor(pw.value ? pw.files : [statePath], file),
				notes: []
			});
		}
	}

	// docker_container resources from config.
	const containers: TfContainer[] = [];
	for (const { block, file } of blocks) {
		if (block.type !== 'resource' || block.labels[0] !== 'docker_container') continue;
		const a = block.body.attrs;
		const env: Record<string, string> = {};
		const envMissing: Record<string, string> = {};
		const passwordFiles: string[] = [];
		const envList = evaluate(a.env, m, newEval());
		const items = Array.isArray(a.env) ? a.env : Array.isArray(envList) ? envList : [];
		for (const item of items) {
			const ev = newEval();
			const line = Array.isArray(a.env) ? evaluate(item as HclValue, m, ev) : item;
			if (typeof line !== 'string') continue;
			const [k, v] = splitEnv(line);
			if (k.includes(UNRESOLVED)) continue;
			env[k] = v.includes(UNRESOLVED) ? '' : v;
			if (v.includes(UNRESOLVED)) envMissing[k] = ev.missing[0] ?? 'an expression pg·modern can’t evaluate';
			if (/PASS/i.test(k)) passwordFiles.push(...ev.files);
		}
		const ports = block.body.blocks
			.filter((b) => b.type === 'ports')
			.map((b) => ({
				internal: Number(scalar(b.body.attrs.internal, m).value),
				external: Number(scalar(b.body.attrs.external, m).value) || undefined,
				ip: scalar(b.body.attrs.ip, m).value
			}));
		containers.push({
			name: scalar(a.name, m).value ?? block.labels[1],
			image: scalar(a.image, m).value ?? '',
			env,
			envMissing,
			ports,
			source: refFor(passwordFiles, file)
		});
	}

	// docker_container resources from state (the image is an ID there; map it back to its name).
	const stateResources = stateDoc?.resources ?? [];
	const imageNames = new Map<string, string>();
	for (const r of stateResources) {
		if (r.type !== 'docker_image') continue;
		for (const inst of r.instances ?? []) {
			const at = inst.attributes ?? {};
			if (typeof at.name !== 'string') continue;
			for (const id of [at.image_id, at.id, at.repo_digest]) if (typeof id === 'string') imageNames.set(id, at.name);
		}
	}
	for (const r of stateResources) {
		if (r.mode === 'data' || r.type !== 'docker_container') continue;
		for (const inst of r.instances ?? []) {
			const at = inst.attributes ?? {};
			const image = typeof at.image === 'string' ? (imageNames.get(at.image) ?? at.image) : '';
			const env = Object.fromEntries((Array.isArray(at.env) ? at.env : []).filter((x): x is string => typeof x === 'string').map(splitEnv));
			const ports = (Array.isArray(at.ports) ? at.ports : []).map((p: Record<string, unknown>) => ({
				internal: Number(p.internal),
				external: Number(p.external) || undefined,
				ip: typeof p.ip === 'string' ? p.ip : undefined
			}));
			const name = typeof at.name === 'string' ? at.name.replace(/^\//, '') : (r.name ?? 'container');
			containers.push({ name, image, env, envMissing: {}, ports, source: { kind: 'terraform', ref: statePath } });
		}
	}
	out.push(...containerCandidates(containers, project, dockerHost));

	// Managed databases in state.
	for (const r of stateResources) {
		if (r.mode === 'data') continue;
		for (const inst of r.instances ?? []) {
			const at = inst.attributes ?? {};
			const label = `${project} · ${r.type}.${r.name}${inst.index_key !== undefined ? `[${JSON.stringify(inst.index_key)}]` : ''}`;
			const str = (k: string) => (typeof at[k] === 'string' && at[k] ? (at[k] as string) : undefined);
			let c: { host?: string; port: number; user?: string; password?: string; database?: string; alt?: string } | null = null;
			if (r.type === 'aws_db_instance' && /postgres/i.test(str('engine') ?? '')) {
				c = {
					host: str('address') ?? str('endpoint')?.split(':')[0],
					port: Number(at.port) || 5432,
					user: str('username'),
					password: str('password'),
					database: str('db_name') ?? str('name')
				};
			} else if (r.type === 'aws_rds_cluster' && /postgres/i.test(str('engine') ?? '')) {
				c = {
					host: str('endpoint'),
					port: Number(at.port) || 5432,
					user: str('master_username'),
					password: str('master_password'),
					database: str('database_name'),
					alt: str('reader_endpoint')
				};
			}
			if (!c?.host || !c.user) continue;
			const notes: string[] = [];
			if (!c.password) {
				notes.push(
					at.manage_master_user_password === true
						? 'The master password is managed in AWS Secrets Manager; enter it manually.'
						: 'No password in the state file; enter it manually.'
				);
			}
			const base = { host: c.host, port: c.port, user: c.user, database: c.database ?? 'postgres' };
			out.push({
				...base,
				fingerprint: fingerprint(base),
				name: label,
				password: c.password,
				hasPassword: !!c.password,
				sslMode: 'require',
				source: { kind: 'terraform', ref: statePath },
				alternates: c.alt ? [{ host: c.alt, port: c.port, label: 'reader endpoint' }] : undefined,
				notes
			});
		}
	}

	// postgres:// URLs anywhere: config attributes (nested blocks included), variable values, state.
	const sweep = (body: HclBody, label: string, file: string) => {
		for (const [k, v] of Object.entries(body.attrs)) {
			const ev = newEval();
			const found: { path: string; value: string }[] = [];
			strings(evaluate(v, m, ev), '', found);
			out.push(...urlCandidates(found, `${label}.${k}`, refFor(ev.files, file), ev.missing));
		}
		for (const b of body.blocks) sweep(b.body, `${label}.${b.type}`, file);
	};
	for (const { block, file } of blocks) {
		if (block.type === 'provider' || block.type === 'terraform') continue;
		if (block.type === 'variable') continue;
		sweep(block.body, `${project} · ${block.type === 'resource' ? block.labels.join('.') : blockAddr(block)}`, file);
	}
	for (const [name, v] of m.vars) {
		const found: { path: string; value: string }[] = [];
		strings(v.value, '', found);
		const decl = blocks.find((b) => b.block.type === 'variable' && b.block.labels[0] === name);
		out.push(...urlCandidates(found, `${project} · var.${name}`, refFor(v.file ? [v.file] : [], decl?.file ?? files[0]?.path ?? project), []));
	}
	if (stateDoc) {
		for (const r of stateResources) {
			for (const inst of r.instances ?? []) {
				const found: { path: string; value: string }[] = [];
				strings(inst.attributes ?? {}, '', found);
				out.push(...urlCandidates(found, `${project} · ${r.type}.${r.name}`, { kind: 'terraform', ref: statePath }, []));
			}
		}
		for (const [k, o] of Object.entries(stateDoc.outputs ?? {})) {
			const found: { path: string; value: string }[] = [];
			strings(o?.value, '', found);
			out.push(...urlCandidates(found, `${project} · output.${k}`, { kind: 'terraform', ref: statePath }, []));
		}
	}

	// The same server is often found several ways (config + state, URL + container); keep one, preferring a password.
	const byFp = new Map<string, Candidate>();
	for (const c of out) {
		const prev = byFp.get(c.fingerprint);
		if (!prev || (!prev.password && c.password)) byFp.set(c.fingerprint, c);
	}
	return [...byFp.values()];
}

interface StateResource {
	mode?: string;
	type?: string;
	name?: string;
	instances?: { index_key?: unknown; attributes?: Record<string, unknown> }[];
}

/** Whether a file name belongs to a Terraform module (config, variables or local state). */
export function isTerraformFile(name: string): boolean {
	return /\.(tf|tfvars)$|\.tfvars\.json$|^terraform\.tfstate$/i.test(name);
}
