// Regenerates docs/screenshots/*.png against fictional demo data.
//
//   pnpm screenshots
//
// Needs Docker (for a throwaway Postgres) and a Playwright Chromium
// (`pnpm exec playwright install chromium`).
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { startMockArcane, startMockDocker } from './mock-docker.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const OUT = join(ROOT, 'docs/screenshots');
const DB_PORT = 54329;
const DOCKER_PORT = 23750;
const ARCANE_PORT = 23751;
const APP_PORT = 5188;
const APP = `http://127.0.0.1:${APP_PORT}`;
const DB = { user: 'homelab', password: 'demo-password' };
const ADMIN_PASSWORD = 'demo-admin-password';
const CONTAINER = 'pg-modern-screenshot-db';

const tmp = mkdtempSync(join(tmpdir(), 'pgm-shots-'));
const STACKS = '/tmp/homelab/stacks';
const docker = (...args) => execFileSync('docker', args, { stdio: ['pipe', 'pipe', 'inherit'] }).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app;
let mock;
let arcane;

function writeStacks() {
	const file = (path, content) => {
		mkdirSync(join(STACKS, path, '..'), { recursive: true });
		writeFileSync(join(STACKS, path), content);
	};
	file('immich/.env', `UPLOAD_LOCATION=./library\nDB_PASSWORD=${DB.password}\nDB_USERNAME=${DB.user}\nDB_DATABASE_NAME=immich\n`);
	file(
		'immich/compose.yaml',
		`name: immich\nservices:\n  immich-server:\n    image: ghcr.io/immich-app/immich-server:release\n    env_file: [.env]\n    environment:\n      DB_HOSTNAME: database\n  database:\n    image: ghcr.io/immich-app/postgres:14-vectorchord0.4.3\n    environment:\n      POSTGRES_PASSWORD: \${DB_PASSWORD}\n      POSTGRES_USER: \${DB_USERNAME}\n      POSTGRES_DB: \${DB_DATABASE_NAME}\n    ports:\n      - "${DB_PORT}:5432"\n`
	);
	file('vaultwarden/.env', `DOMAIN=https://vault.home.arpa\nDATABASE_URL=postgresql://vaultwarden:changeme@pg.home.arpa:5432/vaultwarden\n`);
	file('paperless/docker-compose.env', `PAPERLESS_DBHOST=127.0.0.1\nPAPERLESS_DBPORT=${DB_PORT}\nPAPERLESS_DBUSER=${DB.user}\nPAPERLESS_DBPASS=${DB.password}\nPAPERLESS_DBNAME=media\nPAPERLESS_REDIS=redis://broker:6379\n`);
}

async function waitFor(fn, label, tries = 60) {
	for (let i = 0; i < tries; i++) {
		try {
			if (await fn()) return;
		} catch {}
		await sleep(500);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
	console.log('• starting demo Postgres');
	try {
		execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
	} catch {}
	docker('run', '-d', '--name', CONTAINER, '-p', `127.0.0.1:${DB_PORT}:5432`, '-e', `POSTGRES_USER=${DB.user}`, '-e', `POSTGRES_PASSWORD=${DB.password}`, '-e', 'POSTGRES_DB=media', 'postgres:17-alpine');
	await waitFor(() => docker('exec', CONTAINER, 'pg_isready', '-U', DB.user, '-d', 'media').includes('accepting'), 'postgres');
	await sleep(1500); // the entrypoint restarts the server once after init
	await waitFor(() => docker('exec', CONTAINER, 'pg_isready', '-U', DB.user, '-d', 'media').includes('accepting'), 'postgres');
	execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-q', '-v', 'ON_ERROR_STOP=1', '-U', DB.user, '-d', 'media'], {
		input: readFileSync(join(import.meta.dirname, 'seed.sql'))
	});

	console.log('• starting mock Docker API and app');
	mock = await startMockDocker({ port: DOCKER_PORT, dbPort: DB_PORT, ...DB });
	arcane = await startMockArcane({ port: ARCANE_PORT, dbPort: DB_PORT, ...DB });
	writeStacks();
	execFileSync('pnpm', ['build'], { cwd: ROOT, stdio: 'ignore' });
	app = spawn('node', ['build'], {
		cwd: ROOT,
		stdio: 'ignore',
		env: {
			...process.env,
			PORT: String(APP_PORT),
			HOST: '127.0.0.1',
			PGM_DATA_DIR: join(tmp, 'data'),
			PGM_DOCKER_HOSTS: `tcp://127.0.0.1:${DOCKER_PORT}`,
			PGM_SCAN_PATHS: STACKS,
			PGM_SELF_CONTAINER: 'pg-modern',
			NODE_OPTIONS: '--disable-warning=ExperimentalWarning'
		}
	});
	await waitFor(async () => (await fetch(`${APP}/api/health`)).ok, 'app');

	const browser = await chromium.launch();
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
	const page = await context.newPage();
	page.on('pageerror', (e) => console.error('  page error:', e.message));
	const shot = async (name) => {
		await sleep(400);
		await page.screenshot({ path: join(OUT, `${name}.png`) });
		console.log(`  ✓ ${name}.png`);
	};

	// First run: the setup wizard, then integrations set up the way the UI does it.
	await page.goto(`${APP}/setup`, { waitUntil: 'networkidle' });
	await page.fill('#s-name', 'Sam Rivera');
	await page.fill('#s-email', 'sam@home.arpa');
	await shot('setup');
	await page.request.post(`${APP}/api/auth/setup`, { data: { name: 'Sam Rivera', email: 'sam@home.arpa', password: ADMIN_PASSWORD } });
	await page.request.put(`${APP}/api/integrations/sso`, {
		data: {
			// Shown on the login and integrations pages; never contacted.
			name: 'Authentik',
			issuer: 'https://auth.home.arpa/application/o/pg-modern/',
			clientId: 'pg-modern',
			clientSecret: 'demo-secret',
			autoCreate: '*@home.arpa',
			adminEmails: 'sam@home.arpa',
			defaultRole: 'viewer'
		}
	});
	await page.request.post(`${APP}/api/managers`, {
		data: { name: 'Arcane', url: `http://127.0.0.1:${ARCANE_PORT}`, apiKey: 'arc_demo' }
	});
	await page.request.post(`${APP}/api/auth/logout`);
	await page.goto(`${APP}/login`, { waitUntil: 'networkidle' });
	await shot('login');
	await page.request.post(`${APP}/api/auth/login`, { data: { email: 'sam@home.arpa', password: ADMIN_PASSWORD } });

	// Saved connections, as if imported earlier.
	const api = (method, path, data) => page.request.fetch(`${APP}${path}`, { method, data }).then((r) => r.json());
	const base = { host: '127.0.0.1', port: DB_PORT, user: DB.user, password: DB.password, sslMode: 'disable' };
	const media = await api('POST', '/api/connections', { ...base, name: 'jellystat', database: 'media', color: 'violet' });
	await api('POST', '/api/connections', { ...base, name: 'gitea', database: 'gitea', color: 'green', readOnly: false });
	await api('POST', '/api/connections', { ...base, name: 'nas · postgres', host: 'nas.home.arpa', port: 5432, database: 'postgres', color: 'amber' });

	await page.goto(`${APP}/discover`, { waitUntil: 'networkidle' });
	await page.waitForSelector('text=immich_postgres', { timeout: 20000 });
	await page.locator('input[type=checkbox]').nth(1).check();
	await shot('discover');
	await page.click('button:has-text("Clear")');
	await page.click('button:has-text("Files")');
	await page.waitForSelector('text=vaultwarden', { timeout: 20000 });
	await shot('discover-files');
	await page.click('button:has-text("Arcane")');
	await page.waitForSelector('span:text-is("vaultwarden")', { timeout: 20000 });
	await shot('discover-arcane');
	await api('POST', '/api/connections', { ...base, name: 'immich', database: 'immich', color: 'blue' });

	await page.goto(`${APP}/`, { waitUntil: 'networkidle' });
	await page.waitForSelector('text=pg 17', { timeout: 15000 });
	await sleep(2500); // let the unreachable host time out
	await shot('overview');


	await page.goto(`${APP}/c/${media.id}`, { waitUntil: 'networkidle' });
	await page.waitForSelector('text=Largest tables');
	await shot('server');

	await page.click('button[title^="public.media"]');
	await page.waitForSelector('[role=gridcell]');
	await page.locator('[role=row]').nth(3).locator('[role=gridcell]').nth(7).click();
	await page.locator('[role=grid]').evaluate((el) => (el.scrollLeft = 0)); // clicking scrolled the JSON cell into view
	await shot('table');

	await page.click('button:has-text("Structure")');
	await page.waitForSelector('text=Indexes');
	await shot('structure');

	await page.keyboard.press('Meta+k');
	await page.waitForSelector('.cm-content');
	await page.locator('.cm-content').click();
	await page.keyboard.insertText(
		`-- Library size by kind\nselect l.name as library,\n       m.kind,\n       count(*) as items,\n       round(avg(m.rating), 2) as avg_rating,\n       pg_size_pretty(sum(m.file_size)) as size\nfrom media m\njoin libraries l on l.id = m.library_id\ngroup by 1, 2\norder by sum(m.file_size) desc;`
	);
	await page.keyboard.press('Meta+Enter');
	await page.waitForSelector('text=rolled back');
	await shot('query');

	for (const u of [
		{ email: 'jo@home.arpa', name: 'Jo Park', role: 'viewer' },
		{ email: 'kids-tablet@home.arpa', role: 'viewer' }
	]) {
		await api('POST', '/api/users', u);
	}
	await page.goto(`${APP}/integrations`, { waitUntil: 'networkidle' });
	await page.waitForSelector('text=Redirect URI');
	await shot('integrations');

	await page.goto(`${APP}/users`, { waitUntil: 'networkidle' });
	await page.waitForSelector('text=Jo Park');
	await shot('users');

	await page.goto(`${APP}/`, { waitUntil: 'networkidle' });
	await page.evaluate(() => localStorage.setItem('pgm-theme', 'light'));
	await page.reload({ waitUntil: 'networkidle' });
	await page.waitForSelector('text=pg 17');
	await sleep(2500);
	await shot('overview-light');
	await page.evaluate(() => localStorage.setItem('pgm-theme', 'dark'));

	await browser.close();
}

try {
	await main();
} finally {
	app?.kill();
	mock?.close();
	arcane?.close();
	try {
		docker('rm', '-f', CONTAINER);
	} catch {}
	rmSync(tmp, { recursive: true, force: true });
	rmSync(join(STACKS, '..'), { recursive: true, force: true });
	rmSync(join(ROOT, 'build'), { recursive: true, force: true });
}
