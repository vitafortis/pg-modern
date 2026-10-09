/**
 * Engine dispatch: API routes call these, and each call goes to the Postgres
 * implementation (pg.ts, introspect.ts, activity.ts — unchanged), the MySQL /
 * MariaDB one (mysql/*) or the SQLite one (sqlite/*) depending on the connection's engine.
 */
import * as pg from './pg.ts';
import * as pgIntrospect from './introspect.ts';
import * as pgActivity from './activity.ts';
import * as my from './mysql/client.ts';
import * as myIntrospect from './mysql/introspect.ts';
import * as myActivity from './mysql/activity.ts';
import { health as pgHealth } from './health.ts';
import { mysqlHealth } from './mysql/health.ts';
import type { HealthReport } from '#lib/health.ts';
import * as lite from './sqlite/client.ts';
import * as liteIntrospect from './sqlite/introspect.ts';
import { isDestructiveMysql } from './mysql/classify.ts';
import { isDestructiveSqlite } from './sqlite/classify.ts';
import { isDestructive as isDestructivePg, splitStatements as splitPg } from './sql.ts';
import { getConnection, getPassword, setFlavor, touchConnection } from './store.ts';
import { flavorFromVersion, shortVersion } from '#lib/engine.ts';
import type { Engine, Flavor, QueryError, SslMode } from '#lib/types.ts';
import type { BrowseParams } from './introspect.ts';

export { NotFound } from './pg.ts';

function engineOf(id: string): Engine {
	const conn = getConnection(id);
	if (!conn) throw new pg.NotFound('Connection not found');
	return conn.engine;
}

// --- errors ----------------------------------------------------------------------

/** Maps Postgres, MySQL and SQLite errors (and network failures) to the API's QueryError. */
export function toQueryError(err: unknown): QueryError {
	if (lite.isSqliteError(err)) return lite.toSqliteError(err);
	if (my.isMysqlError(err)) return my.toMysqlError(err, pg.NETWORK_HINTS);
	return pg.toQueryError(err);
}

/** An error the database server reported (syntax, missing table, permission), not a crash. */
export function isServerError(err: unknown): boolean {
	if (!err || typeof err !== 'object') return false;
	if (lite.isSqliteError(err)) return err.errcode != null;
	if ('severity' in err && typeof (err as { code?: unknown }).code === 'string') return true;
	return my.isMysqlError(err) && typeof (err as { errno?: unknown }).errno === 'number';
}

// --- statements ----------------------------------------------------------------------

export function splitStatements(engine: Engine, sql: string): string[] {
	if (engine === 'sqlite') return lite.splitSqlite(sql);
	return engine === 'mysql' ? my.splitMysql(sql) : splitPg(sql);
}

export function isDestructive(engine: Engine, sql: string): boolean {
	if (engine === 'sqlite') return isDestructiveSqlite(sql);
	return engine === 'mysql' ? isDestructiveMysql(sql) : isDestructivePg(sql);
}

/** Statements that need a confirmation before running with write access. */
export function destructiveStatements(id: string, sql: string): string[] {
	const engine = engineOf(id);
	return splitStatements(engine, sql).filter((s) => isDestructive(engine, s));
}

// --- connections -------------------------------------------------------------------

export interface TestTarget {
	engine?: Engine;
	host: string;
	port: number;
	/** For SQLite, the file path. */
	database: string;
	user: string;
	password?: string;
	sslMode: SslMode;
	readOnly: boolean;
}

export type TestResult =
	| { ok: true; version: string; latencyMs: number; engine: Engine; flavor: Flavor; serverVersion: string }
	| { ok: false; error: QueryError };

/** Tests credentials (or a SQLite file) without persisting anything. */
export async function testTarget(t: TestTarget): Promise<TestResult> {
	const engine = t.engine ?? 'postgres';
	if (engine === 'postgres') {
		const r = await pg.testTarget(t);
		return r.ok ? { ...r, engine, flavor: 'postgres', serverVersion: shortVersion('postgres', r.version) } : r;
	}
	const started = performance.now();
	try {
		if (engine === 'sqlite') {
			const { version } = await lite.testSqlite(t.database);
			return { ok: true, version, latencyMs: Math.round(performance.now() - started), engine, flavor: 'sqlite', serverVersion: shortVersion('sqlite', version) };
		}
		const { version, flavor } = await my.testMysql(t);
		return { ok: true, version, latencyMs: Math.round(performance.now() - started), engine, flavor, serverVersion: shortVersion('mysql', version) };
	} catch (err) {
		return { ok: false, error: engine === 'sqlite' ? lite.toSqliteError(err, t.database) : toQueryError(err) };
	}
}

export async function testConnection(id: string): Promise<TestResult> {
	const conn = getConnection(id);
	if (!conn) throw new pg.NotFound('Connection not found');
	if (conn.engine === 'postgres') {
		const r = await pg.testConnection(id);
		return r.ok ? { ...r, engine: 'postgres', flavor: 'postgres', serverVersion: shortVersion('postgres', r.version) } : r;
	}
	if (conn.engine === 'sqlite') {
		const started = performance.now();
		try {
			const { version } = await lite.testSaved(id);
			return { ok: true, version, latencyMs: Math.round(performance.now() - started), engine: 'sqlite', flavor: 'sqlite', serverVersion: shortVersion('sqlite', version) };
		} catch (err) {
			return { ok: false, error: lite.toSqliteError(err, conn.snapshot ? undefined : conn.database) };
		}
	}
	const result = await testTarget({ ...conn, password: conn.engine === 'mysql' ? getPassword(id) : undefined });
	if (result.ok) {
		touchConnection(id);
		const flavor = flavorFromVersion(conn.engine, result.version);
		if (conn.flavor !== flavor) setFlavor(id, flavor);
	}
	return result;
}

export function closePool(id: string) {
	pg.closePool(id);
	my.closePool(id);
	lite.closePool(id);
}

// --- queries -----------------------------------------------------------------------

export type ScriptOutcome = pg.ScriptOutcome;

export async function runScript(id: string, script: string, opts: { runId?: string; maxRows?: number; readOnly: boolean }): Promise<ScriptOutcome> {
	const engine = engineOf(id);
	if (engine === 'sqlite') return lite.runScript(id, script, opts);
	return engine === 'mysql' ? my.runScript(id, script, opts, pg.NETWORK_HINTS) : pg.runScript(id, script, opts);
}

export async function cancelRun(id: string, runId: string): Promise<boolean> {
	const engine = engineOf(id);
	if (engine === 'sqlite') return lite.cancelRun(id, runId);
	return engine === 'mysql' ? my.cancelRun(id, runId) : pg.cancelRun(id, runId);
}

export function explainProblem(id: string, sql: string, opts: { analyze: boolean; readOnly: boolean }): string | null {
	const engine = engineOf(id);
	if (engine === 'sqlite') return lite.explainProblem(sql, opts.analyze);
	return engine === 'mysql' ? my.mysqlExplainProblem(sql, opts.analyze, opts.readOnly) : pg.explainProblem(sql);
}

/** Whether explaining this would really execute a write (Postgres EXPLAIN ANALYZE only). */
export function explainExecutesWrite(id: string, sql: string, analyze: boolean, readOnly: boolean): boolean {
	return engineOf(id) === 'postgres' && analyze && !readOnly && pg.modifiesData(sql);
}

export async function explainStatement(id: string, sql: string, opts: { analyze: boolean; readOnly: boolean; runId?: string }) {
	const engine = engineOf(id);
	if (engine === 'sqlite') return lite.explainSqlite(id, sql, opts);
	return engine === 'mysql' ? my.explainMysql(id, sql, opts) : pg.explainStatement(id, sql, opts);
}

// --- introspection -------------------------------------------------------------------

export async function schemaTree(id: string, includeSystem = false) {
	const engine = engineOf(id);
	if (engine === 'sqlite') return liteIntrospect.schemaTree(id, includeSystem);
	return engine === 'mysql' ? myIntrospect.schemaTree(id, includeSystem) : pgIntrospect.schemaTree(id, includeSystem);
}

export async function browse(id: string, p: BrowseParams) {
	const engine = engineOf(id);
	if (engine === 'sqlite') return liteIntrospect.browse(id, p);
	return engine === 'mysql' ? myIntrospect.browse(id, p) : pgIntrospect.browse(id, p);
}

export async function structure(id: string, schema: string, table: string) {
	const engine = engineOf(id);
	if (engine === 'sqlite') return liteIntrospect.structure(id, schema, table);
	return engine === 'mysql' ? myIntrospect.structure(id, schema, table) : pgIntrospect.structure(id, schema, table);
}

export async function overview(id: string) {
	const engine = engineOf(id);
	if (engine === 'sqlite') return liteIntrospect.overview(id);
	if (engine === 'mysql') return myIntrospect.overview(id);
	return { engine: 'postgres' as const, flavor: 'postgres' as const, ...(await pgIntrospect.overview(id)) };
}

export async function completionSchema(id: string) {
	const engine = engineOf(id);
	if (engine === 'sqlite') return liteIntrospect.completionSchema(id);
	return engine === 'mysql' ? myIntrospect.completionSchema(id) : pgIntrospect.completionSchema(id);
}

export async function diagram(id: string, schema: string, opts: { views?: boolean } = {}) {
	const engine = engineOf(id);
	if (engine === 'sqlite') return liteIntrospect.diagram(id, schema, opts);
	return engine === 'mysql' ? myIntrospect.diagram(id, schema, opts) : pgIntrospect.diagram(id, schema, opts);
}

// --- activity ------------------------------------------------------------------------

/** SQLite has no server, so no sessions to show (the UI hides the Activity tab). */
class NoActivity extends Error {}

export async function activity(id: string) {
	const engine = engineOf(id);
	if (engine === 'sqlite') throw new NoActivity('SQLite has no server sessions to show.');
	return engine === 'mysql' ? myActivity.mysqlActivity(id) : pgActivity.activity(id);
}

export async function signalBackend(id: string, pid: number, terminate: boolean) {
	const engine = engineOf(id);
	if (engine === 'sqlite') throw new NoActivity('SQLite has no server sessions to signal.');
	return engine === 'mysql' ? myActivity.mysqlSignal(id, pid, terminate) : pgActivity.signalBackend(id, pid, terminate);
}

// --- health ----------------------------------------------------------------------------

/** Health checks for engines that have them; null for others (the tab is hidden there). */
export async function health(id: string): Promise<HealthReport | null> {
	const engine: string = engineOf(id);
	if (engine === 'postgres') return pgHealth(id);
	if (engine === 'mysql') return mysqlHealth(id);
	return null;
}
