/**
 * Engine helpers shared by the server and the browser (no server-only imports).
 */
import type { Engine, Flavor } from './types.ts';

export const ENGINES: Engine[] = ['postgres', 'mysql'];

export const DEFAULT_PORT: Record<Engine, number> = { postgres: 5432, mysql: 3306 };

export function isEngine(v: unknown): v is Engine {
	return v === 'postgres' || v === 'mysql';
}

/** The product name to show: Postgres, MySQL or MariaDB (MySQL until a MariaDB server says otherwise). */
export function engineLabel(engine: Engine, flavor?: Flavor | null): string {
	if (engine === 'postgres') return 'Postgres';
	return flavor === 'mariadb' ? 'MariaDB' : 'MySQL';
}

/** The flavor a server version string reveals (`11.4.2-MariaDB-ubu2404`, `8.4.2`, `PostgreSQL 17.2 …`). */
export function flavorFromVersion(engine: Engine, version: string | null | undefined): Flavor {
	if (engine === 'postgres') return 'postgres';
	return /mariadb/i.test(version ?? '') ? 'mariadb' : 'mysql';
}

/** The bare version number from a server's version string. */
export function shortVersion(engine: Engine, version: string): string {
	if (engine === 'postgres') return /PostgreSQL ([\d.]+\w*)/.exec(version)?.[1] ?? version;
	return /^[\d.]+/.exec(version)?.[0] ?? version;
}

/** Quotes an identifier for the engine's SQL dialect. */
export function quoteIdentFor(engine: Engine, name: string): string {
	return engine === 'mysql' ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`;
}
