import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCandidates, interpolate, parseDotenv, parsePostgresUrl } from '../src/lib/server/discovery/env.ts';

const ctx = { label: 'app', source: { kind: 'env' as const, ref: '/x/.env' } };
const summary = (vars: Record<string, string>, extra = {}) =>
	extractCandidates(vars, { ...ctx, ...extra }).map((c) => `${c.user}:${c.password ?? ''}@${c.host}:${c.port}/${c.database}`);

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
	assert.deepEqual(u, { host: 'db.lan', port: 5433, database: 'gitea', user: 'gitea', password: 'p@ss', sslMode: 'require' });
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
	assert.deepEqual(summary({ DB_CONNECTION: 'mysql', DB_HOST: 'h', DB_USERNAME: 'u', DB_PASSWORD: 'p' }), []);
	assert.deepEqual(summary({ MYSQL_HOST: 'h', MYSQL_PASSWORD: 'p', REDIS_HOST: 'r', REDIS_PASSWORD: 'x' }), []);
	assert.deepEqual(summary({ APP_NAME: 'x', MAIL_HOST: 'm', MAIL_PASSWORD: 'p' }), []);
});

test('requireHost skips host-less groups (compose variable files)', () => {
	assert.deepEqual(summary({ DB_PASSWORD: 'p', DB_USERNAME: 'u' }, { requireHost: true }), []);
});
