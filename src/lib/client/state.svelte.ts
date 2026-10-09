import { api } from './api.ts';
import type { Connection, Viewer } from '#lib/types.ts';

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

/** The signed-in user; set by the root layout. */
export const session = $state<{ viewer: Viewer | null }>({ viewer: null });

export const isAdmin = () => session.viewer?.role === 'admin';

type ConfirmRequest = {
	title: string;
	body?: string;
	/** Monospace detail, e.g. the SQL about to run. */
	detail?: string;
	confirmLabel?: string;
	danger?: boolean;
	resolve: (ok: boolean) => void;
};

/** The open confirmation dialog, rendered once by the root layout. */
export const confirmation = $state<{ request: ConfirmRequest | null }>({ request: null });

/** Asks the user to confirm; resolves false if they cancel or dismiss. */
export function confirmAction(opts: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
	confirmation.request?.resolve(false);
	return new Promise((resolve) => (confirmation.request = { ...opts, resolve }));
}
