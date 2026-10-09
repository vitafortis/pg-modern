import { api } from './api.ts';
import type { SavedQuery } from '#lib/types.ts';

/** Saved queries for the open connection, shared by the header menu and every query tab. */
export const saved = $state<{ connectionId: string | null; list: SavedQuery[]; loaded: boolean }>({
	connectionId: null,
	list: [],
	loaded: false
});

export async function loadSaved(connectionId: string) {
	if (saved.connectionId !== connectionId) {
		saved.connectionId = connectionId;
		saved.list = [];
		saved.loaded = false;
	}
	const list = await api.get<SavedQuery[]>(`/api/queries?connection=${encodeURIComponent(connectionId)}`);
	if (saved.connectionId === connectionId) {
		saved.list = list;
		saved.loaded = true;
	}
}

export type SavedInput = Pick<SavedQuery, 'name' | 'description' | 'sql' | 'connectionId' | 'shared'>;

export async function createSaved(input: SavedInput): Promise<SavedQuery> {
	const q = await api.post<SavedQuery>('/api/queries', input);
	upsert(q);
	return q;
}

export async function updateSaved(id: string, input: SavedInput): Promise<SavedQuery> {
	const q = await api.put<SavedQuery>(`/api/queries/${id}`, input);
	upsert(q);
	return q;
}

export async function deleteSaved(id: string) {
	await api.del(`/api/queries/${id}`);
	saved.list = saved.list.filter((q) => q.id !== id);
}

function upsert(q: SavedQuery) {
	// Moved to another connection: it no longer belongs in this list.
	const here = !q.connectionId || q.connectionId === saved.connectionId;
	const rest = saved.list.filter((x) => x.id !== q.id);
	saved.list = (here ? [...rest, q] : rest).sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));
}

/** Case-insensitive match on name, description, SQL and owner. */
export function matches(q: SavedQuery, term: string): boolean {
	const t = term.trim().toLowerCase();
	if (!t) return true;
	return [q.name, q.description ?? '', q.sql, q.ownerEmail].some((s) => s.toLowerCase().includes(t));
}
