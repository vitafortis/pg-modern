// Runs one side of the store-level backup test in its own process, so each side
// gets its own data dir and master key (config and the key are read once per process).
// Usage: node --experimental-strip-types backup-store.ts <export|import> <dataDir> <secretKey> <file>
import { readFileSync, writeFileSync } from 'node:fs';

const [role, dataDir, secretKey, file] = process.argv.slice(2);
process.env.PGM_DATA_DIR = dataDir;
process.env.PGM_SECRET_KEY = secretKey;

const store = await import('../../src/lib/server/store.ts');
const { encodeBackup, decodeBackup } = await import('../../src/lib/server/backup.ts');
const cb = await import('../../src/lib/server/config-backup.ts');
const { saveSso, ssoConfig } = await import('../../src/lib/server/sso.ts');
const { hashPassword, verifyPassword } = await import('../../src/lib/server/crypto.ts');

const PASSPHRASE = 'correct horse battery staple';
const FAST = { N: 1024, r: 8, p: 1 };

if (role === 'export') {
	const a = store.createConnection({ name: 'app', host: 'db', port: 5432, database: 'app', user: 'app', password: 's3cret-app', sslMode: 'prefer', readOnly: true });
	store.createConnection({ engine: 'mysql', name: 'nopw', host: 'db2', port: 3306, database: 'x', user: 'x', sslMode: 'disable', readOnly: false }, 'mariadb');
	// In the backup, admin@x.io is a disabled viewer: restoring must not demote the signed-in admin.
	store.createUser({ email: 'admin@x.io', role: 'viewer', passwordHash: hashPassword('old-password') });
	const admin = store.getUser(store.findUserByEmail('admin@x.io')!.id)!;
	store.updateUser(admin.id, { disabled: true });
	store.createUser({ email: 'owner@x.io', role: 'admin', passwordHash: hashPassword('owner-password') });
	const viewer = store.createUser({ email: 'viewer@x.io', role: 'viewer' });
	store.updateUser(viewer.id, { connectionAccess: 'selected' });
	store.setGrants(viewer.id, [{ connectionId: a.id, canWrite: true }]);
	store.saveSettings({ scanPaths: ['/srv'], dockerHosts: ['unix:///var/run/docker.sock'], managers: [{ id: 'm1', kind: 'arcane', name: 'Arcane', url: 'https://arcane.local' }] });
	store.setManagerKey('m1', 'arc-api-key');
	saveSso({ issuer: 'https://id.example', clientId: 'pgm', clientSecret: 'sso-secret-value', name: 'Pocket', scopes: 'openid email', autoCreate: [], adminEmails: [], defaultRole: 'viewer' });
	store.setKv('local-login-disabled', true);
	const envelope = await encodeBackup(cb.snapshot({ connections: true, users: true, settings: true }), PASSPHRASE, FAST);
	writeFileSync(file, JSON.stringify(envelope));
	console.log(JSON.stringify({ ok: true }));
} else {
	// A fresh install whose signed-in admin is admin@x.io with a different password.
	const me = store.createUser({ email: 'admin@x.io', role: 'admin', passwordHash: hashPassword('new-password') });
	const { payload } = await decodeBackup(readFileSync(file, 'utf8'), PASSPHRASE);
	const p = cb.validatePayload(payload);
	const preview = cb.previewRestore(p, me.id, { createdAt: '', appVersion: '' });

	// Without a protected actor, disabling everyone would leave no admin: rejected, rolled back.
	let zeroAdminError = '';
	try {
		cb.applyRestore({ ...p, users: p.users!.map((u) => ({ ...u, disabled: true })) }, { connections: true, users: true, settings: true }, null);
	} catch (err) {
		zeroAdminError = (err as Error).message;
	}
	const afterRollback = store.listConnections().length;

	const result = cb.applyRestore(p, { connections: true, users: true, settings: true }, me.id);
	const conns = store.listConnections();
	const meAfter = store.getUser(me.id)!;
	const viewer = store.findUserByEmail('viewer@x.io')!;
	console.log(
		JSON.stringify({
			preview,
			zeroAdminError,
			afterRollback,
			result,
			engines: Object.fromEntries(conns.map((c) => [c.name, `${c.engine}/${c.flavor}`])),
			passwords: Object.fromEntries(conns.map((c) => [c.name, store.getPassword(c.id) ?? null])),
			me: { role: meAfter.role, disabled: meAfter.disabled, keepsPassword: verifyPassword('new-password', store.getPasswordHash(me.id)!) },
			owner: store.findUserByEmail('owner@x.io'),
			ownerPassword: verifyPassword('owner-password', store.getPasswordHash(store.findUserByEmail('owner@x.io')!.id)!),
			viewer,
			viewerGrants: store.listGrants(viewer.id),
			settings: store.getSettings(),
			managerKey: store.getManagerKey('m1'),
			sso: ssoConfig(),
			localLogin: store.getKv('local-login-disabled', null)
		})
	);
}
