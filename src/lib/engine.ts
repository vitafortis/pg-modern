/**
 * Engine helpers shared by the server and the browser (no server-only imports).
 */
import type { Connection, Engine, Flavor } from './types.ts';

export const ENGINES: Engine[] = ['postgres', 'mysql', 'sqlite'];

/** SQLite has no port; 0 is what's stored. */
export const DEFAULT_PORT: Record<Engine, number> = { postgres: 5432, mysql: 3306, sqlite: 0 };

export function isEngine(v: unknown): v is Engine {
	return v === 'postgres' || v === 'mysql' || v === 'sqlite';
}

/** The product name to show: Postgres, MySQL, MariaDB or SQLite (MySQL until a MariaDB server says otherwise). */
export function engineLabel(engine: Engine, flavor?: Flavor | null): string {
	if (engine === 'postgres') return 'Postgres';
	if (engine === 'sqlite') return 'SQLite';
	return flavor === 'mariadb' ? 'MariaDB' : 'MySQL';
}

/** The flavor a server version string reveals (`11.4.2-MariaDB-ubu2404`, `8.4.2`, `PostgreSQL 17.2 …`). */
export function flavorFromVersion(engine: Engine, version: string | null | undefined): Flavor {
	if (engine === 'postgres') return 'postgres';
	if (engine === 'sqlite') return 'sqlite';
	return /mariadb/i.test(version ?? '') ? 'mariadb' : 'mysql';
}

/** The bare version number from a server's version string. */
export function shortVersion(engine: Engine, version: string): string {
	if (engine === 'postgres') return /PostgreSQL ([\d.]+\w*)/.exec(version)?.[1] ?? version;
	if (engine === 'sqlite') return /\d+\.\d+(\.\d+)?/.exec(version)?.[0] ?? version;
	return /^[\d.]+/.exec(version)?.[0] ?? version;
}

/** Quotes an identifier for the engine's SQL dialect. */
export function quoteIdentFor(engine: Engine, name: string): string {
	return engine === 'mysql' ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`;
}

/** One-line address of a connection: `user@host:port/db`, or the file path for SQLite. */
export function connectionAddress(
	c: Pick<Connection, 'engine' | 'user' | 'host' | 'port' | 'database'> & { snapshot?: Connection['snapshot'] }
): string {
	if (c.engine === 'sqlite') return c.snapshot ? `${c.snapshot.container}:${c.snapshot.containerPath}` : c.database;
	return `${c.user}@${c.host}:${c.port}/${c.database}`;
}
