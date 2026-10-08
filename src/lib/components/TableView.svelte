<script lang="ts">
	import { ChevronLeft, ChevronRight, Download, Filter, LoaderCircle, Plus, RefreshCw, Search, SquareTerminal, X } from '@lucide/svelte';
	import DataGrid, { type SelectedCell } from './DataGrid.svelte';
	import CellInspector from './CellInspector.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { csv, download, int } from '#lib/client/format.ts';
	import type { ColumnInfo } from '#lib/types.ts';

	type Op = '=' | '!=' | '<' | '>' | '<=' | '>=' | 'contains' | 'starts' | 'null' | 'notnull';
	type FilterRow = { column: string; op: Op; value: string };

	let {
		connectionId,
		schema,
		table,
		onquery
	}: { connectionId: string; schema: string; table: string; onquery: (sql: string) => void } = $props();

	let columns = $state<ColumnInfo[]>([]);
	let rows = $state<unknown[][]>([]);
	let total = $state<number | null>(null);
	let totalIsEstimate = $state(false);
	let durationMs = $state(0);
	let loading = $state(false);
	let error = $state('');

	let limit = $state(100);
	let offset = $state(0);
	let sort = $state<{ column: string; dir: 'asc' | 'desc' } | null>(null);
	let search = $state('');
	let debouncedSearch = $state('');
	let filters = $state<FilterRow[]>([]);
	let showFilters = $state(false);
	let selected = $state<SelectedCell | null>(null);

	const OPS: { value: Op; label: string }[] = [
		{ value: '=', label: '=' },
		{ value: '!=', label: '≠' },
		{ value: '<', label: '<' },
		{ value: '>', label: '>' },
		{ value: '<=', label: '≤' },
		{ value: '>=', label: '≥' },
		{ value: 'contains', label: 'contains' },
		{ value: 'starts', label: 'starts with' },
		{ value: 'null', label: 'is null' },
		{ value: 'notnull', label: 'is not null' }
	];

	$effect(() => {
		const s = search;
		const t = setTimeout(() => {
			debouncedSearch = s;
			offset = 0;
		}, 300);
		return () => clearTimeout(t);
	});

	const activeFilters = $derived(filters.filter((f) => f.column && (f.op === 'null' || f.op === 'notnull' || f.value !== '')));

	let seq = 0;
	async function load() {
		const mine = ++seq;
		loading = true;
		error = '';
		const q = new URLSearchParams({
			schema,
			table,
			limit: String(limit),
			offset: String(offset),
			filters: JSON.stringify(activeFilters)
		});
		if (sort) q.set('sort', sort.column), q.set('dir', sort.dir);
		if (debouncedSearch) q.set('q', debouncedSearch);
		try {
			const res = await api.get<{ columns: ColumnInfo[]; rows: unknown[][]; total: number | null; totalIsEstimate: boolean; durationMs: number }>(
				`/api/connections/${connectionId}/rows?${q}`
			);
			if (mine !== seq) return; // a newer request superseded this one
			columns = res.columns;
			rows = res.rows;
			total = res.total;
			totalIsEstimate = res.totalIsEstimate;
			durationMs = res.durationMs;
			selected = null;
		} catch (err) {
			if (mine === seq) error = errorMessage(err);
		} finally {
			if (mine === seq) loading = false;
		}
	}

	// Reset paging/sorting when switching tables.
	let lastKey = '';
	$effect(() => {
		const key = `${connectionId}/${schema}.${table}`;
		if (key !== lastKey) {
			lastKey = key;
			offset = 0;
			sort = null;
			filters = [];
			search = '';
			debouncedSearch = '';
		}
	});

	$effect(() => {
		// Track every input that changes the result set.
		void [connectionId, schema, table, limit, offset, sort, debouncedSearch, JSON.stringify(activeFilters)];
		load();
	});

	function toggleSort(column: string) {
		sort = sort?.column !== column ? { column, dir: 'asc' } : sort.dir === 'asc' ? { column, dir: 'desc' } : null;
		offset = 0;
	}

	const fields = $derived(columns.map((c) => ({ name: c.name, type: c.type })));
	const pks = $derived(columns.filter((c) => c.isPrimaryKey).map((c) => c.name));
	const pageEnd = $derived(offset + rows.length);
	const hasNext = $derived(total == null ? rows.length === limit : pageEnd < total);

	const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
	function openInSql() {
		const order = sort ? `\norder by ${ident(sort.column)} ${sort.dir}` : '';
		onquery(`select *\nfrom ${ident(schema)}.${ident(table)}${order}\nlimit ${limit};`);
	}
</script>

<div class="flex h-full flex-col">
	<div class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
		<div class="relative w-64">
			<Search class="absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
			<input class="input h-7 pl-7 text-xs" placeholder="Search all columns…" bind:value={search} />
		</div>
		<button
			class="btn btn-sm {showFilters || activeFilters.length ? 'btn-secondary text-primary' : 'btn-ghost'}"
			onclick={() => {
				showFilters = !showFilters;
				if (showFilters && !filters.length) filters.push({ column: columns[0]?.name ?? '', op: '=', value: '' });
			}}
		>
			<Filter />Filter{#if activeFilters.length}<span class="rounded bg-primary-soft px-1 text-[10px]">{activeFilters.length}</span>{/if}
		</button>
		<div class="ml-auto flex items-center gap-1">
			<button class="btn btn-ghost btn-sm" title="Open as SQL" onclick={openInSql}><SquareTerminal />SQL</button>
			<button
				class="btn btn-ghost btn-sm"
				title="Export this page as CSV"
				disabled={!rows.length}
				onclick={() => download(`${schema}.${table}.csv`, csv(fields.map((f) => f.name), rows), 'text/csv')}
			>
				<Download />CSV
			</button>
			<button class="btn btn-ghost btn-icon btn-sm" title="Refresh" onclick={load}>
				{#if loading}<LoaderCircle class="animate-spin" />{:else}<RefreshCw />{/if}
			</button>
		</div>
	</div>

	{#if showFilters}
		<div class="space-y-1.5 border-b border-border bg-surface px-3 py-2">
			{#each filters as f, i (i)}
				<div class="flex items-center gap-1.5">
					<span class="w-10 text-right text-[11px] text-muted-foreground">{i === 0 ? 'where' : 'and'}</span>
					<select class="input h-7 w-44 font-mono text-xs" bind:value={f.column}>
						{#each columns as c (c.name)}<option value={c.name}>{c.name}</option>{/each}
					</select>
					<select class="input h-7 w-32 text-xs" bind:value={f.op}>
						{#each OPS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
					</select>
					{#if f.op !== 'null' && f.op !== 'notnull'}
						<input class="input h-7 w-56 font-mono text-xs" placeholder="value" bind:value={f.value} />
					{/if}
					<button class="btn btn-ghost btn-icon btn-sm" aria-label="Remove filter" onclick={() => filters.splice(i, 1)}><X /></button>
				</div>
			{/each}
			<button class="btn btn-ghost btn-sm ml-11" onclick={() => filters.push({ column: columns[0]?.name ?? '', op: '=', value: '' })}>
				<Plus />Add condition
			</button>
		</div>
	{/if}

	<div class="flex min-h-0 flex-1">
		<div class="relative min-w-0 flex-1">
			{#if error}
				<div class="m-4 rounded-lg border border-danger/30 bg-danger/5 p-3 font-mono text-xs text-danger">{error}</div>
			{:else if columns.length}
				<DataGrid {fields} {rows} {offset} {sort} onsort={toggleSort} primaryKeys={pks} bind:selected />
				{#if !rows.length && !loading}
					<div class="pointer-events-none absolute inset-x-0 top-24 text-center text-sm text-muted-foreground">No rows</div>
				{/if}
			{/if}
			{#if loading && !columns.length}
				<div class="grid h-full place-items-center"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
			{/if}
		</div>
		<CellInspector bind:cell={selected} />
	</div>

	<div class="flex items-center gap-3 border-t border-border bg-surface px-3 py-1.5 text-[11px] text-muted-foreground">
		<span class="tabular-nums">
			{#if rows.length}{int(offset + 1)}–{int(pageEnd)}{:else}0{/if}
			{#if total != null}of {totalIsEstimate ? '~' : ''}{int(total)}{/if} rows
		</span>
		<span class="tabular-nums">{durationMs} ms</span>
		<div class="ml-auto flex items-center gap-1">
			<select class="input h-6 w-20 py-0 text-[11px]" bind:value={limit} onchange={() => (offset = 0)}>
				{#each [50, 100, 250, 500, 1000] as n (n)}<option value={n}>{n} / page</option>{/each}
			</select>
			<button class="btn btn-ghost btn-icon btn-sm" disabled={offset === 0} onclick={() => (offset = Math.max(0, offset - limit))} aria-label="Previous page"><ChevronLeft /></button>
			<button class="btn btn-ghost btn-icon btn-sm" disabled={!hasNext} onclick={() => (offset += limit)} aria-label="Next page"><ChevronRight /></button>
		</div>
	</div>
</div>
