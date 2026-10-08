import { api } from './api.ts';
import type { Connection } from '#lib/types.ts';

type Toast = { id: number; kind: 'info' | 'success' | 'error'; title: string; body?: string };

let nextToast = 1;
export const toasts = $state<Toast[]>([]);

export function toast(kind: Toast['kind'], title: string, body?: string) {
	const id = nextToast++;
	toasts.push({ id, kind, title, body });
	setTimeout(() => dismiss(id), kind === 'error' ? 7000 : 3500);
}

export function dismiss(id: number) {
	const i = toasts.findIndex((t) => t.id === id);
	if (i !== -1) toasts.splice(i, 1);
}

/** Saved connections, shared by the sidebar and pages. */
export const connections = $state<{ list: Connection[]; loaded: boolean }>({ list: [], loaded: false });

export async function refreshConnections() {
	connections.list = await api.get<Connection[]>('/api/connections');
	connections.loaded = true;
}

export const theme = $state<{ value: 'dark' | 'light' }>({ value: 'dark' });

export function setTheme(value: 'dark' | 'light') {
	theme.value = value;
	document.documentElement.dataset.theme = value;
	try {
		localStorage.setItem('pgm-theme', value);
	} catch {}
}

/** Connection form dialog: `null` closed, `'new'` create, or the connection being edited. */
export const editor = $state<{ target: Connection | 'new' | null }>({ target: null });
