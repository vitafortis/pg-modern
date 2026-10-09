import type { Connection } from '#lib/types.ts';

/** The connection the "create a read-only user" helper is open for (rendered by ConnectionDialog). */
export const roHelper = $state<{ target: Connection | null }>({ target: null });

const DISMISS_KEY = 'pgm-ro-hint-dismissed';

/** Connections whose "connected as superuser" hint was dismissed (per browser). */
export function dismissedHints(): Set<string> {
	try {
		return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '[]'));
	} catch {
		return new Set();
	}
}

export function dismissHint(id: string) {
	const s = dismissedHints();
	s.add(id);
	try {
		localStorage.setItem(DISMISS_KEY, JSON.stringify([...s]));
	} catch {}
}
