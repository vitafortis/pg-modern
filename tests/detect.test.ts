import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikePostgresServer } from '../src/lib/server/discovery/detect.ts';

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
