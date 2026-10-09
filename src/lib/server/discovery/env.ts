import type { Candidate, Engine, Flavor, SslMode } from '#lib/types.ts';

/** Parses dotenv syntax: comments, `export`, single/double quotes, and escaped newlines. */
export function parseDotenv(content: string): Record<string, string> {
	const out: Record<string, string> = {};
	const re = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`|[^\n#]*?)\s*(?:#.*)?$/gm;
	for (const m of content.matchAll(re)) {
		let value = m[2] ?? '';
		const q = value[0];
		if ((q === '"' || q === "'" || q === '`') && value.endsWith(q)) {
			value = value.slice(1, -1);
			if (q === '"') value = value.replace(/\\n/g, '\n').replace(/\\(["\\$])/g, '$1');
		}
		out[m[1]] = value;
	}
	return out;
}

/** Expands `${VAR}`, `${VAR:-default}`, `${VAR-default}` and `$VAR` the way Compose does. */
export function interpolate(value: string, vars: Record<string, string>): string {
	return value
		.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\}/g, (_, name, op, fallback) => {
			const v = vars[name];
			if (op === ':-') return v ? v : (fallback ?? '');
			if (op === '-') return v ?? fallback ?? '';
			return v ?? '';
		})
		.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => vars[name] ?? '')
		.replace(/\$\$/g, '$');
}

const ROLE: Record<string, 'host' | 'port' | 'user' | 'password' | 'database'> = {
	HOST: 'host',
	HOSTNAME: 'host',
	SERVER: 'host',
	ADDR: 'host',
	PORT: 'port',
	USER: 'user',
	USERNAME: 'user',
	LOGIN: 'user',
	PASS: 'password',
	PASSWORD: 'password',
	PASSWD: 'password',
	PWD: 'password',
	DB: 'database',
	NAME: 'database',
	DATABASE: 'database',
	DBNAME: 'database',
	DB_NAME: 'database',
	DATABASE_NAME: 'database',
	USER_NAME: 'user'
};
const ROLE_RE = new RegExp(`^(.+?)_?(${Object.keys(ROLE).sort((a, b) => b.length - a.length).join('|')})(_FILE)?$`);
const DB_PREFIX = /(POSTGRES|PSQL|(^|_)PG($|_)|^PG|(^|_)DB($|_)|(^|_)DATABASE($|_)|^DB|MYSQL|MARIA)/;
const OTHER_ENGINE = /(MONGO|REDIS|SQLITE|MSSQL|SQLSERVER|INFLUX|CLICKHOUSE|ELASTIC|CASSANDRA|COUCH|NEO4J|ORACLE|VALKEY|KEYDB|MEILI|QDRANT|MINIO|S3|SMTP|MAIL|LDAP|AMQP|RABBIT|NATS|KAFKA)/;
const ENGINE_KEYS = ['TYPE', 'DRIVER', 'CONNECTION', 'ENGINE', 'DIALECT', 'CLIENT', 'VENDOR', 'ADAPTER', 'PROVIDER'];
/** Apps that only ever talk MySQL/MariaDB, recognised by their variable prefix. */
const MYSQL_APPS = /^(WORDPRESS|WP|JOOMLA|MATOMO|PIWIK|PHPBB|PRESTASHOP|OPENCART|MAGENTO|MOODLE|MEDIAWIKI|BOOKSTACK|LEANTIME|KIMAI|FRESHRSS|ROUNDCUBE)(_|$)/;

export interface ExtractContext {
	/** Prefix for candidate names, e.g. the folder or container name. */
	label: string;
	source: Candidate['source'];
	/** Host to assume when a group has credentials but no host. */
	defaultHost?: string;
	/** Skip groups without an explicit host (e.g. a .env that only feeds compose variables). */
	requireHost?: boolean;
}

export function sslFromParam(v: string | null): SslMode {
	switch (v?.toLowerCase()) {
		case 'disable':
		case 'disabled':
		case 'false':
			return 'disable';
		case 'require':
		case 'required':
		case 'verify-ca':
		case 'verify_ca':
		case 'true':
			return 'require';
		case 'verify-full':
		case 'verify_identity':
			return 'verify-full';
		default:
			return 'prefer';
	}
}

/** Same engine, user, address and database: the same login. Postgres fingerprints keep their original form. */
export function fingerprint(c: Pick<Candidate, 'host' | 'port' | 'database' | 'user'> & { engine?: Engine }): string {
	const base = `${c.user}@${c.host.toLowerCase()}:${c.port}/${c.database}`;
	return c.engine === 'mysql' ? `mysql:${base}` : base;
}

type ParsedUrl = Omit<Candidate, 'fingerprint' | 'name' | 'source' | 'notes' | 'hasPassword'>;

export function parsePostgresUrl(url: string): ParsedUrl | null {
	try {
		const u = new URL(url.replace(/^(jdbc:)?postgres(ql)?(\+\w+)?:/i, 'postgres:'));
		if (u.protocol !== 'postgres:') return null;
		const params = u.searchParams;
		// Multi-host URLs (host1,host2) aren't valid WHATWG hosts; take the first one.
		return {
			engine: 'postgres',
			host: decodeURIComponent(params.get('host') ?? u.hostname) || 'localhost',
			port: Number(params.get('port') ?? u.port) || 5432,
			database: decodeURIComponent(u.pathname.replace(/^\//, '')) || decodeURIComponent(u.username) || 'postgres',
			user: decodeURIComponent(u.username) || params.get('user') || 'postgres',
			password: u.password ? decodeURIComponent(u.password) : (params.get('password') ?? undefined),
			sslMode: sslFromParam(params.get('sslmode'))
		};
	} catch {
		return null;
	}
}

/** `mysql://`, `mariadb://`, SQLAlchemy-style `mysql+pymysql://` and `jdbc:mysql://` URLs. */
export function parseMysqlUrl(url: string): ParsedUrl | null {
	const m = /^(?:jdbc:)?(mysql|mariadb)(?:\+\w+)?:\/\//i.exec(url);
	if (!m) return null;
	try {
		const u = new URL(`mysql://${url.slice(m[0].length)}`);
		const params = u.searchParams;
		return {
			engine: 'mysql',
			...(m[1].toLowerCase() === 'mariadb' ? { flavor: 'mariadb' as const } : {}),
			host: decodeURIComponent(u.hostname.replace(/^\[|\]$/g, '')) || 'localhost',
			port: Number(u.port) || 3306,
			database: decodeURIComponent(u.pathname.replace(/^\//, '').split('/')[0] ?? ''),
			user: decodeURIComponent(u.username) || params.get('user') || 'root',
			password: u.password ? decodeURIComponent(u.password) : (params.get('password') ?? undefined),
			sslMode: sslFromParam(params.get('ssl-mode') ?? params.get('sslmode') ?? params.get('ssl_mode') ?? params.get('ssl'))
		};
	} catch {
		return null;
	}
}

/** Any supported database URL. */
export function parseDatabaseUrl(url: string): ParsedUrl | null {
	return /^(jdbc:)?(mysql|mariadb)/i.test(url) ? parseMysqlUrl(url) : parsePostgresUrl(url);
}

export const DATABASE_URL = /^(jdbc:)?(postgres(ql)?|mysql|mariadb)(\+\w+)?:\/\//i;

function finish(partial: Omit<Candidate, 'fingerprint' | 'hasPassword'>): Candidate {
	return { ...partial, fingerprint: fingerprint(partial), hasPassword: !!partial.password };
}

/** The engine a group of variables is for, from an explicit `*_TYPE` / `*_CONNECTION` style key or its naming. */
function groupEngine(prefix: string, vars: Record<string, string>, port: string | undefined): { engine: Engine; flavor?: Flavor } | null {
	const bases = [prefix];
	// Ghost: database__client next to database__connection__host.
	if (prefix.endsWith('_CONNECTION')) bases.push(prefix.slice(0, -'_CONNECTION'.length));
	const declared = bases
		.flatMap((b) => ENGINE_KEYS.flatMap((k) => [`${b}_${k}`, `${b}${k}`, `${b}_DB_${k}`]))
		.map((k) => vars[k])
		.find(Boolean);
	if (declared) {
		if (/maria/i.test(declared)) return { engine: 'mysql', flavor: 'mariadb' };
		if (/mysql/i.test(declared)) return { engine: 'mysql' };
		if (/postgres|pgsql|psql|^pg$/i.test(declared)) return { engine: 'postgres' };
		return null; // sqlite, mssql, …
	}
	if (/MARIA/.test(prefix)) return { engine: 'mysql', flavor: 'mariadb' };
	if (/MYSQL/.test(prefix) || MYSQL_APPS.test(prefix)) return { engine: 'mysql' };
	if (/POSTGRES|PSQL|(^|_)PG/.test(prefix)) return { engine: 'postgres' };
	if (Number(port) === 3306) return { engine: 'mysql' };
	return { engine: 'postgres' };
}

/** Variables a database server container is created with: `POSTGRES_*`, `MYSQL_*`, `MARIADB_*` (and their `*_ROOT`). */
const CONTAINER_STYLE = /^(POSTGRES|POSTGRESQL|MYSQL|MARIADB|MYSQL_ROOT|MARIADB_ROOT)$/;

/**
 * Finds database credentials in a flat set of environment variables: connection URLs
 * (`DATABASE_URL=postgres://…`, `mysql://…`) and grouped keys (`DB_HOST`, `POSTGRES_PASSWORD`,
 * `PGUSER`, `DB_CONNECTION=mysql`, `WORDPRESS_DB_*`, Ghost's `database__connection__*`, …).
 */
export function extractCandidates(vars: Record<string, string>, ctx: ExtractContext): Candidate[] {
	const found = new Map<string, Candidate>();
	const add = (c: Candidate) => {
		const prev = found.get(c.fingerprint);
		if (!prev || (!prev.password && c.password)) found.set(c.fingerprint, c);
	};

	for (const [key, raw] of Object.entries(vars)) {
		const value = raw.trim();
		if (!DATABASE_URL.test(value)) continue;
		const parsed = parseDatabaseUrl(value);
		if (parsed) add(finish({ ...parsed, name: `${ctx.label} · ${key}`, source: ctx.source, notes: [] }));
	}

	// Upper-case keys with `__` (Ghost, Gitea) collapsed, so naming styles group alike.
	const norm: Record<string, string> = {};
	for (const [key, value] of Object.entries(vars)) {
		const k = key.toUpperCase().replace(/__+/g, '_');
		if (!(k in norm)) norm[k] = value;
	}

	type Group = Partial<Record<'host' | 'port' | 'user' | 'password' | 'database', string>> & { fileRefs: string[] };
	const groups = new Map<string, Group>();
	for (const [key, value] of Object.entries(norm)) {
		const m = ROLE_RE.exec(key);
		if (!m) continue;
		let [, prefix, roleKey, fileSuffix] = m;
		// `APP_DBNAME` parses as APP + DBNAME, but its siblings (`APP_DBHOST`) as APP_DB + HOST;
		// `APP_DATABASE_NAME` likewise belongs with `APP_DATABASE_HOST`.
		if ((roleKey === 'DBNAME' || roleKey === 'DB_NAME') && !DB_PREFIX.test(prefix)) {
			prefix = `${prefix}_DB`;
			roleKey = 'NAME';
		} else if (roleKey === 'DATABASE_NAME' && !DB_PREFIX.test(prefix)) {
			prefix = `${prefix}_DATABASE`;
			roleKey = 'NAME';
		}
		if (!prefix || !DB_PREFIX.test(prefix) || OTHER_ENGINE.test(prefix)) continue;
		if (DATABASE_URL.test(value)) continue;
		const group = groups.get(prefix) ?? { fileRefs: [] };
		const role = ROLE[roleKey];
		if (fileSuffix) group.fileRefs.push(key);
		else if (value && group[role] === undefined) group[role] = value;
		groups.set(prefix, group);
	}

	for (const [prefix, g] of groups) {
		// `host:port` in one variable (WORDPRESS_DB_HOST=db:3306, PHOTOPRISM_DATABASE_SERVER=mariadb:3306).
		const hostPort = g.host ? /^([^:/\s]+):(\d{2,5})$/.exec(g.host) : null;
		if (hostPort) {
			g.host = hostPort[1];
			g.port ??= hostPort[2];
		}
		// Skip groups that say they're another engine (DB_CONNECTION=sqlite etc).
		const kind = groupEngine(prefix, norm, g.port);
		if (!kind) continue;
		const { engine } = kind;
		const roles = (['host', 'port', 'user', 'password', 'database'] as const).filter((r) => g[r]);
		const isContainerStyle = CONTAINER_STYLE.test(prefix) && !g.host;
		if (roles.length < 2 && !(isContainerStyle && (g.password || g.fileRefs.length))) continue;
		if (!g.password && !g.host && !g.fileRefs.length) continue;

		const notes: string[] = [];
		const root = /_ROOT$/.test(prefix);
		const user = g.user ?? (/POSTGRES/.test(prefix) ? 'postgres' : root ? 'root' : undefined);
		if (!user) continue;
		let host = g.host;
		if (!host && ctx.requireHost) continue;
		if (!host) {
			host = ctx.defaultHost ?? 'localhost';
			notes.push(`No ${prefix}_HOST set — assuming ${host}.`);
		}
		if (g.fileRefs.length) notes.push(`Secret read from a file (${g.fileRefs.join(', ')}); enter it manually.`);
		const port = Number(g.port) || (engine === 'mysql' ? 3306 : 5432);
		// MYSQL_ROOT_PASSWORD's database is the MYSQL_DATABASE next to it.
		const database = g.database ?? (root ? groups.get(prefix.replace(/_ROOT$/, ''))?.database : undefined) ?? (engine === 'mysql' ? '' : user);
		add(
			finish({
				engine,
				...(kind.flavor ? { flavor: kind.flavor } : {}),
				name: `${ctx.label} · ${prefix}`,
				host,
				port,
				database,
				user,
				password: g.password,
				sslMode: 'prefer',
				source: ctx.source,
				notes
			})
		);
	}

	return [...found.values()];
}
