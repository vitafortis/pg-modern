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

test('unpublished databases fall back to the service name with a note', async () => {
	const out = await composeCandidates('services:\n  pg:\n    image: postgres\n    environment:\n      POSTGRES_PASSWORD: x\n', {
		project: 'p',
		source: { kind: 'env', ref: 'x' },
		vars: {},
		readEnvFile: async () => ({})
	});
	assert.equal(out[0].host, 'pg');
	assert.match(out[0].notes.join(' '), /No published port/);
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
