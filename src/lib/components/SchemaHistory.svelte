<script lang="ts">
	import { untrack } from 'svelte';
	import { ArrowRight, Camera, Clock, Download, GitCompareArrows, History, LoaderCircle, RefreshCw, Trash2, X } from '@lucide/svelte';
	import SchemaDiffView, { type DiffSide } from './SchemaDiffView.svelte';
	import Switch from './Switch.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { ago, bytes, download } from '#lib/client/format.ts';
	import { confirmAction, connections, isAdmin, toast } from '#lib/client/state.svelte.ts';
	import type { SchemaDiff } from '#lib/schema/diff.ts';
	import type { SchemaSnapshotMeta } from '#lib/schema/model.ts';
	import type { Connection } from '#lib/types.ts';

	let { conn, composing = $bindable(false) }: { conn: Connection; composing?: boolean } = $props();

	type Settings = { auto: boolean; lastCheckedAt: string | null; lastError: string | null };
	type Listing = { supported: boolean; settings: Settings; snapshots: SchemaSnapshotMeta[] };
	type Side = { connectionId: string; version: string };
	type Result = { from: DiffSide; to: DiffSide; diff: SchemaDiff; migration: string | null };

	let listing = $state<Listing | null>(null);
	let loading = $state(false);
	let label = $state('');
	let note = $state('');
	let saving = $state(false);
	let checking = $state(false);
	let from = $state<Side>({ connectionId: '', version: 'live' });
	let to = $state<Side>({ connectionId: '', version: 'live' });
	let result = $state<Result | null>(null);
	let comparing = $state(false);
	let compareError = $state<string | null>(null);
	/** Snapshot lists of other connections, loaded when picked as a side. */
	let others = $state<Record<string, SchemaSnapshotMeta[]>>({});

	const snapshots = $derived(listing?.snapshots ?? []);
	const peers = $derived(connections.list.filter((c) => c.engine === conn.engine));

	async function load() {
		loading = true;
		try {
			listing = await api.get<Listing>(`/api/connections/${conn.id}/snapshots`);
			others[conn.id] = listing.snapshots;
		} catch (err) {
			toast('error', 'Could not load schema history', errorMessage(err));
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		const id = conn.id;
		untrack(async () => {
			result = null;
			from = { connectionId: id, version: 'live' };
			to = { connectionId: id, version: 'live' };
			await load();
			if (listing?.snapshots[0]) from = { connectionId: id, version: listing.snapshots[0].id };
		});
	});

	async function snapshotsOf(connectionId: string) {
		if (others[connectionId]) return;
		try {
			const l = await api.get<Listing>(`/api/connections/${connectionId}/snapshots`);
			others[connectionId] = l.snapshots;
		} catch {
			others[connectionId] = [];
		}
	}

	async function takeSnapshot(e: SubmitEvent) {
		e.preventDefault();
		saving = true;
		try {
			const meta = await api.post<SchemaSnapshotMeta>(`/api/connections/${conn.id}/snapshots`, { label, note });
			toast('success', 'Snapshot saved', `${meta.stats.tables} tables, ${meta.stats.views} views, ${meta.stats.routines} routines`);
			label = '';
			note = '';
			composing = false;
			await load();
		} catch (err) {
			toast('error', 'Could not snapshot the schema', errorMessage(err));
		} finally {
			saving = false;
		}
	}

	async function setAuto(auto: boolean) {
		try {
			const settings = await api.put<Settings>(`/api/connections/${conn.id}/snapshots/settings`, { auto });
			if (listing) listing.settings = settings;
			toast('success', auto ? 'Auto snapshots on' : 'Auto snapshots off', auto ? 'The schema is checked every 6 hours; a snapshot is stored when it changes.' : undefined);
		} catch (err) {
			toast('error', 'Could not change the setting', errorMessage(err));
			await load();
		}
	}

	async function checkNow() {
		checking = true;
		try {
			const r = await api.post<{ changed: boolean; settings: Settings }>(`/api/connections/${conn.id}/snapshots/check`);
			toast(r.changed ? 'success' : 'info', r.changed ? 'Schema changed — snapshot stored' : 'No change since the latest snapshot');
			await load();
		} catch (err) {
			toast('error', 'Check failed', errorMessage(err));
			await load();
		} finally {
			checking = false;
		}
	}

	async function remove(s: SchemaSnapshotMeta) {
		const ok = await confirmAction({ title: `Delete snapshot “${s.label}”?`, body: 'It disappears from the schema history for everyone.', confirmLabel: 'Delete', danger: true });
		if (!ok) return;
		try {
			await api.del(`/api/connections/${conn.id}/snapshots/${s.id}`);
			if (from.version === s.id) from = { connectionId: conn.id, version: 'live' };
			if (to.version === s.id) to = { connectionId: conn.id, version: 'live' };
			await load();
		} catch (err) {
			toast('error', 'Could not delete', errorMessage(err));
		}
	}

	async function exportJson(s: SchemaSnapshotMeta) {
		try {
			const full = await api.get<{ schema: unknown }>(`/api/connections/${conn.id}/snapshots/${s.id}`);
			const name = `${conn.name}-${s.createdAt.slice(0, 19).replace(/[:T]/g, '-')}.schema.json`.replace(/[^\w.-]+/g, '_');
			download(name, JSON.stringify({ ...s, schema: full.schema }, null, 2), 'application/json');
		} catch (err) {
			toast('error', 'Could not download', errorMessage(err));
		}
	}

	const sourceOf = (s: Side) =>
		s.version === 'live' ? { kind: 'live', connectionId: s.connectionId } : { kind: 'snapshot', connectionId: s.connectionId, snapshotId: s.version };

	async function compare() {
		comparing = true;
		compareError = null;
		try {
			result = await api.post<Result>(`/api/connections/${conn.id}/schema-diff`, { from: sourceOf(from), to: sourceOf(to) });
		} catch (err) {
			result = null;
			compareError = errorMessage(err);
		} finally {
			comparing = false;
		}
	}

	function compareWith(f: Side, t: Side) {
		from = f;
		to = t;
		compare();
	}

	function pickConnection(side: 'from' | 'to', connectionId: string) {
		const next = { connectionId, version: 'live' };
		if (side === 'from') from = next;
		else to = next;
		snapshotsOf(connectionId);
	}

	const sameSides = $derived(from.connectionId === to.connectionId && from.version === to.version);
	const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
</script>

{#snippet sidePicker(side: 'from' | 'to', value: Side)}
	<div class="flex min-w-0 flex-1 items-center gap-1.5">
		<span class="w-10 shrink-0 text-[11px] font-medium text-muted-foreground uppercase">{side}</span>
		<select class="input h-8 w-44 shrink-0 text-xs" value={value.connectionId} onchange={(e) => pickConnection(side, e.currentTarget.value)} aria-label="{side} connection">
			{#each peers as p (p.id)}<option value={p.id}>{p.id === conn.id ? `${p.name} (this)` : p.name}</option>{/each}
		</select>
		<select
			class="input h-8 min-w-0 flex-1 text-xs"
			value={value.version}
			onchange={(e) => (side === 'from' ? (from = { ...from, version: e.currentTarget.value }) : (to = { ...to, version: e.currentTarget.value }))}
			aria-label="{side} version"
		>
			<option value="live">Live schema (now)</option>
			{#each others[value.connectionId] ?? [] as s (s.id)}
				<option value={s.id}>{s.auto ? '⟳ ' : ''}{s.label} — {when(s.createdAt)}</option>
			{/each}
		</select>
	</div>
{/snippet}

<div class="flex h-full min-h-0">
	<!-- Timeline -->
	<aside class="flex w-80 shrink-0 flex-col border-r border-border bg-surface/40">
		<div class="flex items-center gap-2 border-b border-border px-3 py-2.5">
			<History class="size-4 text-primary" />
			<h2 class="text-[13px] font-semibold">Schema history</h2>
			<button class="btn btn-ghost btn-icon btn-sm ml-auto" title="Refresh" onclick={load} disabled={loading}><RefreshCw class={loading ? 'animate-spin' : ''} /></button>
			<button class="btn btn-primary btn-sm" onclick={() => (composing = !composing)} disabled={listing?.supported === false}><Camera />Snapshot</button>
		</div>

		{#if listing && !listing.supported}
			<p class="p-4 text-xs text-muted-foreground">Schema snapshots aren't available for this engine yet.</p>
		{/if}

		{#if composing}
			<form class="space-y-2 border-b border-border bg-card p-3" onsubmit={takeSnapshot}>
				<div class="flex items-center justify-between">
					<p class="text-xs font-medium">Snapshot the current schema</p>
					<button type="button" class="btn btn-ghost btn-icon btn-sm -mr-1" aria-label="Cancel" onclick={() => (composing = false)}><X /></button>
				</div>
				<!-- svelte-ignore a11y_autofocus -->
				<input class="input h-8 text-xs" placeholder="Label, e.g. Before Nextcloud 31 upgrade" maxlength="120" required bind:value={label} autofocus />
				<textarea class="input h-16 resize-none py-1.5 text-xs" placeholder="Note (optional)" maxlength="2000" bind:value={note}></textarea>
				<button class="btn btn-primary btn-sm w-full" disabled={saving || !label.trim()}>
					{#if saving}<LoaderCircle class="animate-spin" />Reading the catalog…{:else}<Camera />Save snapshot{/if}
				</button>
			</form>
		{/if}

		{#if listing?.supported && isAdmin()}
			<div class="space-y-1.5 border-b border-border px-3 py-2.5">
				<div class="flex items-center gap-2.5">
					<div class="min-w-0 flex-1">
						<p class="text-xs font-medium">Auto snapshot on change</p>
						<p class="text-[11px] leading-snug text-muted-foreground">Checked every 6 h; stored only when the schema hash changes (e.g. after an app upgrade).</p>
					</div>
					<Switch label="Auto snapshot on change" checked={listing.settings.auto} onchange={setAuto} />
				</div>
				<div class="flex items-center gap-2 text-[11px] text-muted-foreground">
					<span class="min-w-0 flex-1 truncate" title={listing.settings.lastError ?? undefined}>
						{#if listing.settings.lastError}<span class="text-danger">Last check failed: {listing.settings.lastError}</span>
						{:else if listing.settings.lastCheckedAt}Last checked {ago(listing.settings.lastCheckedAt)}
						{:else}Not checked yet{/if}
					</span>
					<button class="btn btn-ghost btn-sm -mr-1.5" onclick={checkNow} disabled={checking}>
						{#if checking}<LoaderCircle class="animate-spin" />{:else}<RefreshCw />{/if}Check now
					</button>
				</div>
			</div>
		{/if}

		<ol class="min-h-0 flex-1 overflow-y-auto py-2">
			<li class="relative flex gap-2.5 px-3 pb-3">
				<span class="relative z-10 mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-primary-soft ring-4 ring-surface"><span class="size-2 rounded-full bg-primary"></span></span>
				<div class="min-w-0 flex-1">
					<p class="text-xs font-medium">Live schema</p>
					<p class="text-[11px] text-muted-foreground">Read from the server when compared</p>
				</div>
				{#if snapshots[0]}
					<button class="btn btn-ghost btn-sm -mr-1.5" title="Compare the latest snapshot with the live schema" onclick={() => compareWith({ connectionId: conn.id, version: snapshots[0].id }, { connectionId: conn.id, version: 'live' })}>
						<GitCompareArrows />vs latest
					</button>
				{/if}
				{#if snapshots.length}<span class="absolute top-6 bottom-0 left-[1.32rem] w-px bg-border"></span>{/if}
			</li>
			{#each snapshots as s, i (s.id)}
				{@const prev = snapshots[i + 1]}
				{@const same = prev && prev.hash === s.hash}
				<li class="group relative flex gap-2.5 px-3 pb-3">
					<span class="relative z-10 mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-border bg-card ring-4 ring-surface">
						{#if s.auto}<Clock class="size-3 text-muted-foreground" />{:else}<Camera class="size-3 text-primary" />{/if}
					</span>
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-1.5">
							<p class="truncate text-xs font-medium" title={s.label}>{s.label}</p>
							{#if s.auto}<span class="badge h-4 px-1 text-[10px]">auto</span>{/if}
						</div>
						<p class="text-[11px] text-muted-foreground" title={new Date(s.createdAt).toLocaleString()}>
							{ago(s.createdAt)}{s.createdBy ? ` · ${s.createdBy}` : ''}
						</p>
						{#if s.note}<p class="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground/90">{s.note}</p>{/if}
						<p class="mt-0.5 font-mono text-[10.5px] text-muted-foreground/80">
							{s.stats.tables} tables · {s.stats.columns} cols · {s.stats.views} views · {s.stats.routines} fn · {bytes(s.sizeBytes)}
							{#if same}<span class="text-muted-foreground"> · no change</span>{/if}
						</p>
						<div class="mt-1 flex flex-wrap gap-1 opacity-70 group-hover:opacity-100">
							<button class="btn btn-ghost btn-sm h-6 px-1.5 text-[11px]" onclick={() => compareWith({ connectionId: conn.id, version: s.id }, { connectionId: conn.id, version: 'live' })}>vs live</button>
							{#if prev}
								<button class="btn btn-ghost btn-sm h-6 px-1.5 text-[11px]" onclick={() => compareWith({ connectionId: conn.id, version: prev.id }, { connectionId: conn.id, version: s.id })}>vs previous</button>
							{/if}
							<button class="btn btn-ghost btn-icon btn-sm size-6" title="Download as JSON" onclick={() => exportJson(s)}><Download /></button>
							{#if s.canDelete}
								<button class="btn btn-ghost btn-icon btn-sm size-6 hover:text-danger" title="Delete snapshot" onclick={() => remove(s)}><Trash2 /></button>
							{/if}
						</div>
					</div>
					{#if i < snapshots.length - 1}<span class="absolute top-6 bottom-0 left-[1.32rem] w-px bg-border"></span>{/if}
				</li>
			{/each}
			{#if listing && !snapshots.length && listing.supported}
				<li class="px-4 py-6 text-center text-xs text-muted-foreground">No snapshots yet. Take one before an upgrade, then compare it with the live schema afterwards.</li>
			{/if}
		</ol>
	</aside>

	<!-- Compare -->
	<div class="flex min-w-0 flex-1 flex-col">
		<div class="flex items-center gap-3 border-b border-border px-4 py-2.5">
			<div class="min-w-0 flex-1 space-y-1.5">
				{@render sidePicker('from', from)}
				{@render sidePicker('to', to)}
			</div>
			<button class="btn btn-primary btn-sm" onclick={compare} disabled={comparing || sameSides || listing?.supported === false} title={sameSides ? 'Pick two different versions' : undefined}>
				{#if comparing}<LoaderCircle class="animate-spin" />{:else}<GitCompareArrows />{/if}Compare
			</button>
		</div>
		<div class="min-h-0 flex-1 overflow-y-auto p-4">
			{#if compareError}
				<p class="rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs text-danger">{compareError}</p>
			{:else if result}
				<p class="mb-3 text-xs text-muted-foreground">
					<b class="font-medium text-foreground">{result.from.connectionName}</b> · {result.from.source.kind === 'live' ? 'live' : `${result.from.label} (${when(result.from.at)})`}
					<ArrowRight class="inline size-3" />
					<b class="font-medium text-foreground">{result.to.connectionName}</b> · {result.to.source.kind === 'live' ? 'live' : `${result.to.label} (${when(result.to.at)})`}
				</p>
				<SchemaDiffView from={result.from} to={result.to} diff={result.diff} migration={result.migration} />
			{:else}
				<div class="grid h-full place-items-center">
					<div class="max-w-sm text-center">
						<GitCompareArrows class="mx-auto size-8 text-muted-foreground/60" />
						<p class="mt-3 text-[13px] font-medium">Compare two schemas</p>
						<p class="mt-1 text-xs text-muted-foreground">
							Pick a snapshot or the live schema on each side — of this connection or another {conn.engine === 'mysql' ? 'MySQL/MariaDB' : 'Postgres'} connection — to see
							added, removed and changed tables, columns, indexes, views and functions.
						</p>
					</div>
				</div>
			{/if}
		</div>
	</div>
</div>
