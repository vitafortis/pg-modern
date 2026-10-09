import { json } from '@sveltejs/kit';
import { resolve } from 'node:path';
import { config } from './config.ts';
import { NotFound, toQueryError } from './engine.ts';
import { DEFAULT_PORT, isEngine } from '#lib/engine.ts';
import type { ConnectionInput, SslMode } from '#lib/types.ts';

/** Wraps an API handler so thrown errors become JSON responses with useful messages. */
export function handler<E>(fn: (event: E) => Promise<Response> | Response) {
	return async (event: E) => {
		try {
			return await fn(event);
		} catch (err) {
			if (err instanceof Response) return err;
			if (err instanceof NotFound) return json({ message: err.message }, { status: 404 });
			if (err instanceof BadRequest) return json({ message: err.message }, { status: 400 });
			if (err && typeof err === 'object' && 'status' in err && 'location' in err) throw err;
			const e = toQueryError(err);
			return json(e, { status: 502 });
		}
	};
}

export class BadRequest extends Error {}

const SSL_MODES: SslMode[] = ['disable', 'prefer', 'require', 'verify-full'];

export function parseConnectionInput(body: unknown, { requirePassword = false } = {}): ConnectionInput {
	if (!body || typeof body !== 'object') throw new BadRequest('Expected a JSON object');
	const b = body as Record<string, unknown>;
	const str = (k: string, fallback?: string) => {
		const v = b[k] ?? fallback;
		if (typeof v !== 'string' || !v.trim()) throw new BadRequest(`"${k}" is required`);
		return v.trim();
	};
	if (b.engine !== undefined && !isEngine(b.engine)) throw new BadRequest('"engine" must be postgres, mysql or sqlite');
	const engine = isEngine(b.engine) ? b.engine : 'postgres';
	if (engine === 'sqlite') {
		// A SQLite connection is a file: no host, port, user, password or TLS.
		const path = str(typeof b.path === 'string' ? 'path' : 'database');
		if (!path.startsWith('/')) throw new BadRequest('The SQLite path must be absolute (as pg·modern sees it, e.g. /appdata/sonarr/sonarr.db)');
		if (/\0/.test(path)) throw new BadRequest('Invalid path');
		const full = resolve(path);
		if (full === config.dataDir || full.startsWith(`${config.dataDir}/`)) {
			throw new BadRequest('Files in pg·modern’s own data folder can’t be opened as connections.');
		}
		return {
			engine,
			name: typeof b.name === 'string' && b.name.trim() ? b.name.trim() : path.split('/').pop() || path,
			host: '',
			port: 0,
			database: full,
			user: '',
			password: undefined,
			sslMode: 'disable',
			readOnly: b.readOnly !== false,
			color: typeof b.color === 'string' ? b.color : undefined
		};
	}
	const port = Number(b.port ?? DEFAULT_PORT[engine]);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BadRequest('"port" must be 1–65535');
	const sslMode = (b.sslMode ?? 'prefer') as SslMode;
	if (!SSL_MODES.includes(sslMode)) throw new BadRequest(`"sslMode" must be one of ${SSL_MODES.join(', ')}`);
	if (requirePassword && typeof b.password !== 'string') throw new BadRequest('"password" is required');
	// MySQL logins don't need a default database (the schema tree lists every database).
	const database = engine === 'mysql' ? (typeof b.database === 'string' ? b.database.trim() : '') : str('database', 'postgres');
	return {
		engine,
		name: str('name', typeof b.host === 'string' ? `${b.host}` : undefined),
		host: str('host'),
		port,
		database,
		user: str('user', engine === 'mysql' ? 'root' : 'postgres'),
		password: typeof b.password === 'string' ? b.password : undefined,
		sslMode,
		readOnly: b.readOnly !== false,
		color: typeof b.color === 'string' ? b.color : undefined
	};
}
