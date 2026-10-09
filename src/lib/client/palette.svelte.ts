/**
 * Command palette state (⌘K / Ctrl+K): whether it's open, what the open connection
 * workspace can do, recently used items, and per-connection caches of tables/views
 * and saved queries so reopening the palette is instant.
 */
import { goto } from '$app/navigation';
import { api } from './api.ts';
import type { RelationSummary, SavedQuery, SchemaTree } from '#lib/types.ts';

/** What the open connection workspace (c/[id]) lets the palette do. */
export interface WorkspaceContext {
	connectionId: string;
	newQuery: (sql?: string, saved?: { id: string; name: string } | null) => void;
	openTable: (schema: string, table: string, kind: RelationSummary['kind']) => void;
	openTab: (kind: 'overview' | 'diagram' | 'activity' | 'schema') => void;
	snapshot: () => void;
}

export const palette = $state<{ open: boolean; workspace: WorkspaceContext | null }>({ open: false, workspace: null });

let pending: { connectionId: string; run: (w: WorkspaceContext) => void } | null = null;

/** Called by the workspace for each connection it shows; returns the cleanup. */
export function registerWorkspace(ctx: WorkspaceContext): () => void {
	palette.workspace = ctx;
	noteConnection(ctx.connectionId);
	if (pending?.connectionId === ctx.connectionId) {
		const p = pending;
		pending = null;
		// Let the workspace restore its tabs first.
		setTimeout(() => p.run(ctx), 0);
	}
	return () => {
		if (palette.workspace === ctx) palette.workspace = null;
	};
}

/** Runs `run` in the connection's workspace, navigating there first if needed. */
export function inWorkspace(connectionId: string, run: (w: WorkspaceContext) => void) {
	if (palette.workspace?.connectionId === connectionId) run(palette.workspace);
	else {
		pending = { connectionId, run };
		goto(`/c/${connectionId}`);
	}
}

// --- recents -----------------------------------------------------------------------

const RECENT_KEY = 'pgm-palette-recent';
const RECENT_CONN_KEY = 'pgm-palette-connections';

function readList(key: string): string[] {
	try {
		const v = JSON.parse(localStorage.getItem(key) ?? '[]');
		return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
	} catch {
		return [];
	}
}

function writeList(key: string, list: string[]) {
	try {
		localStorage.setItem(key, JSON.stringify(list));
	} catch {}
}

export const recents = $state<{ items: string[]; connections: string[] }>({ items: [], connections: [] });

export function loadRecents() {
	recents.items = readList(RECENT_KEY);
	recents.connections = readList(RECENT_CONN_KEY);
}

/** Moves an item key to the front of the recent list. */
export function noteRecent(key: string) {
	recents.items = [key, ...recents.items.filter((k) => k !== key)].slice(0, 30);
	writeList(RECENT_KEY, recents.items);
}

export function noteConnection(id: string) {
	recents.connections = [id, ...readList(RECENT_CONN_KEY).filter((k) => k !== id)].slice(0, 10);
	writeList(RECENT_CONN_KEY, recents.connections);
}

// --- caches ------------------------------------------------------------------------

export interface PaletteObject {
	schema: string;
	name: string;
	kind: RelationSummary['kind'];
}

const OBJECTS_TTL_MS = 5 * 60_000;
export const objects = $state<Record<string, { at: number; items: PaletteObject[] }>>({});
const inflight = new Map<string, Promise<void>>();

/** Tables and views of a connection, from the schema endpoint (cached for 5 minutes). */
export function loadObjects(connectionId: string): Promise<void> {
	const hit = objects[connectionId];
	if (hit && Date.now() - hit.at < OBJECTS_TTL_MS) return Promise.resolve();
	const running = inflight.get(connectionId);
	if (running) return running;
	const p = api
		.get<SchemaTree>(`/api/connections/${connectionId}/schema`)
		.then((tree) => {
			objects[connectionId] = {
				at: Date.now(),
				items: tree.schemas.flatMap((s) => s.relations.map((r) => ({ schema: s.name, name: r.name, kind: r.kind })))
			};
		})
		.catch(() => {})
		.finally(() => inflight.delete(connectionId));
	inflight.set(connectionId, p);
	return p;
}

export const savedCache = $state<{ at: number; list: SavedQuery[] }>({ at: 0, list: [] });

export async function loadSavedQueries() {
	if (Date.now() - savedCache.at < 60_000) return;
	try {
		savedCache.list = await api.get<SavedQuery[]>('/api/queries');
		savedCache.at = Date.now();
	} catch {}
}

/** ⌘K on macOS (Ctrl+K stays the editor's kill-line there), Ctrl+K elsewhere. */
export function isPaletteShortcut(e: KeyboardEvent): boolean {
	if (e.key.toLowerCase() !== 'k' || e.shiftKey || e.altKey) return false;
	const mac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
	return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey || e.metaKey;
}
