<script lang="ts">
	import { untrack } from 'svelte';
	import { Gauge, Plus, Settings2, SquareTerminal, Table2, X, Eye, Layers, Rows3, Columns3 } from '@lucide/svelte';
	import SchemaTree from '#lib/components/SchemaTree.svelte';
	import TableView from '#lib/components/TableView.svelte';
	import StructureView from '#lib/components/StructureView.svelte';
	import QueryView from '#lib/components/QueryView.svelte';
	import ServerOverview from '#lib/components/ServerOverview.svelte';
	import AccessBadge from '#lib/components/AccessBadge.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { COLORS } from '#lib/client/format.ts';
	import { connections, editor, isAdmin, toast } from '#lib/client/state.svelte.ts';
	import type { RelationSummary, SchemaTree as Tree } from '#lib/types.ts';
	import type { PageProps } from './$types';

	type Tab =
		| { id: string; kind: 'overview' }
		| { id: string; kind: 'table'; schema: string; table: string; relKind: RelationSummary['kind']; view: 'data' | 'structure' }
		| { id: string; kind: 'query'; title: string; sql: string };

	let { data }: PageProps = $props();

	// Prefer the live store copy so edits (e.g. toggling read-only) apply without a reload.
	const conn = $derived(connections.list.find((c) => c.id === data.connection.id) ?? data.connection);
	// Viewers always query read-only, whatever the connection allows.
	const readOnly = $derived(conn.readOnly || !isAdmin());

	let tree = $state<Tree | null>(null);
	let treeLoading = $state(false);
	let showSystem = $state(false);
	let completion = $state<Record<string, Record<string, string[]>>>({});
	let tabs = $state<Tab[]>([]);
	let activeId = $state('overview');
	let queryCounter = 1;

	const storageKey = $derived(`pgm-tabs-${data.connection.id}`);

	// Restore tabs per connection (query drafts survive reloads).
	$effect(() => {
		const key = storageKey;
		untrack(() => {
			let saved: { tabs: Tab[]; activeId: string } | null = null;
			try {
				saved = JSON.parse(localStorage.getItem(key) ?? 'null');
			} catch {}
			tabs = saved?.tabs?.length ? saved.tabs : [{ id: 'overview', kind: 'overview' }];
			activeId = saved?.activeId && tabs.some((t) => t.id === saved!.activeId) ? saved.activeId : tabs[0].id;
			queryCounter = tabs.filter((t) => t.kind === 'query').length + 1;
		});
	});

	$effect(() => {
		const snapshot = JSON.stringify({ tabs, activeId });
		try {
			localStorage.setItem(storageKey, snapshot);
		} catch {}
	});

	async function loadTree() {
		treeLoading = true;
		try {
			tree = await api.get<Tree>(`/api/connections/${data.connection.id}/schema${showSystem ? '?system=1' : ''}`);
		} catch (err) {
			toast('error', 'Could not load schema', errorMessage(err));
		} finally {
			treeLoading = false;
		}
	}

	async function loadCompletion() {
		try {
			const rows = await api.get<{ schema: string; table: string; columns: string[] }[]>(`/api/connections/${data.connection.id}/completion`);
			const out: Record<string, Record<string, string[]>> = {};
			for (const r of rows) (out[r.schema] ??= {})[r.table] = r.columns;
			completion = out;
		} catch {}
	}

	$effect(() => {
		void [data.connection.id, showSystem];
		untrack(loadTree);
	});
	$effect(() => {
		void data.connection.id;
		untrack(loadCompletion);
	});

	function openTable(schema: string, table: string, relKind: RelationSummary['kind'] = 'table') {
		const id = `t:${schema}.${table}`;
		if (!tabs.some((t) => t.id === id)) tabs.push({ id, kind: 'table', schema, table, relKind, view: 'data' });
		activeId = id;
	}

	function openQuery(sql = '') {
		const id = `q:${crypto.randomUUID().slice(0, 8)}`;
		tabs.push({ id, kind: 'query', title: `Query ${queryCounter++}`, sql });
		activeId = id;
	}

	function close(id: string) {
		const i = tabs.findIndex((t) => t.id === id);
		tabs.splice(i, 1);
		if (!tabs.length) tabs.push({ id: 'overview', kind: 'overview' });
		if (activeId === id) activeId = tabs[Math.min(i, tabs.length - 1)].id;
	}

	function onkeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !e.shiftKey) {
			e.preventDefault();
			openQuery();
		}
	}

	const active = $derived(tabs.find((t) => t.id === activeId));
	const activeTableKey = $derived(active?.kind === 'table' ? `${active.schema}.${active.table}` : null);
	const relIcon = { table: Table2, view: Eye, matview: Layers, foreign: Table2, partitioned: Table2 };
</script>

<svelte:head><title>{conn.name} · pg·modern</title></svelte:head>
<svelte:window {onkeydown} />

<div class="flex h-full flex-col">
	<header class="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
		<span class="size-2.5 rounded-full" style="background:{COLORS[conn.color] ?? COLORS.violet}; box-shadow:0 0 10px {COLORS[conn.color] ?? COLORS.violet}"></span>
		<div class="min-w-0">
			<h1 class="truncate text-[14px] leading-tight font-semibold">{conn.name}</h1>
			<p class="truncate font-mono text-[11px] text-muted-foreground">{conn.user}@{conn.host}:{conn.port}/{conn.database}</p>
		</div>
		<AccessBadge {readOnly} />
		<div class="ml-auto flex items-center gap-1.5">
			<button class="btn btn-secondary btn-sm" onclick={() => openQuery()} title="New query (⌘K)"><SquareTerminal />New query</button>
			{#if isAdmin()}
				<button class="btn btn-ghost btn-icon btn-sm" title="Connection settings" onclick={() => (editor.target = conn)}><Settings2 /></button>
			{/if}
		</div>
	</header>

	<div class="flex min-h-0 flex-1">
		<div class="w-64 shrink-0 border-r border-border bg-surface/60">
			<SchemaTree {tree} loading={treeLoading} active={activeTableKey} bind:showSystem onopen={(s, r) => openTable(s, r.name, r.kind)} onrefresh={() => (loadTree(), loadCompletion())} />
		</div>

		<div class="flex min-w-0 flex-1 flex-col">
			<div class="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border bg-surface/60 px-1.5">
				{#each tabs as t (t.id)}
					{@const isActive = t.id === activeId}
					<div
						class="group relative flex h-8 max-w-52 shrink-0 items-center gap-1.5 rounded-t-lg border-x border-t pr-1 pl-2.5 text-[12px] {isActive
							? 'border-border bg-background text-foreground'
							: 'border-transparent text-muted-foreground hover:text-foreground'}"
					>
						{#if isActive}<span class="absolute inset-x-2 top-0 h-px bg-primary"></span>{/if}
						<button class="flex min-w-0 items-center gap-1.5" onclick={() => (activeId = t.id)}>
							{#if t.kind === 'overview'}
								<Gauge class="size-3.5 shrink-0 text-primary" /><span>Overview</span>
							{:else if t.kind === 'table'}
								{@const Icon = relIcon[t.relKind]}
								<Icon class="size-3.5 shrink-0 opacity-70" /><span class="truncate">{t.table}</span>
							{:else}
								<SquareTerminal class="size-3.5 shrink-0 opacity-70" /><span class="truncate">{t.title}</span>
							{/if}
						</button>
						<button class="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-accent {isActive ? 'opacity-60' : ''}" aria-label="Close tab" onclick={() => close(t.id)}>
							<X class="size-3" />
						</button>
					</div>
				{/each}
				<button class="mb-1 ml-1 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="New query (⌘K)" onclick={() => openQuery()}>
					<Plus class="size-3.5" />
				</button>
			</div>

			<div class="min-h-0 flex-1">
				{#each tabs as t (t.id)}
					<!-- Keep tabs mounted so editor state and scroll position survive switching. -->
					<div class="h-full {t.id === activeId ? '' : 'hidden'}">
						{#if t.kind === 'overview'}
							<ServerOverview connectionId={conn.id} {readOnly} onopen={(s, n) => openTable(s, n)} />
						{:else if t.kind === 'table'}
							<div class="flex h-full flex-col">
								<div class="flex items-center gap-2 border-b border-border px-3 py-1.5">
									<span class="font-mono text-xs"><span class="text-muted-foreground">{t.schema}.</span><span class="font-medium">{t.table}</span></span>
									<div class="ml-2 inline-flex rounded-md border border-border bg-surface p-0.5">
										<button class="flex h-6 items-center gap-1 rounded px-2 text-[11px] {t.view === 'data' ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground'}" onclick={() => (t.view = 'data')}><Rows3 class="size-3" />Data</button>
										<button class="flex h-6 items-center gap-1 rounded px-2 text-[11px] {t.view === 'structure' ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground'}" onclick={() => (t.view = 'structure')}><Columns3 class="size-3" />Structure</button>
									</div>
								</div>
								<div class="min-h-0 flex-1">
									{#if t.view === 'data'}
										<TableView connectionId={conn.id} schema={t.schema} table={t.table} onquery={(sql) => openQuery(sql)} />
									{:else}
										<StructureView connectionId={conn.id} schema={t.schema} table={t.table} />
									{/if}
								</div>
							</div>
						{:else}
							<QueryView connectionId={conn.id} {readOnly} bind:sql={t.sql} {completion} />
						{/if}
					</div>
				{/each}
			</div>
		</div>
	</div>
</div>
