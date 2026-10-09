import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCandidates, fingerprint, interpolate, parseDotenv, parseMysqlUrl, parsePostgresUrl } from '../src/lib/server/discovery/env.ts';

const ctx = { label: 'app', source: { kind: 'env' as const, ref: '/x/.env' } };
const summary = (vars: Record<string, string>, extra = {}) =>
	extractCandidates(vars, { ...ctx, ...extra }).map((c) => `${c.user}:${c.password ?? ''}@${c.host}:${c.port}/${c.database}`);
/** Like summary, with the engine (and flavor when known) in front. */
const engines = (vars: Record<string, string>, extra = {}) =>
	extractCandidates(vars, { ...ctx, ...extra }).map(
		(c) => `${c.flavor && c.flavor !== c.engine ? c.flavor : c.engine} ${c.user}:${c.password ?? ''}@${c.host}:${c.port}/${c.database}`
	);

test('parses dotenv syntax', () => {
	const env = parseDotenv(`# comment\nexport A=1\nB="two words" # trailing\nC='single'\nD=bare value\nE=\n`);
	assert.deepEqual(env, { A: '1', B: 'two words', C: 'single', D: 'bare value', E: '' });
});

test('interpolates compose-style variables', () => {
	const vars = { USER: 'me', EMPTY: '' };
	assert.equal(interpolate('${USER}/${MISSING:-def}/${EMPTY:-fallback}/${EMPTY-kept}/$USER', vars), 'me/def/fallback//me');
});

test('parses postgres URLs with encoded credentials and sslmode', () => {
	const u = parsePostgresUrl('postgresql://gitea:p%40ss@db.lan:5433/gitea?sslmode=require');
	assert.deepEqual(u, { engine: 'postgres', host: 'db.lan', port: 5433, database: 'gitea', user: 'gitea', password: 'p@ss', sslMode: 'require' });
});

test('finds URL and grouped credentials', () => {
	assert.deepEqual(summary({ DATABASE_URL: 'postgres://u:p@h/db' }), ['u:p@h:5432/db']);
	assert.deepEqual(summary({ DB_HOST: 'h', DB_PORT: '6543', DB_USERNAME: 'u', DB_PASSWORD: 'p', DB_DATABASE: 'd' }), ['u:p@h:6543/d']);
	assert.deepEqual(summary({ PGHOST: 'h', PGUSER: 'u', PGPASSWORD: 'p', PGDATABASE: 'd' }), ['u:p@h:5432/d']);
	assert.deepEqual(summary({ DB_HOSTNAME: 'h', DB_USERNAME: 'u', DB_PASSWORD: 'p', DB_DATABASE_NAME: 'immich' }), ['u:p@h:5432/immich']);
	assert.deepEqual(summary({ POSTGRES_PASSWORD: 'p', POSTGRES_DB: 'app' }), ['postgres:p@localhost:5432/app']);
	assert.deepEqual(
		summary({ PAPERLESS_DBHOST: 'h', PAPERLESS_DBUSER: 'u', PAPERLESS_DBPASS: 'p', PAPERLESS_DBNAME: 'paperless' }),
		['u:p@h:5432/paperless']
	);
});

test('ignores other engines and unrelated keys', () => {
	assert.deepEqual(summary({ DB_CONNECTION: 'sqlite', DB_HOST: 'h', DB_USERNAME: 'u', DB_PASSWORD: 'p' }), []);
	// No user: nothing to log in as.
	assert.deepEqual(summary({ MYSQL_HOST: 'h', MYSQL_PASSWORD: 'p', REDIS_HOST: 'r', REDIS_PASSWORD: 'x' }), []);
	assert.deepEqual(summary({ MONGO_HOST: 'h', MONGO_USER: 'u', MONGO_PASSWORD: 'p' }), []);
	assert.deepEqual(summary({ APP_NAME: 'x', MAIL_HOST: 'm', MAIL_PASSWORD: 'p' }), []);
});

test('requireHost skips host-less groups (compose variable files)', () => {
	assert.deepEqual(summary({ DB_PASSWORD: 'p', DB_USERNAME: 'u' }, { requireHost: true }), []);
});

test('parses mysql and mariadb URLs', () => {
	assert.deepEqual(parseMysqlUrl('mysql://ghost:p%40ss@db:3307/ghost?ssl-mode=REQUIRED'), {
		engine: 'mysql', host: 'db', port: 3307, database: 'ghost', user: 'ghost', password: 'p@ss', sslMode: 'require'
	});
	assert.equal(parseMysqlUrl('mariadb://u:p@h/app')?.flavor, 'mariadb');
	assert.equal(parseMysqlUrl('mysql+pymysql://u:p@h/app?charset=utf8mb4')?.port, 3306);
	assert.equal(parseMysqlUrl('jdbc:mysql://h:3306/app')?.user, 'root');
	assert.equal(parseMysqlUrl('postgres://u@h/db'), null);
	assert.deepEqual(engines({ DATABASE_URL: 'mysql://u:p@db/app', OTHER_URL: 'postgresql://a:b@pg/x' }).sort(), ['mysql u:p@db:3306/app', 'postgres a:b@pg:5432/x']);
});

test('MySQL / MariaDB credentials from app containers', () => {
	// Laravel-style apps (Firefly III, BookStack, Monica …)
	assert.deepEqual(engines({ DB_CONNECTION: 'mysql', DB_HOST: 'db', DB_PORT: '3306', DB_DATABASE: 'firefly', DB_USERNAME: 'firefly', DB_PASSWORD: 'p' }), [
		'mysql firefly:p@db:3306/firefly'
	]);
	// …and DB_CONNECTION=pgsql stays Postgres.
	assert.deepEqual(engines({ DB_CONNECTION: 'pgsql', DB_HOST: 'db', DB_USERNAME: 'u', DB_PASSWORD: 'p', DB_DATABASE: 'd' }), ['postgres u:p@db:5432/d']);
	// BookStack (linuxserver): no driver variable, but MySQL's port.
	assert.deepEqual(engines({ DB_HOST: 'bookstack_db', DB_PORT: '3306', DB_USER: 'bookstack', DB_PASS: 'p', DB_DATABASE: 'bookstackapp' }), [
		'mysql bookstack:p@bookstack_db:3306/bookstackapp'
	]);
	// WordPress, host with port.
	assert.deepEqual(engines({ WORDPRESS_DB_HOST: 'db:3306', WORDPRESS_DB_USER: 'wp', WORDPRESS_DB_PASSWORD: 'p', WORDPRESS_DB_NAME: 'wordpress' }), [
		'mysql wp:p@db:3306/wordpress'
	]);
	// Nextcloud
	assert.deepEqual(engines({ MYSQL_HOST: 'db', MYSQL_USER: 'nextcloud', MYSQL_PASSWORD: 'p', MYSQL_DATABASE: 'nextcloud', REDIS_HOST: 'redis' }), [
		'mysql nextcloud:p@db:3306/nextcloud'
	]);
	// Ghost (lower-case, double underscores)
	assert.deepEqual(
		engines({ database__client: 'mysql', database__connection__host: 'db', database__connection__user: 'root', database__connection__password: 'p', database__connection__database: 'ghost' }),
		['mysql root:p@db:3306/ghost']
	);
	assert.deepEqual(engines({ database__client: 'sqlite3', database__connection__filename: '/x.db' }), []);
	// PhotoPrism
	assert.deepEqual(
		engines({ PHOTOPRISM_DATABASE_DRIVER: 'mysql', PHOTOPRISM_DATABASE_SERVER: 'mariadb:3306', PHOTOPRISM_DATABASE_NAME: 'photoprism', PHOTOPRISM_DATABASE_USER: 'photoprism', PHOTOPRISM_DATABASE_PASSWORD: 'p' }),
		['mysql photoprism:p@mariadb:3306/photoprism']
	);
	assert.deepEqual(engines({ PHOTOPRISM_DATABASE_DRIVER: 'sqlite', PHOTOPRISM_DATABASE_SERVER: 'x:1', PHOTOPRISM_DATABASE_USER: 'u', PHOTOPRISM_DATABASE_PASSWORD: 'p' }), []);
	// Gitea-style *_DB_TYPE
	assert.deepEqual(
		engines({ GITEA__database__DB_TYPE: 'mysql', GITEA__database__HOST: 'db:3306', GITEA__database__NAME: 'gitea', GITEA__database__USER: 'gitea', GITEA__database__PASSWD: 'p' }),
		['mysql gitea:p@db:3306/gitea']
	);
	// MariaDB named explicitly
	assert.deepEqual(engines({ DB_TYPE: 'mariadb', DB_HOST: 'h', DB_USER: 'u', DB_PASS: 'p', DB_NAME: 'n' }), ['mariadb u:p@h:3306/n']);
});

test('MySQL server variables in a .env offer the app user and root', () => {
	const out = engines({ MYSQL_ROOT_PASSWORD: 'rootpw', MYSQL_DATABASE: 'shop', MYSQL_USER: 'shop', MYSQL_PASSWORD: 'shoppw' });
	assert.deepEqual(out.sort(), ['mysql root:rootpw@localhost:3306/shop', 'mysql shop:shoppw@localhost:3306/shop']);
	assert.deepEqual(engines({ MARIADB_ROOT_PASSWORD_FILE: '/run/secrets/root' }), ['mariadb root:@localhost:3306/']);
});

test('fingerprints keep a Postgres and a MySQL login on the same address apart', () => {
	const pg = fingerprint({ host: 'db', port: 5432, database: 'app', user: 'app' });
	assert.equal(pg, 'app@db:5432/app');
	assert.notEqual(fingerprint({ engine: 'mysql', host: 'db', port: 5432, database: 'app', user: 'app' }), pg);
});
