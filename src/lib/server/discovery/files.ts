import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { config } from '../config.ts';
import { getSettings } from '../store.ts';
import { extractCandidates, interpolate, parseDotenv } from './env.ts';
import { composeCandidates } from './compose.ts';
import { isTerraformFile, terraformCandidates } from './terraform.ts';
import { mapLimit } from './probe.ts';
import { dockerSelf, settleAddress } from './docker.ts';
import type { Candidate, EnvScanResult, SelfNetworks } from '#lib/types.ts';

const SKIP_DIRS = new Set([
	'node_modules', '.git', '.hg', '.svn', 'vendor', '.venv', 'venv', '__pycache__', '.cache', '.next', '.nuxt',
	'.svelte-kit', 'dist', 'build', 'target', '.terraform', 'Library', '.Trash', 'proc', 'sys', 'dev'
]);
const ENV_FILE = /^(\.env(\..+)?|.+\.env|stack\.env)$/i;
const COMPOSE_FILE = /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/i;
const MAX_FILE_BYTES = 512 * 1024;
/** State files list every resource's attributes and get big. */
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 5000;

export function expandHome(p: string): string {
	return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

export function scanRoots(extra: string[] = []): string[] {
	return [...new Set([...config.scanPaths, ...getSettings().scanPaths, ...extra].map((p) => resolve(expandHome(p))))];
}

async function walk(root: string, depth: number, out: string[], errors: string[]) {
	if (out.length >= MAX_FILES) return;
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (err) {
		errors.push(`${root}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
		return;
	}
	for (const e of entries) {
		const full = join(root, e.name);
		if (e.isFile() && (ENV_FILE.test(e.name) || COMPOSE_FILE.test(e.name) || isTerraformFile(e.name))) {
			if (!/\.(example|sample|template|dist)$/i.test(e.name)) out.push(full);
		} else if (e.isDirectory() && depth > 0 && !SKIP_DIRS.has(e.name)) {
			await walk(full, depth - 1, out, errors);
		}
	}
}

async function readSmall(path: string, maxBytes = MAX_FILE_BYTES): Promise<string | null> {
	try {
		const s = await stat(path);
		if (s.size > maxBytes) return null;
		return await readFile(path, 'utf8');
	} catch {
		return null;
	}
}

async function scanCompose(path: string, content: string, self: SelfNetworks): Promise<Candidate[]> {
	const dir = dirname(path);
	return composeCandidates(content, {
		project: basename(dir),
		source: { kind: 'env', ref: path },
		vars: parseDotenv((await readSmall(join(dir, '.env'))) ?? ''),
		readEnvFile: async (p) => parseDotenv((await readSmall(resolve(dir, p))) ?? ''),
		self
	});
}

export async function scanFiles(extraRoots: string[] = []): Promise<{ result: EnvScanResult; candidates: Candidate[] }> {
	const started = performance.now();
	const roots = scanRoots(extraRoots);
	const errors: string[] = [];
	const paths: string[] = [];
	for (const root of roots) await walk(root, config.scanDepth, paths, errors);
	const self = await dockerSelf();

	const composeDirs = new Set(paths.filter((p) => COMPOSE_FILE.test(basename(p))).map(dirname));
	const files: EnvScanResult['files'] = [];
	const all: Candidate[] = [];
	const report = async (path: string, candidates: Candidate[]) => {
		// An app service and the server it points at often resolve to the same target; keep the first.
		candidates = candidates.filter((c, i) => candidates.findIndex((x) => x.fingerprint === c.fingerprint) === i);
		await Promise.all(candidates.map(settleAddress));
		files.push({ path, candidates });
		all.push(...candidates);
	};

	// A Terraform module is a whole directory: variables, locals and resources span its files.
	const tfDirs = new Map<string, string[]>();
	for (const p of paths) if (isTerraformFile(basename(p))) tfDirs.set(dirname(p), [...(tfDirs.get(dirname(p)) ?? []), p]);
	await mapLimit([...tfDirs], 8, async ([dir, tfPaths]) => {
		const tfFiles = [];
		for (const path of tfPaths) {
			const content = await readSmall(path, /\.tfstate$/.test(path) ? MAX_STATE_BYTES : MAX_FILE_BYTES);
			if (content != null) tfFiles.push({ path, content });
		}
		let found: Candidate[];
		try {
			found = terraformCandidates(tfFiles, { project: basename(dir) });
		} catch (err) {
			errors.push(`${dir}: ${(err as Error).message}`);
			return;
		}
		const byFile = new Map<string, Candidate[]>();
		for (const c of found) {
			const ref = c.source.ref || dir;
			byFile.set(ref, [...(byFile.get(ref) ?? []), c]);
		}
		for (const [path, candidates] of byFile) await report(path, candidates);
	});

	await mapLimit(paths.filter((p) => !isTerraformFile(basename(p))), 16, async (path) => {
		const content = await readSmall(path);
		if (content == null) return;
		const root = roots.find((r) => path.startsWith(r)) ?? dirname(path);
		const label = relative(root, dirname(path)) || basename(root);
		let candidates: Candidate[];
		if (COMPOSE_FILE.test(basename(path))) {
			candidates = await scanCompose(path, content, self);
		} else {
			const vars = parseDotenv(content);
			for (const k of Object.keys(vars)) vars[k] = interpolate(vars[k], vars);
			candidates = extractCandidates(vars, {
				label,
				source: { kind: 'env', ref: path },
				requireHost: composeDirs.has(dirname(path))
			});
		}
		if (candidates.length) await report(path, candidates);
	});

	files.sort((a, b) => a.path.localeCompare(b.path));
	return {
		result: { self, roots, filesScanned: paths.length, durationMs: Math.round(performance.now() - started), errors, files },
		candidates: all
	};
}
