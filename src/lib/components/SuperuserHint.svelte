<script lang="ts">
	import { untrack } from 'svelte';
	import { ShieldAlert, X } from '@lucide/svelte';
	import { api } from '#lib/client/api.ts';
	import { isAdmin } from '#lib/client/state.svelte.ts';
	import { dismissHint, dismissedHints, roHelper } from '#lib/client/readonly-user.svelte.ts';
	import type { Connection } from '#lib/types.ts';

	/** `online`: only ask once the card's connection test succeeded. */
	let { conn, online }: { conn: Connection; online: boolean } = $props();

	let currentUser = $state<string | null>(null);
	let dismissed = $state(false);

	$effect(() => {
		const id = conn.id;
		const ready = online && isAdmin() && (conn.engine === 'postgres' || conn.engine === 'mysql');
		void conn.updatedAt;
		if (!ready) return;
		untrack(async () => {
			dismissed = dismissedHints().has(id);
			if (dismissed) return;
			try {
				const r = await api.get<{ elevated: boolean; currentUser: string }>(`/api/connections/${id}/readonly-user?brief=1`);
				currentUser = r.elevated ? r.currentUser : null;
			} catch {
				currentUser = null;
			}
		});
	});
</script>

{#if currentUser && !dismissed}
	<div class="relative flex items-center gap-2 border-t border-border bg-warning/5 px-4 py-1.5 text-[11px] text-muted-foreground">
		<ShieldAlert class="size-3.5 shrink-0 text-warning" />
		<span class="min-w-0 flex-1 truncate">
			Connected as {conn.engine === 'mysql' ? 'admin' : 'superuser'} <span class="font-mono">{currentUser.replace(/@.*$/, '')}</span> ·
			<button class="text-primary hover:underline" onclick={() => (roHelper.target = conn)}>create a read-only user</button>
		</span>
		<button
			class="rounded p-0.5 hover:bg-accent hover:text-foreground"
			title="Don’t show this again for this connection"
			aria-label="Dismiss"
			onclick={() => {
				dismissHint(conn.id);
				dismissed = true;
			}}><X class="size-3" /></button
		>
	</div>
{/if}
