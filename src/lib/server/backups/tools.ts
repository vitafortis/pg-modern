/**
 * The client binaries backups shell out to (pg_dump / pg_restore, mariadb-dump or
 * mysqldump / mariadb or mysql) and how to call them. Passwords always go through
 * the environment (PGPASSWORD / MYSQL_PWD), never the command line.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Connection, SslMode } from '#lib/types.ts';

export interface Tool {
	/** Binary name found on PATH. */
	bin: string;
	version: string;
	/** MariaDB's client tools take different TLS flags than Oracle MySQL's. */
	mariadb?: boolean;
}

export interface ToolStatus {
	pgDump: Tool | null;
	pgRestore: Tool | null;
	mysqlDump: Tool | null;
	mysqlClient: Tool | null;
}

const CANDIDATES = {
	pgDump: ['pg_dump'],
	pgRestore: ['pg_restore'],
	mysqlDump: ['mariadb-dump', 'mysqldump'],
	mysqlClient: ['mariadb', 'mysql']
} as const;

/** Runs a command to completion, capturing output (for --version and small queries). */
export function capture(bin: string, args: string[], env: NodeJS.ProcessEnv = {}, timeoutMs = 20_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (d) => (stdout += d));
		child.stderr.on('data', (d) => (stderr += d));
		child.on('error', reject);
		child.on('close', (code) => resolve({ code, stdout, stderr }));
	});
}

async function probe(names: readonly string[]): Promise<Tool | null> {
	for (const bin of names) {
		try {
			const r = await capture(bin, ['--version'], {}, 5_000);
			if (r.code === 0) {
				const version = (r.stdout || r.stderr).trim().split('\n')[0];
				return { bin, version, mariadb: /mariadb/i.test(version) || bin.startsWith('mariadb') };
			}
		} catch {
			// not installed
		}
	}
	return null;
}

let cached: { at: number; status: ToolStatus } | undefined;

export async function toolStatus(fresh = false): Promise<ToolStatus> {
	if (!fresh && cached && Date.now() - cached.at < 60_000) return cached.status;
	const [pgDump, pgRestore, mysqlDump, mysqlClient] = await Promise.all([
		probe(CANDIDATES.pgDump),
		probe(CANDIDATES.pgRestore),
		probe(CANDIDATES.mysqlDump),
		probe(CANDIDATES.mysqlClient)
	]);
	cached = { at: Date.now(), status: { pgDump, pgRestore, mysqlDump, mysqlClient } };
	return cached.status;
}

export class MissingTool extends Error {}

export function requireTool(t: Tool | null, what: string): Tool {
	if (!t) {
		throw new MissingTool(
			`${what} isn't installed on the pg·modern server. The Docker image ships it; when running from source, install the ` +
				(what.startsWith('pg_') ? 'PostgreSQL client tools (e.g. `brew install libpq` or `apk add postgresql18-client`)' : 'MariaDB client (e.g. `brew install mariadb` or `apk add mariadb-client`)') +
				' and make sure it is on PATH.'
		);
	}
	return t;
}

export interface Command {
	bin: string;
	args: string[];
	env: NodeJS.ProcessEnv;
}

type Target = Pick<Connection, 'host' | 'port' | 'user' | 'sslMode'> & { database: string; password?: string };

// --- Postgres ------------------------------------------------------------------------

function pgEnv(t: Target): NodeJS.ProcessEnv {
	return {
		PGPASSWORD: t.password ?? '',
		PGSSLMODE: t.sslMode,
		// verify-full checks against the system CA store (libpq 16+).
		...(t.sslMode === 'verify-full' ? { PGSSLROOTCERT: 'system' } : {}),
		PGCONNECT_TIMEOUT: '15',
		PGAPPNAME: 'pg-modern-backup'
	};
}

function pgConnArgs(t: Target): string[] {
	return [`--host=${t.host}`, `--port=${t.port}`, `--username=${t.user}`, `--dbname=${t.database}`, '--no-password'];
}

/** Custom format (-Fc) is compressed by pg_dump itself; `compress: false` stores it uncompressed (-Z0). */
export function pgDumpCommand(tool: Tool, t: Target, compress: boolean): Command {
	return { bin: tool.bin, args: ['--format=custom', ...(compress ? [] : ['--compress=0']), ...pgConnArgs(t)], env: pgEnv(t) };
}

/** Reads the dump from stdin. --clean --if-exists drops what the dump recreates; --no-owner so another server's roles don't matter. */
export function pgRestoreCommand(tool: Tool, t: Target): Command {
	return { bin: tool.bin, args: ['--clean', '--if-exists', '--no-owner', ...pgConnArgs(t)], env: pgEnv(t) };
}

// --- MySQL / MariaDB ---------------------------------------------------------------

/** TLS flags per client flavor. `prefer` tries TLS without verifying (callers retry without on failure). */
export function mysqlSslArgs(tool: Tool, mode: SslMode, plain = false): string[] {
	if (tool.mariadb) {
		if (mode === 'disable' || plain) return ['--skip-ssl'];
		if (mode === 'verify-full') return ['--ssl', '--ssl-verify-server-cert'];
		return ['--ssl', '--skip-ssl-verify-server-cert'];
	}
	if (mode === 'disable' || plain) return ['--ssl-mode=DISABLED'];
	if (mode === 'verify-full') return ['--ssl-mode=VERIFY_IDENTITY'];
	return [mode === 'require' ? '--ssl-mode=REQUIRED' : '--ssl-mode=PREFERRED'];
}

function mysqlConnArgs(tool: Tool, t: Target, plain: boolean): string[] {
	return [`--host=${t.host}`, `--port=${t.port}`, `--user=${t.user}`, '--protocol=TCP', '--connect-timeout=15', ...mysqlSslArgs(tool, t.sslMode, plain)];
}

const mysqlEnv = (t: Target): NodeJS.ProcessEnv => ({ MYSQL_PWD: t.password ?? '' });

/** Schemas that belong to the server, not to an app. */
export const MYSQL_SYSTEM_SCHEMAS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);

/**
 * Checks the login with the client tool and picks TLS flags that work (falling back to
 * plain only for `prefer`). Returns the user databases, for dumping "every database".
 */
export async function mysqlPreflight(client: Tool, t: Target): Promise<{ plain: boolean; databases: string[] }> {
	const attempt = (plain: boolean) => capture(client.bin, [...mysqlConnArgs(client, t, plain), '--batch', '--skip-column-names', '--execute=SHOW DATABASES'], mysqlEnv(t));
	let plain = false;
	let r = await attempt(false);
	if (r.code !== 0 && t.sslMode === 'prefer' && /ssl|tls/i.test(r.stderr)) {
		plain = true;
		r = await attempt(true);
	}
	if (r.code !== 0) throw new Error(cleanStderr(r.stderr) || `${client.bin} exited with code ${r.code}`);
	const databases = r.stdout
		.split('\n')
		.map((s) => s.trim())
		.filter((s) => s && !MYSQL_SYSTEM_SCHEMAS.has(s.toLowerCase()));
	return { plain, databases };
}

/**
 * One database (restorable into any database name), or several with `--databases`
 * (the dump then creates and selects each one itself).
 */
export function mysqlDumpCommand(tool: Tool, t: Target, databases: string[], plain: boolean): Command {
	const args = [
		...mysqlConnArgs(tool, t, plain),
		'--single-transaction',
		'--routines',
		'--triggers',
		'--events',
		'--hex-blob',
		'--no-tablespaces',
		'--default-character-set=utf8mb4'
	];
	if (databases.length === 1 && t.database) args.push('--', databases[0]);
	else args.push('--databases', '--', ...databases);
	return { bin: tool.bin, args, env: mysqlEnv(t) };
}

/** Pipes SQL from stdin into `database` (or into whatever the dump selects when empty). */
export function mysqlRestoreCommand(tool: Tool, t: Target, plain: boolean): Command {
	const args = [...mysqlConnArgs(tool, t, plain), '--default-character-set=utf8mb4', '--binary-mode'];
	if (t.database) args.push(`--database=${t.database}`);
	return { bin: tool.bin, args, env: mysqlEnv(t) };
}

// --- processes -----------------------------------------------------------------------

/** Drops noise (password-on-command-line warnings, pg_dump's "warning: errors ignored" footer is kept). */
export function cleanStderr(s: string): string {
	return s
		.split('\n')
		.filter((l) => l.trim() && !/Using a password on the command line|Deprecated program name/i.test(l))
		.join('\n')
		.trim()
		.slice(-4000);
}

export interface Running {
	child: ChildProcess;
	/** Resolves when the process exits; never rejects (spawn errors become code null + message). */
	done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
}

export function start(cmd: Command, stdin: 'pipe' | 'ignore'): Running {
	const child = spawn(cmd.bin, cmd.args, { env: { ...process.env, ...cmd.env }, stdio: [stdin, 'pipe', 'pipe'] });
	let stderr = '';
	child.stderr!.on('data', (d) => {
		stderr += d;
		if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
	});
	const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve) => {
		child.on('error', (err) => resolve({ code: null, signal: null, stderr: `${stderr}\n${err.message}` }));
		child.on('close', (code, signal) => resolve({ code, signal, stderr: cleanStderr(stderr) }));
	});
	return { child, done };
}
