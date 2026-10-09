import type { Engine, Flavor } from '#lib/types.ts';

/** Postgres server images: anything named *postgres* plus well-known forks and extensions. */
export const PG_IMAGE =
	/(^|\/)[\w.-]*(postgres|postgis|timescaledb|pgvector|pgvecto|paradedb|spilo|pgautoupgrade|vectorchord|orioledb|citus)[\w.-]*(:|@|$)|immich-app\/postgres|tensorchord\/|apache\/age|cloudnative-pg/i;

/** MySQL-protocol server images: MySQL, MariaDB, Percona and their common repackagings. */
export const MYSQL_IMAGE = /(^|\/)[\w.-]*(mysql|mariadb|percona)[\w.-]*(:|@|$)|mysql\/mysql-server|alpine-mariadb|linuxserver\/mariadb|yobasystems\//i;

/** Images that merely talk to a database (admin UIs, proxies, exporters, backups) — not servers themselves. */
const NOT_A_SERVER =
	/pgadmin|adminer|pgbouncer|pgcat|pgpool|postgres[_-]?exporter|pgweb|pghero|pgbackrest|wal-g|postgrest|pg_?dump|backup|phpmyadmin|mysqld?[_-]?exporter|proxysql|maxscale|mysql[_-]?router|mydumper|mysqldump|xtrabackup|mariabackup|dbgate|cloudbeaver|sqlpad/i;

/** Env vars that only a Postgres server container sets (official images bake in PG_VERSION/PG_MAJOR/PGDATA). */
const SERVER_ENV = ['PGDATA', 'PG_MAJOR', 'PG_VERSION', 'POSTGRES_PASSWORD', 'POSTGRES_PASSWORD_FILE', 'POSTGRESQL_PASSWORD', 'POSTGRES_HOST_AUTH_METHOD'];

/**
 * Env vars only a MySQL/MariaDB server sets. App containers (Nextcloud, …) also use
 * MYSQL_USER / MYSQL_PASSWORD to *connect*, so only root-level settings and the
 * versions official images bake in count.
 */
const MYSQL_SERVER_ENV = [
	'MYSQL_ROOT_PASSWORD',
	'MYSQL_ROOT_PASSWORD_FILE',
	'MYSQL_ALLOW_EMPTY_PASSWORD',
	'MYSQL_RANDOM_ROOT_PASSWORD',
	'MYSQL_MAJOR',
	'MYSQL_VERSION',
	'MARIADB_ROOT_PASSWORD',
	'MARIADB_ROOT_PASSWORD_FILE',
	'MARIADB_ROOT_PASSWORD_HASH',
	'MARIADB_ALLOW_EMPTY_ROOT_PASSWORD',
	'MARIADB_RANDOM_ROOT_PASSWORD',
	'MARIADB_VERSION',
	'MARIADB_MAJOR'
];

export interface ServerKind {
	engine: Engine;
	flavor: Flavor;
	/** The port the server listens on inside the container. */
	port: number;
}

function mysqlFlavor(image: string, env: Record<string, string>): Flavor {
	return /mariadb/i.test(image) || Object.keys(env).some((k) => k.startsWith('MARIADB_')) ? 'mariadb' : 'mysql';
}

function mysqlPort(env: Record<string, string>): number {
	return Number(env.MYSQL_TCP_PORT || env.MARIADB_PORT_NUMBER || env.MYSQL_PORT_NUMBER) || 3306;
}

/**
 * Which database server a container runs, if any: by image name first, then by the
 * environment only a server sets, then by the exposed port.
 */
export function detectServer(image: string, env: Record<string, string>, exposedPorts: string[] = []): ServerKind | null {
	if (NOT_A_SERVER.test(image)) return null;
	const pg: ServerKind = { engine: 'postgres', flavor: 'postgres', port: Number(env.PGPORT) || 5432 };
	const my = (): ServerKind => ({ engine: 'mysql', flavor: mysqlFlavor(image, env), port: mysqlPort(env) });
	if (PG_IMAGE.test(image)) return pg;
	if (MYSQL_IMAGE.test(image)) return my();
	if (SERVER_ENV.some((k) => k in env)) return pg;
	if (MYSQL_SERVER_ENV.some((k) => k in env)) return my();
	if (exposedPorts.includes('5432/tcp')) return pg;
	if (exposedPorts.includes('3306/tcp')) return my();
	return null;
}

export function looksLikePostgresServer(image: string, env: Record<string, string>, exposedPorts: string[] = []): boolean {
	return detectServer(image, env, exposedPorts)?.engine === 'postgres';
}

export function looksLikeMysqlServer(image: string, env: Record<string, string>, exposedPorts: string[] = []): boolean {
	return detectServer(image, env, exposedPorts)?.engine === 'mysql';
}

export interface ServerLogin {
	user: string;
	password?: string;
	database: string;
	notes: string[];
}

/** Logins a Postgres server container was created with (POSTGRES_* / bitnami POSTGRESQL_*). */
export function postgresLogins(env: Record<string, string>): ServerLogin[] {
	const notes: string[] = [];
	const user = env.POSTGRES_USER || env.POSTGRESQL_USERNAME || env.POSTGRESQL_USER || 'postgres';
	let password = env.POSTGRES_PASSWORD || env.POSTGRESQL_PASSWORD;
	if (!password && user === 'postgres') password = env.POSTGRESQL_POSTGRES_PASSWORD;
	const database = env.POSTGRES_DB || env.POSTGRESQL_DATABASE || user;
	if (!password && (env.POSTGRES_PASSWORD_FILE || env.POSTGRESQL_PASSWORD_FILE)) {
		notes.push('Password comes from a Docker secret file; enter it manually.');
	}
	if (env.POSTGRES_HOST_AUTH_METHOD === 'trust') notes.push('Server uses trust auth; no password needed.');
	return [{ user, password: password || undefined, database, notes }];
}

/**
 * Logins a MySQL / MariaDB server container was created with: the application user
 * (MYSQL_USER / MARIADB_USER) and root, when root has a password or may log in without one.
 */
export function mysqlLogins(env: Record<string, string>): ServerLogin[] {
	const pick = (...keys: string[]) => keys.map((k) => env[k]).find((v) => v !== undefined && v !== '');
	const database = pick('MARIADB_DATABASE', 'MYSQL_DATABASE') ?? '';
	const out: ServerLogin[] = [];

	const appUser = pick('MARIADB_USER', 'MYSQL_USER');
	if (appUser && appUser !== 'root') {
		const notes: string[] = [];
		const password = pick('MARIADB_PASSWORD', 'MYSQL_PASSWORD');
		if (!password && pick('MARIADB_PASSWORD_FILE', 'MYSQL_PASSWORD_FILE')) notes.push('Password comes from a Docker secret file (*_PASSWORD_FILE); enter it manually.');
		out.push({ user: appUser, password, database, notes });
	}

	const rootPassword = pick('MARIADB_ROOT_PASSWORD', 'MYSQL_ROOT_PASSWORD');
	const rootFile = pick('MARIADB_ROOT_PASSWORD_FILE', 'MYSQL_ROOT_PASSWORD_FILE');
	const emptyRoot = /^(1|yes|true)$/i.test(pick('MARIADB_ALLOW_EMPTY_ROOT_PASSWORD', 'MYSQL_ALLOW_EMPTY_PASSWORD', 'ALLOW_EMPTY_PASSWORD') ?? '');
	if (rootPassword || rootFile || emptyRoot) {
		const notes = ['root has full access — consider a read-only user for everyday browsing.'];
		if (!rootPassword && rootFile) notes.unshift('Root password comes from a Docker secret file (*_ROOT_PASSWORD_FILE); enter it manually.');
		if (!rootPassword && emptyRoot) notes.unshift('Root may log in without a password.');
		out.push({ user: 'root', password: rootPassword, database, notes });
	} else if (!out.length) {
		const random = pick('MARIADB_RANDOM_ROOT_PASSWORD', 'MYSQL_RANDOM_ROOT_PASSWORD');
		out.push({
			user: 'root',
			database,
			notes: [random ? 'Root got a random password (printed once in the container log); enter it manually.' : 'No credentials in the container’s environment; enter them manually.']
		});
	}
	return out;
}

export function serverLogins(kind: ServerKind, env: Record<string, string>): ServerLogin[] {
	return kind.engine === 'mysql' ? mysqlLogins(env) : postgresLogins(env);
}
