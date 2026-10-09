/**
 * SQL for a dedicated least-privilege login that pg·modern can use instead of a
 * superuser/root account. Pure functions (no database access) so the quoting of
 * identifiers and password literals can be unit-tested; nothing here runs SQL.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

export interface GeneratedStatement {
	sql: string;
	/** The same statement with the password masked, for confirmations and the audit log. */
	display: string;
	/** Explanation shown as a `--` comment above the statement. */
	comment?: string;
}

// --- quoting ------------------------------------------------------------------------

/** Postgres identifier: always quoted, so case and odd characters survive. */
export function pgIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Postgres string literal. Quotes are doubled; a backslash switches to an E'' literal
 * with backslashes doubled, which means the same thing whatever
 * standard_conforming_strings is set to.
 */
export function pgLiteral(value: string): string {
	if (value.includes('\0')) throw new Error('Postgres strings can’t contain NUL characters');
	const quoted = value.replace(/'/g, "''");
	return value.includes('\\') ? `E'${quoted.replace(/\\/g, '\\\\')}'` : `'${quoted}'`;
}

/** MySQL identifier in backticks. */
export function mysqlIdent(name: string): string {
	return `\`${name.replace(/`/g, '``')}\``;
}

/**
 * MySQL string literal. Single quotes are doubled (valid in every sql_mode);
 * backslashes are escape characters unless NO_BACKSLASH_ESCAPES is on, so they're
 * doubled only when it's off.
 */
export function mysqlLiteral(value: string, noBackslashEscapes = false): string {
	if (value.includes('\0')) throw new Error('Passwords and names can’t contain NUL characters');
	let v = value.replace(/'/g, "''");
	if (!noBackslashEscapes) v = v.replace(/\\/g, '\\\\');
	return `'${v}'`;
}

/** 'user'@'host' */
export function mysqlAccount(user: string, host: string, noBackslashEscapes = false): string {
	return `${mysqlLiteral(user, noBackslashEscapes)}@${mysqlLiteral(host, noBackslashEscapes)}`;
}

/**
 * A database name in GRANT … ON `db`.*: `_` and `%` are wildcards there, so a
 * literal database name escapes them (`my\_app`) — otherwise `my_app` would also
 * match `myXapp`.
 */
export function mysqlGrantDatabase(name: string): string {
	return mysqlIdent(name.replace(/\\/g, '\\\\').replace(/([_%])/g, '\\$1'));
}

// --- SCRAM ------------------------------------------------------------------------------

/** Printable ASCII: SASLprep leaves it unchanged, so our verifier matches what the server would compute. */
export function canPrehash(password: string): boolean {
	return /^[\x20-\x7e]+$/.test(password);
}

/**
 * A SCRAM-SHA-256 verifier (`SCRAM-SHA-256$4096:salt$StoredKey:ServerKey`). Postgres
 * stores it as-is when given as the PASSWORD, so the plain password never reaches the
 * server or its statement log.
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
	const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
	const clientKey = createHmac('sha256', salted).update('Client Key').digest();
	const storedKey = createHash('sha256').update(clientKey).digest();
	const serverKey = createHmac('sha256', salted).update('Server Key').digest();
	return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

// --- Postgres -----------------------------------------------------------------------------

export interface PgSchemaGrant {
	name: string;
	/** Roles that create objects here; default privileges are set per creating role. */
	owners: string[];
}

export interface PgReadOnlyOptions {
	role: string;
	password: string;
	database: string;
	/** `schemas`: per-schema grants; `read_all_data`: the predefined role (Postgres 14+). */
	mode: 'schemas' | 'read_all_data';
	schemas: PgSchemaGrant[];
	/** Also grant SELECT on tables the listed owners create later. */
	defaultPrivileges: boolean;
	/** pg_monitor: see every session and the server statistics (Activity, Health). */
	monitor: boolean;
	/** pg_read_all_stats only (pg_monitor already includes it). */
	readAllStats: boolean;
	/** Send a SCRAM-SHA-256 verifier instead of the plain password. */
	prehash: boolean;
}

export function validatePg(o: PgReadOnlyOptions): string | null {
	const role = o.role.trim();
	if (!role) return 'Choose a role name.';
	if (Buffer.byteLength(role) > 63) return 'Role names are limited to 63 bytes.';
	if (/^pg_/i.test(role)) return 'Role names starting with “pg_” are reserved.';
	if (/\0/.test(role)) return 'The role name contains a NUL character.';
	if (!o.password) return 'Set a password.';
	if (/\0/.test(o.password)) return 'The password contains a NUL character.';
	if (!o.database.trim()) return 'The connection has no database.';
	if (o.mode === 'schemas' && !o.schemas.length) return 'Pick at least one schema.';
	return null;
}

/** Statements creating a read-only login role, in order. */
export function pgReadOnlyUserSql(o: PgReadOnlyOptions): GeneratedStatement[] {
	const problem = validatePg(o);
	if (problem) throw new Error(problem);
	const role = pgIdent(o.role.trim());
	const secret = o.prehash && canPrehash(o.password) ? scramSha256Verifier(o.password) : o.password;
	const out: GeneratedStatement[] = [];
	const add = (sql: string, comment?: string, display = sql) => out.push({ sql, display, comment });

	const create = (pw: string) => `CREATE ROLE ${role} WITH LOGIN PASSWORD ${pw} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`;
	add(
		create(pgLiteral(secret)),
		secret === o.password
			? 'A login role with no special attributes. The password is sent as written; servers that log DDL will log it.'
			: 'A login role with no special attributes. The password is sent as a SCRAM-SHA-256 hash, so the plain text never reaches the server or its logs.',
		create(`'********'`)
	);
	add(`ALTER ROLE ${role} SET default_transaction_read_only = on`, 'Belt and braces: every session of this role starts read-only.');
	add(`GRANT CONNECT ON DATABASE ${pgIdent(o.database)} TO ${role}`);

	if (o.mode === 'read_all_data') {
		add(`GRANT pg_read_all_data TO ${role}`, 'Postgres 14+: SELECT on every table, view and sequence in every schema, now and in the future.');
	} else {
		for (const s of o.schemas) {
			const schema = pgIdent(s.name);
			add(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`, `Schema ${s.name}`);
			add(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
			add(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
			if (o.defaultPrivileges) {
				const owners = [...new Set(s.owners)].filter((r) => r && !/^pg_/.test(r));
				owners.forEach((owner, i) => {
					add(
						`ALTER DEFAULT PRIVILEGES FOR ROLE ${pgIdent(owner)} IN SCHEMA ${schema} GRANT SELECT ON TABLES TO ${role}`,
						i === 0
							? 'Tables created later: default privileges apply per creating role, so this covers objects that role creates here (running it needs membership in that role, or superuser).'
							: undefined
					);
					add(`ALTER DEFAULT PRIVILEGES FOR ROLE ${pgIdent(owner)} IN SCHEMA ${schema} GRANT SELECT ON SEQUENCES TO ${role}`);
				});
			}
		}
	}
	if (o.monitor) add(`GRANT pg_monitor TO ${role}`, 'Optional: see all sessions, queries and statistics (Activity and Health tabs).');
	else if (o.readAllStats) add(`GRANT pg_read_all_stats TO ${role}`, 'Optional: read all pg_stat_* views, including other roles’ queries.');
	return out;
}

// --- MySQL / MariaDB ------------------------------------------------------------------

export interface MysqlReadOnlyOptions {
	user: string;
	host: string;
	password: string;
	/** Databases to grant on; `*` means every database (ON *.*). */
	databases: string[] | '*';
	/** PROCESS: see other sessions and InnoDB transactions (Activity, Health). */
	process: boolean;
	/** SELECT on performance_schema, for index usage and lock waits. */
	performanceSchema: boolean;
	/** The server's sql_mode includes NO_BACKSLASH_ESCAPES. */
	noBackslashEscapes?: boolean;
}

export function validateMysql(o: MysqlReadOnlyOptions): string | null {
	const user = o.user.trim();
	if (!user) return 'Choose a user name.';
	if ([...user].length > 32) return 'MySQL user names are limited to 32 characters.';
	if (!o.host.trim()) return 'Choose a host pattern (% allows any host).';
	if ([...o.host].length > 255) return 'Host patterns are limited to 255 characters.';
	if (!o.password) return 'Set a password.';
	if (/\0/.test(o.password + user + o.host)) return 'Names and passwords can’t contain NUL characters.';
	if (o.databases !== '*' && !o.databases.length) return 'Pick at least one database.';
	return null;
}

export function mysqlReadOnlyUserSql(o: MysqlReadOnlyOptions): GeneratedStatement[] {
	const problem = validateMysql(o);
	if (problem) throw new Error(problem);
	const nbe = o.noBackslashEscapes ?? false;
	const account = mysqlAccount(o.user.trim(), o.host.trim(), nbe);
	const out: GeneratedStatement[] = [];
	const add = (sql: string, comment?: string, display = sql) => out.push({ sql, display, comment });

	add(
		`CREATE USER ${account} IDENTIFIED BY ${mysqlLiteral(o.password, nbe)}`,
		`A dedicated account; ${o.host.trim() === '%' ? '% lets it connect from any host' : `it can only connect from ${o.host.trim()}`}.${o.password.includes('\\') ? ` The password contains a backslash, quoted for ${nbe ? 'NO_BACKSLASH_ESCAPES' : 'the default sql_mode'}.` : ''}`,
		`CREATE USER ${account} IDENTIFIED BY '********'`
	);
	if (o.databases === '*') {
		add(`GRANT SELECT, SHOW VIEW ON *.* TO ${account}`, 'Read every table and view definition in every database.');
	} else {
		o.databases.forEach((db, i) =>
			add(`GRANT SELECT, SHOW VIEW ON ${mysqlGrantDatabase(db)}.* TO ${account}`, i === 0 ? 'Read tables and view definitions (_ and % in names are escaped so they match literally).' : undefined)
		);
	}
	if (o.process) add(`GRANT PROCESS ON *.* TO ${account}`, 'Optional: see other sessions and InnoDB transactions (Activity and Health tabs).');
	if (o.performanceSchema) add(`GRANT SELECT ON ${mysqlGrantDatabase('performance_schema')}.* TO ${account}`, 'Optional: index usage and lock waits from performance_schema.');
	return out;
}

/** The statements as a script; `transaction` wraps them in BEGIN/COMMIT (Postgres DDL is transactional). */
export function renderScript(statements: GeneratedStatement[], opts: { redact?: boolean; transaction?: boolean; header?: string } = {}): string {
	const lines: string[] = [];
	if (opts.header) lines.push(...opts.header.split('\n').map((l) => `-- ${l}`), '');
	if (opts.transaction) lines.push('BEGIN;', '');
	for (const s of statements) {
		if (s.comment) {
			if (lines.length && lines.at(-1) !== '') lines.push('');
			lines.push(...s.comment.split('\n').map((l) => `-- ${l}`));
		}
		lines.push(`${opts.redact ? s.display : s.sql};`);
	}
	if (opts.transaction) lines.push('', 'COMMIT;');
	return lines.join('\n') + '\n';
}
