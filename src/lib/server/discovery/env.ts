import type { Candidate, SslMode } from '#lib/types.ts';

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
const PG_PREFIX = /(POSTGRES|PSQL|(^|_)PG($|_)|^PG|(^|_)DB($|_)|(^|_)DATABASE($|_)|^DB)/;
const OTHER_ENGINE = /(MYSQL|MARIA|MONGO|REDIS|SQLITE|MSSQL|SQLSERVER|INFLUX|CLICKHOUSE|ELASTIC|CASSANDRA|COUCH|NEO4J|ORACLE|VALKEY|KEYDB|MEILI|QDRANT|MINIO|S3|SMTP|MAIL|LDAP|AMQP|RABBIT|NATS|KAFKA)/;
const ENGINE_KEYS = ['TYPE', 'DRIVER', 'CONNECTION', 'ENGINE', 'DIALECT', 'CLIENT', 'VENDOR', 'ADAPTER', 'PROVIDER'];

export interface ExtractContext {
	/** Prefix for candidate names, e.g. the folder or container name. */
	label: string;
	source: Candidate['source'];
	/** Host to assume when a group has credentials but no host. */
	defaultHost?: string;
	/** Skip groups without an explicit host (e.g. a .env that only feeds compose variables). */
	requireHost?: boolean;
}

function sslFromParam(v: string | null): SslMode {
	switch (v) {
		case 'disable':
			return 'disable';
		case 'require':
		case 'verify-ca':
			return 'require';
		case 'verify-full':
			return 'verify-full';
		default:
			return 'prefer';
	}
}

export function fingerprint(c: Pick<Candidate, 'host' | 'port' | 'database' | 'user'>): string {
	return `${c.user}@${c.host.toLowerCase()}:${c.port}/${c.database}`;
}

export function parsePostgresUrl(url: string): Omit<Candidate, 'fingerprint' | 'name' | 'source' | 'notes' | 'hasPassword'> | null {
	try {
		const u = new URL(url.replace(/^postgres(ql)?(\+\w+)?:/i, 'postgres:'));
		if (u.protocol !== 'postgres:') return null;
		const params = u.searchParams;
		// Multi-host URLs (host1,host2) aren't valid WHATWG hosts; take the first one.
		return {
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

function finish(partial: Omit<Candidate, 'fingerprint' | 'hasPassword'>): Candidate {
	return { ...partial, fingerprint: fingerprint(partial), hasPassword: !!partial.password };
}

/**
 * Finds Postgres credentials in a flat set of environment variables: connection URLs
 * (`DATABASE_URL=postgres://…`) and grouped keys (`DB_HOST`, `POSTGRES_PASSWORD`, `PGUSER`, …).
 */
export function extractCandidates(vars: Record<string, string>, ctx: ExtractContext): Candidate[] {
	const found = new Map<string, Candidate>();
	const add = (c: Candidate) => {
		const prev = found.get(c.fingerprint);
		if (!prev || (!prev.password && c.password)) found.set(c.fingerprint, c);
	};

	for (const [key, raw] of Object.entries(vars)) {
		const value = raw.trim();
		if (!/^postgres(ql)?(\+\w+)?:\/\//i.test(value)) continue;
		const parsed = parsePostgresUrl(value);
		if (parsed) add(finish({ ...parsed, name: `${ctx.label} · ${key}`, source: ctx.source, notes: [] }));
	}

	type Group = Partial<Record<'host' | 'port' | 'user' | 'password' | 'database', string>> & { fileRefs: string[] };
	const groups = new Map<string, Group>();
	for (const [key, value] of Object.entries(vars)) {
		const m = ROLE_RE.exec(key.toUpperCase());
		if (!m) continue;
		let [, prefix, roleKey, fileSuffix] = m;
		// `APP_DBNAME` parses as APP + DBNAME, but its siblings (`APP_DBHOST`) as APP_DB + HOST.
		if ((roleKey === 'DBNAME' || roleKey === 'DB_NAME') && !PG_PREFIX.test(prefix)) {
			prefix = `${prefix}_DB`;
			roleKey = 'NAME';
		}
		if (!prefix || !PG_PREFIX.test(prefix) || OTHER_ENGINE.test(prefix)) continue;
		if (/^postgres(ql)?:\/\//i.test(value)) continue;
		const group = groups.get(prefix) ?? { fileRefs: [] };
		const role = ROLE[roleKey];
		if (fileSuffix) group.fileRefs.push(key);
		else if (value && group[role] === undefined) group[role] = value;
		groups.set(prefix, group);
	}

	for (const [prefix, g] of groups) {
		// Skip groups that explicitly say they're another engine (DB_CONNECTION=mysql etc).
		const engine = ENGINE_KEYS.map((k) => vars[`${prefix}_${k}`] ?? vars[`${prefix}${k}`]).find(Boolean);
		if (engine && !/postgres|pgsql|psql|^pg$/i.test(engine)) continue;
		const roles = (['host', 'port', 'user', 'password', 'database'] as const).filter((r) => g[r]);
		const isContainerStyle = /POSTGRES/.test(prefix) && !g.host;
		if (roles.length < 2 && !(isContainerStyle && (g.password || g.fileRefs.length))) continue;
		if (!g.password && !g.host && !g.fileRefs.length) continue;

		const notes: string[] = [];
		const user = g.user ?? (/POSTGRES/.test(prefix) ? 'postgres' : undefined);
		if (!user) continue;
		let host = g.host;
		if (!host && ctx.requireHost) continue;
		if (!host) {
			host = ctx.defaultHost ?? 'localhost';
			notes.push(`No ${prefix}_HOST set — assuming ${host}.`);
		}
		if (g.fileRefs.length) notes.push(`Secret read from a file (${g.fileRefs.join(', ')}); enter it manually.`);
		const port = Number(g.port) || 5432;
		add(
			finish({
				name: `${ctx.label} · ${prefix}`,
				host,
				port,
				database: g.database ?? user,
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
