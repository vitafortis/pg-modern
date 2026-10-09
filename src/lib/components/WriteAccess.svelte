<script lang="ts">
	import { Lock, LockOpen, PencilLine } from '@lucide/svelte';
	import Dialog from './Dialog.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { refreshConnections, toast } from '#lib/client/state.svelte.ts';
	import type { Connection, ConnectionAccess } from '#lib/types.ts';

	let { conn }: { conn: Connection } = $props();

	const access = $derived<ConnectionAccess>(conn.access ?? { write: 'never', unlockedUntil: null, readOnly: true });
	let open = $state(false);
	let minutes = $state(15);
	let reason = $state('');
	let busy = $state(false);
	let now = $state(Date.now());

	// Countdown while unlocked; refresh access when it runs out so the UI relocks too.
	$effect(() => {
		if (!access.unlockedUntil) return;
		const t = setInterval(() => {
			now = Date.now();
			if (access.unlockedUntil && now >= access.unlockedUntil) refreshConnections();
		}, 1000);
		return () => clearInterval(t);
	});

	const left = $derived.by(() => {
		const ms = Math.max(0, (access.unlockedUntil ?? 0) - now);
		const m = Math.floor(ms / 60_000);
		const s = Math.floor((ms % 60_000) / 1000);
		return `${m}:${String(s).padStart(2, '0')}`;
	});

	async function unlock(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			await api.post(`/api/connections/${conn.id}/unlock`, { minutes, reason });
			await refreshConnections();
			now = Date.now();
			open = false;
			reason = '';
			toast('success', `Writes unlocked for ${minutes} minutes`, conn.name);
		} catch (err) {
			toast('error', 'Could not unlock writes', errorMessage(err));
		} finally {
			busy = false;
		}
	}

	async function relock() {
		try {
			await api.del(`/api/connections/${conn.id}/unlock`);
			await refreshConnections();
			toast('success', 'Back to read-only', conn.name);
		} catch (err) {
			toast('error', 'Could not relock', errorMessage(err));
		}
	}
</script>

{#if access.write === 'always'}
	<span class="badge badge-warning" title="Statements run with full write access"><PencilLine />Read/write</span>
{:else if access.unlockedUntil}
	<span class="badge badge-warning tabular-nums" title="Write access was unlocked temporarily; it relocks automatically"><LockOpen />Writes unlocked · {left}</span>
	<button class="btn btn-ghost btn-sm" onclick={relock}><Lock />Lock</button>
{:else}
	<span class="badge" title="Queries run in a READ ONLY transaction that is always rolled back"><Lock />Read-only</span>
	{#if access.write === 'unlock'}
		<button class="btn btn-ghost btn-sm" onclick={() => (open = true)}><LockOpen />Unlock writes</button>
	{/if}
{/if}

<Dialog bind:open title="Unlock writes on {conn.name}" description="Statements can change data until it relocks. This is recorded in the audit log.">
	<form id="unlock-form" class="space-y-4" onsubmit={unlock}>
		<div>
			<span class="label">For how long</span>
			<div class="mt-1.5 inline-flex rounded-lg border border-border bg-surface p-0.5">
				{#each [5, 15, 30, 60] as m (m)}
					<button
						type="button"
						class="h-7 rounded-md px-3 text-xs {minutes === m ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground'}"
						onclick={() => (minutes = m)}>{m} min</button
					>
				{/each}
			</div>
		</div>
		<label class="block">
			<span class="label">Reason <span class="font-normal text-muted-foreground">(optional)</span></span>
			<input class="input mt-1.5" placeholder="e.g. fix duplicate invoices" maxlength="300" bind:value={reason} />
		</label>
		<p class="text-xs text-muted-foreground">Statements that drop tables, truncate, or update/delete without a WHERE clause still ask for confirmation.</p>
	</form>
	{#snippet footer()}
		<button class="btn btn-ghost" onclick={() => (open = false)}>Cancel</button>
		<button class="btn btn-primary" type="submit" form="unlock-form" disabled={busy}><LockOpen />Unlock for {minutes} min</button>
	{/snippet}
</Dialog>
