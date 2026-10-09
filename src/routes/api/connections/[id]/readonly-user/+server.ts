import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { NotFound } from '#lib/server/engine.ts';
import { audit, readOnlyFor } from '#lib/server/permissions.ts';
import { getConnection } from '#lib/server/store.ts';
import { accountExists, applyStatements, privilegeSummary, readOnlyUserContext, Unsupported } from '#lib/server/readonly-user-db.ts';
import {
	mysqlReadOnlyUserSql,
	pgReadOnlyUserSql,
	renderScript,
	validateMysql,
	validatePg,
	type GeneratedStatement,
	type MysqlReadOnlyOptions,
	type PgReadOnlyOptions
} from '#lib/server/readonly-user.ts';
import type { User } from '#lib/types.ts';
import type { RequestHandler } from './$types';

function requireAdmin(user: User | null) {
	if (user?.role !== 'admin') throw json({ message: 'Admins only' }, { status: 403 });
}

const unsupported = <T>(p: Promise<T>) =>
	p.catch((err) => {
		if (err instanceof Unsupported) throw new BadRequest(err.message);
		throw err;
	});

/** What the generator needs (schemas and owners, databases), or with `?brief=1` just whether the account is over-privileged. */
export const GET: RequestHandler = handler(async ({ params, url, locals }) => {
	requireAdmin(locals.user);
	if (url.searchParams.get('brief') === '1') return json(await unsupported(privilegeSummary(params.id)));
	return json(await unsupported(readOnlyUserContext(params.id)));
});

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Builds the statements from the request, filling in what only the server knows (database, sql_mode). */
async function build(id: string, body: Record<string, unknown>): Promise<{ statements: GeneratedStatement[]; engine: 'postgres' | 'mysql'; name: string; host?: string; summary: string }> {
	const ctx = await unsupported(readOnlyUserContext(id));
	const o = (body.options ?? {}) as Record<string, unknown>;
	if (ctx.engine === 'mysql') {
		const opts: MysqlReadOnlyOptions = {
			user: str(o.user).trim(),
			host: str(o.host).trim() || '%',
			password: str(o.password),
			databases: o.databases === '*' ? '*' : strings(o.databases),
			process: o.process === true,
			performanceSchema: o.performanceSchema === true,
			noBackslashEscapes: ctx.noBackslashEscapes
		};
		const problem = validateMysql(opts);
		if (problem) throw new BadRequest(problem);
		const dbs = opts.databases === '*' ? 'all databases' : opts.databases.join(', ');
		return {
			statements: mysqlReadOnlyUserSql(opts),
			engine: 'mysql',
			name: opts.user,
			host: opts.host,
			summary: `'${opts.user}'@'${opts.host}' (${dbs}${opts.process ? '; PROCESS' : ''}${opts.performanceSchema ? '; performance_schema' : ''})`
		};
	}
	const schemas = Array.isArray(o.schemas)
		? (o.schemas as unknown[])
				.filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
				.map((s) => ({ name: str(s.name), owners: strings(s.owners) }))
				.filter((s) => s.name)
		: [];
	const opts: PgReadOnlyOptions = {
		role: str(o.role).trim(),
		password: str(o.password),
		database: ctx.database,
		mode: o.mode === 'read_all_data' ? 'read_all_data' : 'schemas',
		schemas,
		defaultPrivileges: o.defaultPrivileges !== false,
		monitor: o.monitor === true,
		readAllStats: o.readAllStats === true,
		prehash: o.prehash !== false
	};
	if (opts.mode === 'read_all_data' && !ctx.hasReadAllData) throw new BadRequest('pg_read_all_data needs Postgres 14 or later.');
	const problem = validatePg(opts);
	if (problem) throw new BadRequest(problem);
	const scope = opts.mode === 'read_all_data' ? 'pg_read_all_data' : `schemas ${schemas.map((s) => s.name).join(', ')}`;
	return {
		statements: pgReadOnlyUserSql(opts),
		engine: 'postgres',
		name: opts.role,
		summary: `role ${opts.role} (${scope}${opts.monitor ? '; pg_monitor' : opts.readAllStats ? '; pg_read_all_stats' : ''})`
	};
}

/**
 * `preview`: the script (with and without the password) and whether the name is taken.
 * `apply`: runs it — only with write access right now, and only once confirmed.
 */
export const POST: RequestHandler = handler(async ({ params, request, locals }) => {
	requireAdmin(locals.user);
	const conn = getConnection(params.id);
	if (!conn) throw new NotFound('Connection not found');
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const built = await build(conn.id, body);
	const transaction = built.engine === 'postgres';
	const header = `Read-only user for pg·modern on ${conn.name}. Review, then run it as an administrator.`;

	if (body.action === 'preview') {
		return json({
			script: renderScript(built.statements, { transaction, header }),
			redacted: renderScript(built.statements, { transaction, header, redact: true }),
			exists: await accountExists(conn.id, built.name, built.host)
		});
	}
	if (body.action !== 'apply') throw new BadRequest('"action" must be preview or apply');

	if (readOnlyFor(locals.user, conn.id)) {
		return json({ message: 'This connection is read-only. Unlock writes (or make it read/write) to apply, or copy the script and run it elsewhere.' }, { status: 403 });
	}
	if (body.confirmed !== true) {
		return json({ message: 'Confirm these statements', confirm: built.statements.map((s) => s.display) }, { status: 409 });
	}
	const outcome = await applyStatements(conn.id, built.statements);
	audit(locals, 'readonly-user.apply', {
		connection: conn,
		detail: outcome.ok ? `created ${built.summary}` : `failed at statement ${outcome.error.statementIndex + 1} (${outcome.error.message}) — ${built.summary}`
	});
	return json(outcome);
});
