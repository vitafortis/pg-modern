import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeCandidates } from '../src/lib/server/discovery/compose.ts';

const compose = `
services:
  app:
    image: ghcr.io/example/app
    env_file: .env
    environment:
      DB_HOST: db
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: \${DB_USERNAME}
      POSTGRES_PASSWORD: \${DB_PASSWORD}
      POSTGRES_DB: \${DB_NAME:-appdb}
    ports:
      - "5544:5432"
`;
const vars = { DB_USERNAME: 'app', DB_PASSWORD: 'secret', DB_USER: 'app', DB_PASS: 'secret', DB_NAME: 'appdb' };

test('resolves variables, published ports and app→db references', async () => {
	const out = await composeCandidates(compose, {
		project: 'demo',
		source: { kind: 'arcane', ref: 'Arcane · nas · demo' },
		vars,
		readEnvFile: async (p) => (p === '.env' ? vars : {}),
		publishedHost: '10.0.0.5'
	});
	const db = out.find((c) => c.name === 'demo/db')!;
	assert.equal(`${db.user}:${db.password}@${db.host}:${db.port}/${db.database}`, 'app:secret@10.0.0.5:5544/appdb');
	assert.deepEqual(db.alternates?.map((a) => `${a.host}:${a.port}`), ['db:5432']);
	// The app's DB_HOST=db is rewritten to the database's reachable address.
	const app = out.find((c) => c.name.startsWith('demo/app'))!;
	assert.equal(`${app.host}:${app.port}`, '10.0.0.5:5544');
});

test('an app without a database name inherits the server it points at', async () => {
	const out = await composeCandidates(
		'services:\n  web:\n    image: x\n    environment:\n      DB_HOST: pg\n      DB_USER: u\n      DB_PASSWORD: p\n  pg:\n    image: postgres\n    environment:\n      POSTGRES_USER: u\n      POSTGRES_PASSWORD: p\n      POSTGRES_DB: wiki\n',
		{ project: 'p', source: { kind: 'env', ref: 'x' }, vars: {}, readEnvFile: async () => ({}) }
	);
	const [server, app] = out;
	assert.equal(app.database, 'wiki');
	assert.equal(app.fingerprint, server.fingerprint);
});

test('unpublished databases fall back to the service name and report their network', async () => {
	const out = await composeCandidates('services:\n  pg:\n    image: postgres\n    environment:\n      POSTGRES_PASSWORD: x\n', {
		project: 'p',
		source: { kind: 'env', ref: 'x' },
		vars: {},
		readEnvFile: async () => ({})
	});
	assert.equal(out[0].host, 'pg');
	assert.deepEqual(out[0].network?.networks, ['p_default']);
	assert.equal(out[0].network?.via, 'none');
});

test('YAML anchors/merge keys and compose tags are understood', async () => {
	const doc = `x-db: &db
  image: postgres:16
  environment:
    POSTGRES_USER: scanopy
    POSTGRES_PASSWORD: pw
services:
  postgres:
    <<: *db
    ports: ["5439:5432"]
  web:
    image: nginx
    environment: !reset {}
`;
	const out = await composeCandidates(doc, {
		project: 'scanopy',
		source: { kind: 'arcane', ref: 'x' },
		vars: {},
		readEnvFile: async () => ({}),
		publishedHost: '192.168.4.23'
	});
	assert.equal(out.length, 1);
	assert.equal(`${out[0].user}@${out[0].host}:${out[0].port}`, 'scanopy@192.168.4.23:5439');
});

test('invalid YAML is reported, not silently skipped', async () => {
	const errors: string[] = [];
	const out = await composeCandidates('services:\n  db:\n    image: postgres\n   bad: [', {
		project: 'p',
		source: { kind: 'env', ref: 'x' },
		vars: {},
		readEnvFile: async () => ({}),
		onParseError: (m) => errors.push(m)
	});
	// Still best-effort: the database is found, and the problem is reported.
	assert.equal(out.length, 1);
	assert.equal(errors.length, 1);
});

test('MySQL / MariaDB stacks: Nextcloud, WordPress, Ghost and a Postgres neighbour', async () => {
	const doc = `
services:
  db:
    image: mariadb:11
    environment:
      MARIADB_ROOT_PASSWORD: rootpw
      MARIADB_DATABASE: nextcloud
      MARIADB_USER: nextcloud
      MARIADB_PASSWORD: ncpw
    ports: ["3307:3306"]
  app:
    image: nextcloud:29
    environment:
      MYSQL_HOST: db
      MYSQL_USER: nextcloud
      MYSQL_PASSWORD: ncpw
      MYSQL_DATABASE: nextcloud
  wp:
    image: wordpress
    environment:
      WORDPRESS_DB_HOST: wpdb:3306
      WORDPRESS_DB_USER: wp
      WORDPRESS_DB_PASSWORD: wppw
      WORDPRESS_DB_NAME: wordpress
  wpdb:
    image: mysql:8.4
    environment:
      MYSQL_ROOT_PASSWORD_FILE: /run/secrets/root
      MYSQL_DATABASE: wordpress
      MYSQL_USER: wp
      MYSQL_PASSWORD: wppw
  ghost:
    image: ghost:5
    environment:
      database__client: mysql
      database__connection__host: wpdb
      database__connection__user: ghost
      database__connection__password: ghostpw
      database__connection__database: ghost
  pg:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: pgpw
  phpmyadmin:
    image: phpmyadmin
    environment:
      PMA_HOST: db
      MYSQL_ROOT_PASSWORD: rootpw
`;
	const out = await composeCandidates(doc, { project: 'cloud', source: { kind: 'env', ref: 'x' }, vars: {}, readEnvFile: async () => ({}), publishedHost: '10.0.0.5' });
	const line = (c: (typeof out)[number]) => `${c.engine}${c.flavor && c.flavor !== c.engine ? `/${c.flavor}` : ''} ${c.user}:${c.password ?? ''}@${c.host}:${c.port}/${c.database}`;
	const by = (name: string) => out.find((c) => c.name === name)!;
	assert.equal(line(by('cloud/db (nextcloud)')), 'mysql/mariadb nextcloud:ncpw@10.0.0.5:3307/nextcloud');
	assert.equal(line(by('cloud/db (root)')), 'mysql/mariadb root:rootpw@10.0.0.5:3307/nextcloud');
	// The root password is a secret file: offered without it, with a note.
	const wpRoot = by('cloud/wpdb (root)');
	assert.equal(wpRoot.hasPassword, false);
	assert.ok(wpRoot.notes.some((n) => /enter it manually/.test(n)));
	// Ghost points at wpdb with its own user.
	const ghost = out.find((c) => c.name.startsWith('cloud/ghost'))!;
	assert.equal(line(ghost), 'mysql ghost:ghostpw@wpdb:3306/ghost');
	assert.equal(by('cloud/pg').engine, 'postgres');
	// phpMyAdmin is a client, not a server.
	assert.ok(!out.some((c) => c.name.startsWith('cloud/phpmyadmin (')));
	// Apps resolve to the server they point at, so callers can de-duplicate by fingerprint.
	const nextcloud = out.find((c) => c.name.startsWith('cloud/app'))!;
	assert.equal(nextcloud.fingerprint, by('cloud/db (nextcloud)').fingerprint);
	assert.equal(nextcloud.flavor, 'mariadb');
});
