/** Postgres server images: anything named *postgres* plus well-known forks and extensions. */
export const PG_IMAGE =
	/(^|\/)[\w.-]*(postgres|postgis|timescaledb|pgvector|pgvecto|paradedb|spilo|pgautoupgrade|vectorchord|orioledb|citus)[\w.-]*(:|@|$)|immich-app\/postgres|tensorchord\/|apache\/age|cloudnative-pg/i;

/** Images that merely talk to Postgres (admin UIs, proxies, exporters) — not servers themselves. */
const NOT_A_SERVER = /pgadmin|adminer|pgbouncer|pgcat|pgpool|postgres[_-]?exporter|pgweb|pghero|pgbackrest|wal-g|postgrest|pg_?dump|backup/i;

/** Env vars that only a Postgres server container sets (official images bake in PG_VERSION/PG_MAJOR/PGDATA). */
const SERVER_ENV = ['PGDATA', 'PG_MAJOR', 'PG_VERSION', 'POSTGRES_PASSWORD', 'POSTGRES_PASSWORD_FILE', 'POSTGRESQL_PASSWORD', 'POSTGRES_HOST_AUTH_METHOD'];

export function looksLikePostgresServer(image: string, env: Record<string, string>, exposedPorts: string[] = []): boolean {
	if (NOT_A_SERVER.test(image)) return false;
	if (PG_IMAGE.test(image)) return true;
	if (SERVER_ENV.some((k) => k in env)) return true;
	return exposedPorts.includes('5432/tcp');
}
