import { goto } from '$app/navigation';
import { page } from '$app/state';
import { api, errorMessage } from './api.ts';
import { confirmAction, editor, refreshConnections, toast } from './state.svelte.ts';
import type { Connection } from '#lib/types.ts';

/** Confirms, deletes a saved connection, and leaves its workspace if it's open. */
export async function removeConnection(conn: Connection): Promise<boolean> {
	const ok = await confirmAction({
		title: `Remove ${conn.name}?`,
		body: 'The saved credentials, query history and saved queries for this connection are deleted. The database itself is not touched.',
		detail: `${conn.user}@${conn.host}:${conn.port}/${conn.database}`,
		confirmLabel: 'Remove connection',
		danger: true
	});
	if (!ok) return false;
	try {
		await api.del(`/api/connections/${conn.id}`);
	} catch (err) {
		toast('error', 'Could not remove connection', errorMessage(err));
		return false;
	}
	await refreshConnections();
	if (editor.target !== 'new' && editor.target?.id === conn.id) editor.target = null;
	toast('success', 'Connection removed', conn.name);
	if (page.url.pathname.startsWith(`/c/${conn.id}`)) goto('/');
	return true;
}
