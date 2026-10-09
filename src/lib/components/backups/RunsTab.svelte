<script lang="ts">
	import { CircleAlert, CircleCheck, Download, LoaderCircle, Play, RotateCcw, Trash2, TriangleAlert } from '@lucide/svelte';
	import Dialog from '#lib/components/Dialog.svelte';
	import Switch from '#lib/components/Switch.svelte';
	import RestoreDialog from './RestoreDialog.svelte';
	import type { BackupsData } from './types.ts';
	import type { BackupRun } from '#lib/backups.ts';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { ago, bytes, duration } from '#lib/client/format.ts';
	import { confirmAction, connections, toast } from '#lib/client/state.svelte.ts';

	let { data, reload, goto }: { data: BackupsData; reload: () => Promise<void>; goto: (t: 'destinations') => void } = $props();

	let filter = $state('');
	let expanded = $state<string | null>(null);
	const runs = $derived(data.runs.filter((r) => !filter || r.connectionId === filter));
	const backupable = $derived(connections.list.filter((c) => c.engine === 'postgres' || c.engine === 'mysql'));

	// --- back up now ---------------------------------------------------------------
	let adhoc = $state({ open: false, connectionId: '', destinationId: '', compress: true, busy: false });
	function openAdhoc() {
		adhoc = { open: true, connectionId: filter || backupable[0]?.id || '', destinationId: data.destinations[0]?.id ?? '', compress: true, busy: false };
	}
	async function startAdhoc(e: SubmitEvent) {
		e.preventDefault();
		adhoc.busy = true;
		try {
			await api.post('/api/backups/runs', { connectionId: adhoc.connectionId, destinationId: adhoc.destinationId, compress: adhoc.compress });
			adhoc.open = false;
			toast('success', 'Backup started');
			await reload();
		} catch (err) {
			toast('error', 'Could not start the backup', errorMessage(err));
		} finally {
			adhoc.busy = false;
		}
	}

	// --- actions -------------------------------------------------------------------
	let restoring = $state<BackupRun | null>(null);

	async function remove(r: BackupRun) {
		const file = r.kind === 'backup' && r.fileName && !r.deletedAt;
		const ok = await confirmAction({
			title: file ? 'Delete this backup?' : 'Remove this entry?',
			body: file ? `The file is deleted from ${r.destinationName}. This can't be undone.` : 'Only the log entry is removed.',
			detail: file ? r.fileName! : undefined,
			confirmLabel: 'Delete',
			danger: true
		});
		if (!ok) return;
		try {
			await api.del(`/api/backups/runs/${r.id}`);
			await reload();
		} catch (err) {
			toast('error', 'Could not delete', errorMessage(err));
		}
	}

	const canDownload = (r: BackupRun) => r.kind === 'backup' && r.status === 'success' && !r.deletedAt && !!r.fileName;
	const FORMAT: Record<string, string> = { 'pg-custom': 'pg_dump custom', 'mysql-sql-gz': 'SQL, gzip', 'mysql-sql': 'SQL' };
</script>

<div class="flex flex-wrap items-center gap-2">
	<select class="input h-9 w-56 text-xs" bind:value={filter}>
		<option value="">All connections</option>
		{#each connections.list as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
	</select>
	<div class="ml-auto">
		<button class="btn btn-primary" onclick={openAdhoc} disabled={!data.destinations.length || !backupable.length} title={data.destinations.length ? '' : 'Add a destination first'}>
			<Play />Back up now
		</button>
	</div>
</div>

{#if !data.destinations.length}
	<div class="card px-6 py-12 text-center">
		<p class="text-sm font-medium">No destinations yet</p>
		<p class="mt-1 text-[13px] text-muted-foreground">Add a folder, an SFTP server or an S3 bucket to store backups in.</p>
		<button class="btn btn-primary mt-4" onclick={() => goto('destinations')}>Add a destination</button>
	</div>
{:else}
	<div class="card overflow-hidden">
		<table class="w-full table-fixed text-left text-[13px]">
			<thead class="border-b border-border bg-surface text-[11px] text-muted-foreground">
				<tr>
					<th class="w-28 px-4 py-2 font-medium">When</th>
					<th class="w-48 px-4 py-2 font-medium">Connection</th>
					<th class="px-4 py-2 font-medium">File</th>
					<th class="w-24 px-4 py-2 text-right font-medium">Size</th>
					<th class="w-24 px-4 py-2 text-right font-medium">Took</th>
					<th class="w-28 px-4 py-2 font-medium">Status</th>
					<th class="w-32 px-4 py-2"></th>
				</tr>
			</thead>
			<tbody class="divide-y divide-border">
				{#each runs as r (r.id)}
					<tr class="align-top hover:bg-accent/30">
						<td class="px-4 py-2.5 text-xs text-muted-foreground" title={new Date(r.startedAt).toLocaleString()}>
							{ago(r.startedAt)}
							<p class="mt-0.5 text-[11px] opacity-80">{r.kind === 'restore' ? 'restore' : r.trigger === 'schedule' ? (r.scheduleName ?? 'schedule') : 'manual'}</p>
						</td>
						<td class="truncate px-4 py-2.5 text-xs">
							{#if r.connectionId && connections.list.some((c) => c.id === r.connectionId)}
								<a class="hover:text-primary" href="/c/{r.connectionId}">{r.connectionName}</a>
							{:else}{r.connectionName}{/if}
							<p class="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{r.databases.join(', ') || '—'}</p>
						</td>
						<td class="min-w-0 px-4 py-2.5">
							<button class="block w-full min-w-0 text-left" onclick={() => (expanded = expanded === r.id ? null : r.id)}>
								<p class="truncate font-mono text-[11px] {r.deletedAt ? 'text-muted-foreground line-through' : ''}">
									{#if r.kind === 'restore'}<RotateCcw class="mr-1 inline size-3" />{/if}{r.fileName ?? '—'}
								</p>
								<p class="mt-0.5 truncate text-[11px] text-muted-foreground">
									{[`${r.kind === 'restore' ? 'from' : 'to'} ${r.destinationName}`, r.format && (FORMAT[r.format] ?? r.format), r.deletedAt && `deleted ${ago(r.deletedAt)}`].filter(Boolean).join(' · ')}
								</p>
							</button>
							{#if expanded === r.id && (r.error || r.warnings)}
								<pre class="mt-1.5 max-h-48 overflow-auto rounded-lg border border-border bg-surface p-2 font-mono text-[11px] whitespace-pre-wrap {r.error ? 'text-danger' : 'text-warning'}">{r.error ?? r.warnings}</pre>
							{/if}
						</td>
						<td class="px-4 py-2.5 text-right font-mono text-xs tabular-nums">{r.sizeBytes != null ? bytes(r.sizeBytes) : '—'}</td>
						<td class="px-4 py-2.5 text-right text-xs text-muted-foreground tabular-nums">{r.durationMs != null ? duration(r.durationMs) : '—'}</td>
						<td class="px-4 py-2.5 text-xs">
							{#if r.status === 'running'}
								<span class="badge badge-primary"><LoaderCircle class="animate-spin" />running</span>
							{:else if r.status === 'failed'}
								<button class="badge badge-danger" title={r.error ?? ''} onclick={() => (expanded = expanded === r.id ? null : r.id)}><CircleAlert />failed</button>
							{:else if r.warnings && r.kind === 'restore'}
								<button class="badge badge-warning" onclick={() => (expanded = expanded === r.id ? null : r.id)}><TriangleAlert />warnings</button>
							{:else}
								<span class="badge badge-success"><CircleCheck />{r.kind === 'restore' ? 'restored' : 'ok'}</span>
							{/if}
						</td>
						<td class="px-3 py-2 text-right whitespace-nowrap">
							{#if canDownload(r)}
								<a class="btn btn-ghost btn-icon btn-sm" title="Download" href="/api/backups/runs/{r.id}/download" download><Download /></a>
								<button class="btn btn-ghost btn-icon btn-sm" title="Restore…" onclick={() => (restoring = r)}><RotateCcw /></button>
							{/if}
							{#if r.status !== 'running'}
								<button class="btn btn-ghost btn-icon btn-sm hover:text-danger" title="Delete" onclick={() => remove(r)}><Trash2 /></button>
							{/if}
						</td>
					</tr>
				{:else}
					<tr><td colspan="7" class="px-4 py-10 text-center text-xs text-muted-foreground">No backups yet. Create a schedule, or back up now.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

<Dialog bind:open={adhoc.open} title="Back up now" description="A one-off dump. It isn't pruned by any schedule's retention.">
	<form id="adhoc" class="space-y-3" onsubmit={startAdhoc}>
		<div>
			<label class="label" for="a-conn">Connection</label>
			<select id="a-conn" class="input" bind:value={adhoc.connectionId} required>
				{#each backupable as c (c.id)}<option value={c.id}>{c.name} — {c.database || 'all databases'}</option>{/each}
			</select>
		</div>
		<div>
			<label class="label" for="a-dest">Destination</label>
			<select id="a-dest" class="input" bind:value={adhoc.destinationId} required>
				{#each data.destinations as d (d.id)}<option value={d.id}>{d.name} — {d.where}</option>{/each}
			</select>
		</div>
		<div class="flex items-center justify-between gap-3">
			<div>
				<p class="text-[13px]">Compress</p>
				<p class="text-xs text-muted-foreground">gzip for MySQL/MariaDB; pg_dump's own compression for Postgres.</p>
			</div>
			<Switch bind:checked={adhoc.compress} label="Compress" />
		</div>
	</form>
	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (adhoc.open = false)}>Cancel</button>
		<button class="btn btn-primary" form="adhoc" disabled={adhoc.busy || !adhoc.connectionId || !adhoc.destinationId}>
			{#if adhoc.busy}<LoaderCircle class="animate-spin" />{:else}<Play />{/if}Start backup
		</button>
	{/snippet}
</Dialog>

<RestoreDialog bind:run={restoring} done={reload} />
