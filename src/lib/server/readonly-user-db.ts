/**
 * The database side of the read-only user helper: what the generator needs to know
 * (schemas, their owners, databases), whether a connection uses an over-privileged
 * account, and applying the generated statements over the write path.
 */
import { readQuery as pgRead, toQueryError, withClient } from './pg.ts';
import { readQuery as myRead, toMysqlError, withConnection } from './mysql/client.ts';
import { SYSTEM_DATABASES, grants, summarizeGrants } from './mysql/introspect.ts';
import { SYSTEM_SCHEMA_FILTER } from './introspect.ts';
import { getConnection } from './store.ts';
import { NotFound } from './pg.ts';
import type { GeneratedStatement, PgSchemaGrant } from './readonly-user.ts';
import type { QueryError } from '#lib/types.ts';

export interface ReadOnlyUserContext {
	engine: 'postgres' | 'mysql';
	currentUser: string;
	/** Superuser (Postgres) or an account with global ALL/SUPER, or root (MySQL). */
	elevated: boolean;
	database: string;
	/** Postgres: non-system schemas and the roles that own objects in them. */
	schemas?: PgSchemaGrant[];
	/** Postgres 14+ has pg_read_all_data. */
	hasReadAllData?: boolean;
	serverVersionNum?: number;
	/** MySQL: non-system databases. */
	databases?: string[];
	noBackslashEscapes?: boolean;
}

type Row = Record<string, unknown>;

/** Thrown for engines the helper doesn't support (e.g. SQLite has no users). */
export class Unsupported extends Error {}

function engineOf(id: string) {
	const conn = getConnection(id);
	if (!conn) throw new NotFound('Connection not found');
	const engine: string = conn.engine;
	if (engine !== 'postgres' && engine !== 'mysql') throw new Unsupported('Database users aren’t available for this engine');
	return conn;
}

export async function readOnlyUserContext(id: string): Promise<ReadOnlyUserContext> {
	const conn = engineOf(id);
	if (conn.engine === 'mysql') {
		const [[info], dbs, grantList] = await Promise.all([
			myRead<Row>(id, `SELECT CURRENT_USER() AS u, DATABASE() AS db, @@SESSION.sql_mode AS mode`),
			myRead<Row>(id, `SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN (${SYSTEM_DATABASES.map((d) => `'${d}'`).join(', ')}) ORDER BY 1`),
			grants(id).catch(() => [] as string[])
		]);
		const user = String(info.u ?? '');
		return {
			engine: 'mysql',
			currentUser: user,
			elevated: mysqlElevated(user, grantList),
			database: String(info.db ?? conn.database ?? ''),
			databases: dbs.map((d) => String(d.name)),
			noBackslashEscapes: /NO_BACKSLASH_ESCAPES/i.test(String(info.mode ?? ''))
		};
	}
	const [[info], schemas] = await Promise.all([
		pgRead<Row>(
			id,
			`select current_database() as db, current_user as u, coalesce((select rolsuper from pg_roles where rolname = current_user), false) as su,
				current_setting('server_version_num')::int as ver, exists (select 1 from pg_roles where rolname = 'pg_read_all_data') as read_all_data`
		),
		pgRead<Row>(
			id,
			`select n.nspname as name,
				to_json(array(select distinct r from (
					select pg_get_userbyid(n.nspowner) as r
					union select pg_get_userbyid(c.relowner) from pg_class c where c.relnamespace = n.oid and c.relkind in ('r', 'v', 'm', 'p', 'f', 'S')
				) o where r not like 'pg\\_%' order by r)) as owners
			 from pg_namespace n where ${SYSTEM_SCHEMA_FILTER} order by 1`
		)
	]);
	return {
		engine: 'postgres',
		currentUser: String(info.u),
		elevated: info.su === true,
		database: String(info.db),
		schemas: schemas.map((s) => ({ name: String(s.name), owners: (s.owners as string[]) ?? [] })),
		hasReadAllData: info.read_all_data === true,
		serverVersionNum: Number(info.ver)
	};
}

/** root, or global ALL PRIVILEGES / SUPER. */
export function mysqlElevated(currentUser: string, grantList: string[]): boolean {
	const name = currentUser.replace(/@.*$/, '').replace(/^[`'"]|[`'"]$/g, '');
	return name === 'root' || summarizeGrants(grantList).superuser;
}

const elevatedCache = new Map<string, { version: string; at: number; value: { elevated: boolean; currentUser: string } }>();
const ELEVATED_TTL_MS = 10 * 60_000;

/** Cheap, cached check for the connection-card hint. */
export async function privilegeSummary(id: string): Promise<{ elevated: boolean; currentUser: string }> {
	const conn = engineOf(id);
	const hit = elevatedCache.get(id);
	if (hit && hit.version === conn.updatedAt && Date.now() - hit.at < ELEVATED_TTL_MS) return hit.value;
	let value: { elevated: boolean; currentUser: string };
	if (conn.engine === 'mysql') {
		const [[info], grantList] = await Promise.all([myRead<Row>(id, 'SELECT CURRENT_USER() AS u'), grants(id).catch(() => [] as string[])]);
		value = { currentUser: String(info.u ?? ''), elevated: mysqlElevated(String(info.u ?? ''), grantList) };
	} else {
		const [r] = await pgRead<Row>(id, `select current_user as u, coalesce((select rolsuper from pg_roles where rolname = current_user), false) as su`);
		value = { currentUser: String(r.u), elevated: r.su === true };
	}
	elevatedCache.set(id, { version: conn.updatedAt, at: Date.now(), value });
	return value;
}

export function forgetPrivileges(id: string) {
	elevatedCache.delete(id);
}

/** Does a role (Postgres) or account (MySQL) with this name exist already? Null when we can't tell. */
export async function accountExists(id: string, name: string, host?: string): Promise<boolean | null> {
	const conn = engineOf(id);
	try {
		if (conn.engine === 'mysql') {
			const rows = await myRead<Row>(id, 'SELECT 1 AS x FROM mysql.user WHERE User = ? AND Host = ?', [name, host ?? '%']);
			return rows.length > 0;
		}
		const rows = await pgRead<Row>(id, 'select 1 as x from pg_roles where rolname = $1', [name]);
		return rows.length > 0;
	} catch {
		return null;
	}
}

export type ApplyOutcome = { ok: true; applied: number } | { ok: false; applied: number; error: QueryError & { statementIndex: number; sql: string } };

/**
 * Runs generated statements with write access. Postgres runs them in one transaction
 * (all or nothing); MySQL commits each GRANT/CREATE USER as it goes, so `applied`
 * says how far it got. Callers check the user's write access first.
 */
export async function applyStatements(id: string, statements: GeneratedStatement[]): Promise<ApplyOutcome> {
	const conn = engineOf(id);
	if (conn.engine === 'mysql') {
		return withConnection(id, { readOnly: false }, async (c) => {
			let i = 0;
			try {
				for (; i < statements.length; i++) await c.query(statements[i].sql);
				return { ok: true, applied: i };
			} catch (err) {
				return { ok: false, applied: i, error: { ...toMysqlError(err, {}), statementIndex: i, sql: statements[i].display } };
			}
		});
	}
	return withClient(id, { readOnly: false }, async (client) => {
		let i = 0;
		await client.query('BEGIN');
		try {
			for (; i < statements.length; i++) await client.query(statements[i].sql);
			await client.query('COMMIT');
			return { ok: true, applied: i };
		} catch (err) {
			await client.query('ROLLBACK').catch(() => {});
			return { ok: false, applied: 0, error: { ...toQueryError(err), statementIndex: i, sql: statements[i]?.display ?? '' } };
		}
	});
}
