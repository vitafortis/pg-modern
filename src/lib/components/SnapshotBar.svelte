<script lang="ts">
	import { Camera, CircleAlert, Info, RefreshCw } from '@lucide/svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { ago, bytes } from '#lib/client/format.ts';
	import { refreshConnections, toast } from '#lib/client/state.svelte.ts';
	import type { Connection } from '#lib/types.ts';

	let { conn, onrefreshed }: { conn: Connection; onrefreshed?: () => void } = $props();
	const snap = $derived(conn.snapshot!);
	let busy = $state(false);

	async function refresh() {
		busy = true;
		try {
			await api.post(`/api/connections/${conn.id}/snapshot`);
			toast('success', 'Snapshot refreshed', `${snap.container}:${snap.containerPath}`);
			onrefreshed?.();
		} catch (err) {
			toast('error', 'Could not refresh the snapshot', errorMessage(err));
		} finally {
			await refreshConnections();
			busy = false;
		}
	}

	const takenAt = $derived(snap.takenAt ? new Date(snap.takenAt) : null);
</script>

<div class="flex shrink-0 items-center gap-3 border-b border-border bg-surface/60 px-4 py-1.5 text-[11px] text-muted-foreground">
	<Camera class="size-3.5 shrink-0 text-primary" />
	{#if takenAt}
		<span>
			Snapshot of <span class="font-mono text-foreground">{snap.container}:{snap.containerPath}</span>
			taken at <time class="text-foreground" datetime={snap.takenAt} title={takenAt.toLocaleString()}>{takenAt.toLocaleString()}</time>
			({ago(snap.takenAt)}){#if snap.bytes != null} · {bytes(snap.bytes)}{/if}{#if snap.wal} · included the -wal{/if}
		</span>
	{:else}
		<span class="text-foreground">No snapshot of <span class="font-mono">{snap.container}:{snap.containerPath}</span> yet.</span>
	{/if}
	<span
		class="flex items-center gap-1"
		title="This is a copy of a live database, read through the Docker API. Copying the -wal file along makes it consistent in practice, but it is not a transactional backup, and it does not change when the app writes — refresh to see new data. Snapshots are always read-only."
	>
		<Info class="size-3" />read-only copy
	</span>
	{#if snap.error}
		<span class="flex min-w-0 items-center gap-1 text-danger" title={snap.error}><CircleAlert class="size-3 shrink-0" /><span class="truncate">Last refresh failed: {snap.error}</span></span>
	{/if}
	<button class="btn btn-ghost btn-sm ml-auto" disabled={busy} onclick={refresh}>
		<RefreshCw class={busy ? 'animate-spin' : ''} />Refresh snapshot
	</button>
</div>
