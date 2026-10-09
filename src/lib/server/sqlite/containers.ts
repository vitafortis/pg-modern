/**
 * SQLite databases that belong to a container: in a bind mount pg·modern can also see
 * under one of its scan folders (opened in place), or — opt-in — anywhere in the
 * container's mounts through the Docker archive API (copied as a snapshot).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, relative, resolve } from 'node:path';
import { config } from '../config.ts';
import { getSettings } from '../store.ts';
import { isBulkMount } from './files.ts';
import { findSqliteFiles, sqliteCandidate } from './discover.ts';
import { archiveEnabled, discoverArchive, type ContainerMount } from './archive.ts';
import type { Candidate } from '#lib/types.ts';

function roots(): string[] {
	const expand = (p: string) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p);
	return [...new Set([...config.scanPaths, ...getSettings().scanPaths].map((p) => resolve(expand(p))))];
}

const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);

export async function containerSqlite(
	endpoint: string,
	c: { id: string; name: string; label: string; state: string; mounts: ContainerMount[] }
): Promise<Candidate[]> {
	const out: Candidate[] = [];
	const handled = new Set<string>();
	const scanRoots = roots();
	for (const m of c.mounts) {
		if (!m.Source || isBulkMount(m.Destination) || !scanRoots.some((r) => under(m.Source, r)) || !existsSync(m.Source)) continue;
		handled.add(m.Destination);
		for (const db of await findSqliteFiles(m.Source, 4, 50)) {
			const containerPath = posix.join(m.Destination, relative(m.Source, db.path));
			out.push(
				sqliteCandidate({
					database: db.path,
					context: c.label,
					source: { kind: 'docker', ref: `${endpoint}#${c.name}` },
					info: { via: 'mount', sizeBytes: db.size, wal: db.wal, endpoint, container: c.name, containerId: c.id, containerPath },
					notes: [
						`Mounted at ${containerPath} in the container; opened in place from ${db.path}.`,
						...(db.wal ? ['WAL database: reading it needs its -shm/-wal files readable, or write access to the folder.'] : [])
					]
				})
			);
		}
	}
	if (archiveEnabled()) {
		const { candidates, notes } = await discoverArchive(endpoint, c, handled);
		if (notes.length) console.warn(`[pg-modern] SQLite discovery in ${c.name}: ${notes.join('; ')}`);
		out.push(...candidates);
	}
	return out;
}
