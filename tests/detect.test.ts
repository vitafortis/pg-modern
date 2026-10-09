import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectServer, looksLikeMysqlServer, looksLikePostgresServer, mysqlLogins } from '../src/lib/server/discovery/detect.ts';

test('recognises Postgres server images and forks', () => {
	for (const image of [
		'postgres:17-alpine',
		'docker.io/library/postgres@sha256:abc',
		'bitnami/postgresql:16',
		'bitnami/postgresql-repmgr:16',
		'ghcr.io/immich-app/postgres:14-vectorchord0.4.3',
		'tensorchord/pgvecto-rs:pg16-v0.2.0',
		'pgautoupgrade/pgautoupgrade:16-alpine',
		'timescale/timescaledb-ha:pg16',
		'postgis/postgis:16-3.4',
		'cgr.dev/chainguard/postgres:latest',
		'ghcr.io/cloudnative-pg/postgresql:16',
		'supabase/postgres:15.1.0.147'
	]) {
		assert.ok(looksLikePostgresServer(image, {}), image);
	}
});

test('falls back to server env vars or an exposed 5432', () => {
	assert.ok(looksLikePostgresServer('my-registry/db:custom', { PG_MAJOR: '16' }));
	assert.ok(looksLikePostgresServer('my-registry/db:custom', { POSTGRES_PASSWORD_FILE: '/run/secrets/pw' }));
	assert.ok(looksLikePostgresServer('my-registry/db:custom', {}, ['5432/tcp']));
	assert.ok(!looksLikePostgresServer('my-registry/app:1', {}, ['8080/tcp']));
});

test('ignores tools that only talk to Postgres', () => {
	for (const image of ['dpage/pgadmin4', 'edoburu/pgbouncer', 'prometheuscommunity/postgres-exporter', 'adminer', 'prodrigestivill/postgres-backup-local']) {
		assert.ok(!looksLikePostgresServer(image, { POSTGRES_PASSWORD: 'x' }, ['5432/tcp']), image);
	}
});

test('recognises MySQL / MariaDB server images', () => {
	for (const [image, flavor] of [
		['mysql:8.4', 'mysql'],
		['mysql/mysql-server:8.0', 'mysql'],
		['mariadb:11', 'mariadb'],
		['docker.io/library/mariadb@sha256:abc', 'mariadb'],
		['lscr.io/linuxserver/mariadb:latest', 'mariadb'],
		['bitnami/mysql:8.0', 'mysql'],
		['bitnami/mariadb:11.4', 'mariadb'],
		['bitnami/mariadb-galera:11', 'mariadb'],
		['yobasystems/alpine-mariadb', 'mariadb'],
		['percona:8.0', 'mysql'],
		['percona/percona-server:8.0', 'mysql']
	] as const) {
		const kind = detectServer(image, {});
		assert.equal(kind?.engine, 'mysql', image);
		assert.equal(kind?.flavor, flavor, image);
		assert.equal(kind?.port, 3306, image);
		assert.ok(!looksLikePostgresServer(image, {}), image);
		assert.ok(looksLikeMysqlServer(image, {}), image);
	}
});

test('MySQL servers by root variables or an exposed 3306, not by app variables', () => {
	assert.equal(detectServer('registry/db:custom', { MYSQL_ROOT_PASSWORD: 'x' })?.engine, 'mysql');
	assert.equal(detectServer('registry/db:custom', { MARIADB_ALLOW_EMPTY_ROOT_PASSWORD: '1' })?.flavor, 'mariadb');
	assert.equal(detectServer('registry/db:custom', { MARIADB_VERSION: '1:11.4' })?.engine, 'mysql');
	assert.equal(detectServer('registry/db:custom', {}, ['3306/tcp'])?.engine, 'mysql');
	assert.equal(detectServer('registry/db:custom', { MYSQL_TCP_PORT: '3307', MYSQL_ROOT_PASSWORD: 'x' })?.port, 3307);
	// Nextcloud connects with MYSQL_* variables but isn't a server.
	assert.equal(detectServer('nextcloud:29', { MYSQL_HOST: 'db', MYSQL_USER: 'nc', MYSQL_PASSWORD: 'p' }), null);
	assert.equal(detectServer('wordpress:6', { WORDPRESS_DB_HOST: 'db' }), null);
});

test('ignores tools that only talk to MySQL', () => {
	for (const image of ['phpmyadmin:5', 'phpmyadmin/phpmyadmin', 'prom/mysqld-exporter', 'adminer', 'databack/mysql-backup', 'fradelg/mysql-cron-backup', 'proxysql/proxysql', 'mariadb/maxscale']) {
		assert.equal(detectServer(image, { MYSQL_ROOT_PASSWORD: 'x' }, ['3306/tcp']), null, image);
	}
});

test('MySQL logins: app user and root', () => {
	assert.deepEqual(
		mysqlLogins({ MYSQL_ROOT_PASSWORD: 'r', MYSQL_DATABASE: 'shop', MYSQL_USER: 'shop', MYSQL_PASSWORD: 's' }).map((l) => `${l.user}:${l.password}/${l.database}`),
		['shop:s/shop', 'root:r/shop']
	);
	const files = mysqlLogins({ MARIADB_USER: 'wiki', MARIADB_PASSWORD_FILE: '/run/secrets/pw', MARIADB_ROOT_PASSWORD_FILE: '/run/secrets/root' });
	assert.deepEqual(files.map((l) => [l.user, l.password]), [['wiki', undefined], ['root', undefined]]);
	assert.ok(files.every((l) => l.notes.some((n) => /enter it manually/.test(n))));
	const empty = mysqlLogins({ MYSQL_ALLOW_EMPTY_PASSWORD: 'yes' });
	assert.equal(empty[0].user, 'root');
	assert.ok(empty[0].notes.some((n) => /without a password/.test(n)));
	assert.ok(mysqlLogins({ MYSQL_RANDOM_ROOT_PASSWORD: 'yes' })[0].notes.some((n) => /random password/.test(n)));
});
