import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeServiceNetworks, networkPath } from '../src/lib/server/discovery/network.ts';

const db = (networks: Record<string, string>, published: { host: string; port: number }[] = []) => ({
	id: 'abc',
	name: 'db',
	networks,
	published,
	running: true
});

test('a network shared with pg·modern wins over a published port', () => {
	const self = { inContainer: true, container: 'pg-modern', networks: ['database', 'pg-modern_default'] };
	const p = networkPath(db({ database: '172.22.0.3', scanopy_default: '172.31.0.3' }, [{ host: '10.0.0.2', port: 5439 }]), self, 5432);
	assert.equal(p.via, 'shared-network');
	assert.deepEqual(p.shared, ['database']);
});

test('without a shared network, published ports are the way in', () => {
	const self = { inContainer: true, container: 'pg-modern', networks: ['pg-modern_default'] };
	const p = networkPath(db({ app_default: '172.20.0.2' }, [{ host: '10.0.0.2', port: 5439 }]), self, 5432);
	assert.equal(p.via, 'published-port');
});

test('suggests a network to join only when pg·modern runs on the same Docker host', () => {
	const here = networkPath(db({ app_default: '' }), { inContainer: true, container: 'pg-modern', networks: ['x'] }, 5432);
	assert.equal(here.via, 'none');
	assert.equal(here.join, 'app_default');
	const elsewhere = networkPath(db({ app_default: '' }), { inContainer: true, networks: [] }, 5432);
	assert.equal(elsewhere.join, undefined);
	assert.equal(elsewhere.publish, 5432);
});

test('host networking is reachable through the host', () => {
	assert.equal(networkPath(db({ host: '' }), { inContainer: false, networks: [] }, 5432).via, 'host-network');
});

test('compose network names follow project prefixes, name: and external', () => {
	const top = { backend: null, shared: { external: true }, named: { name: 'custom-net' } };
	assert.deepEqual(composeServiceNetworks('My-App', {}, top), ['my-app_default']);
	assert.deepEqual(composeServiceNetworks('app', { networks: ['backend', 'shared', 'named'] }, top), ['app_backend', 'shared', 'custom-net']);
	assert.deepEqual(composeServiceNetworks('app', { networks: { backend: { aliases: ['db'] } } }, top), ['app_backend']);
	assert.deepEqual(composeServiceNetworks('app', { network_mode: 'host' }, top), ['host']);
});
