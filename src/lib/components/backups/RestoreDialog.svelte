<script lang="ts">
	import { LoaderCircle, LockOpen, RotateCcw, TriangleAlert } from '@lucide/svelte';
	import Dialog from '#lib/components/Dialog.svelte';
	import { restoreConfirmation, type BackupRun } from '#lib/backups.ts';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { connections, refreshConnections, toast } from '#lib/client/state.svelte.ts';

	let { run = $bindable(), done }: { run: BackupRun | null; done: () => Promise<void> } = $props();

	let targetId = $state('');
	let confirm = $state('');
	let busy = $state(false);
	let unlocking = $state(false);

	$effect.pre(() => {
		if (run) {
			targetId = connections.list.some((c) => c.id === run!.connectionId) ? run.connectionId! : '';
			confirm = '';
		}
	});

	const candidates = $derived(run ? connections.list.filter((c) => c.engine === run!.engine) : []);
	const target = $derived(candidates.find((c) => c.id === targetId));
	const expected = $derived(run && target ? restoreConfirmation(run, target) : '');
	const readOnly = $derived(target?.access?.readOnly ?? true);
	const needsDatabase = $derived(!!run && !!target && target.engine === 'mysql' && !run.allDatabases && !target.database);

	async function unlock() {
		if (!target) return;
		unlocking = true;
		try {
			await api.post(`/api/connections/${target.id}/unlock`, { minutes: 15, reason: 'Restore a backup' });
			await refreshConnections();
		} catch (err) {
			toast('error', 'Could not unlock writes', errorMessage(err));
		} finally {
			unlocking = false;
		}
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!run || !target || confirm.trim() !== expected) return;
		busy = true;
		try {
			await api.post(`/api/backups/runs/${run.id}/restore`, { targetConnectionId: target.id, confirm: confirm.trim() });
			toast('success', 'Restore started', `Into ${target.name}. Follow it in the runs list.`);
			run = null;
			await done();
		} catch (err) {
			toast('error', 'Could not restore', errorMessage(err));
		} finally {
			busy = false;
		}
	}
</script>

<Dialog
	bind:open={() => !!run, (v) => !v && (run = null)}
	title="Restore backup"
	description={run ? `${run.connectionName} · ${new Date(run.startedAt).toLocaleString()}` : ''}
>
	{#if run}
		<form id="restore" class="space-y-4" onsubmit={submit}>
			<div>
				<label class="label" for="r-target">Restore into</label>
				<select id="r-target" class="input" bind:value={targetId} required>
					<option value="" disabled>Choose a connection…</option>
					{#each candidates as c (c.id)}<option value={c.id}>{c.name} — {c.user}@{c.host}/{c.database || '*'}</option>{/each}
				</select>
				{#if run.allDatabases}
					<p class="mt-1.5 text-xs text-muted-foreground">
						This dump holds every database ({run.databases.join(', ')}) and recreates each one by name on the target server.
					</p>
				{/if}
			</div>

			{#if target}
				{#if needsDatabase}
					<p class="rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs text-danger">
						This connection has no default database. Set one on the connection so the dump knows where to go.
					</p>
				{:else if readOnly}
					<div class="flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs">
						<span>{target.name} is read-only for you. Unlock writes to restore into it.</span>
						{#if target.access?.write === 'unlock'}
							<button type="button" class="btn btn-secondary btn-sm" onclick={unlock} disabled={unlocking}>
								{#if unlocking}<LoaderCircle class="animate-spin" />{:else}<LockOpen />{/if}Unlock 15 min
							</button>
						{/if}
					</div>
				{:else}
					<div class="flex gap-2.5 rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs">
						<TriangleAlert class="mt-0.5 size-4 shrink-0 text-danger" />
						<p>
							Everything in the backup replaces what's in <b>{target.name}</b>:
							{#if target.engine === 'postgres'}
								<code>pg_restore --clean --if-exists --no-owner</code> drops and recreates each table, view and function it contains.
							{:else}
								each table in the dump is dropped and recreated; routines, triggers and events are created as the connection's user.
							{/if}
							Changes made since the backup are lost. Objects that aren't in the backup are left alone.
						</p>
					</div>
					<div>
						<label class="label" for="r-confirm">Type <code class="text-foreground">{expected}</code> to confirm</label>
						<input id="r-confirm" class="input font-mono" autocomplete="off" spellcheck="false" bind:value={confirm} />
					</div>
				{/if}
			{/if}
		</form>
	{/if}
	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (run = null)}>Cancel</button>
		<button class="btn btn-danger" form="restore" disabled={busy || !target || readOnly || needsDatabase || confirm.trim() !== expected}>
			{#if busy}<LoaderCircle class="animate-spin" />{:else}<RotateCcw />{/if}Restore
		</button>
	{/snippet}
</Dialog>
