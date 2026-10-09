<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		Check,
		ChevronLeft,
		ChevronRight,
		Download,
		FileUp,
		Filter,
		KeyRound,
		LoaderCircle,
		Lock,
		Plus,
		RefreshCw,
		RotateCcw,
		Search,
		SquareTerminal,
		Trash2,
		Undo2,
		X
	} from '@lucide/svelte';
	import DataGrid, { type SelectedCell } from './DataGrid.svelte';
	import CellInspector from './CellInspector.svelte';
	import CellEditor, { DEFAULT_VALUE } from './CellEditor.svelte';
	import Dialog from './Dialog.svelte';
	import ImportCsv from './ImportCsv.svelte';
	import { api, ApiError, errorMessage } from '#lib/client/api.ts';
	import { csv, download, int } from '#lib/client/format.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';
	import { quoteIdentFor } from '#lib/engine.ts';
	import { sameValue, type EditInfo, type RowChange } from '#lib/rows.ts';
	import type { ColumnInfo, Engine, RelationSummary } from '#lib/types.ts';

	type Op = '=' | '!=' | '<' | '>' | '<=' | '>=' | 'contains' | 'starts' | 'null' | 'notnull';
	type FilterRow = { column: string; op: Op; value: string };

	let {
		connectionId,
		engine = 'postgres',
		schema,
		table,
		onquery,
		readOnly = true,
		relKind = 'table',
		onimported
	}: {
		connectionId: string;
		engine?: Engine;
		schema: string;
		table: string;
		onquery: (sql: string) => void;
		/** The current user's effective mode on this connection (editing needs write access). */
		readOnly?: boolean;
		relKind?: RelationSummary['kind'];
		/** After a CSV import; `created` when it made a new table. */
		onimported?: (schema: string, table: string, created: boolean) => void;
	} = $props();

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
	let grid = $state<DataGrid>();

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
			resetStaging(); // staged changes point at row positions of the previous result
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
		untrack(load);
	});

	function toggleSort(column: string) {
		sort = sort?.column !== column ? { column, dir: 'asc' } : sort.dir === 'asc' ? { column, dir: 'desc' } : null;
		offset = 0;
	}

	const fields = $derived(columns.map((c) => ({ name: c.name, type: c.type })));
	const pks = $derived(columns.filter((c) => c.isPrimaryKey).map((c) => c.name));
	const pageEnd = $derived(offset + rows.length);
	const hasNext = $derived(total == null ? rows.length === limit : pageEnd < total);

	const ident = (s: string) => quoteIdentFor(engine, s);
	function openInSql() {
		const order = sort ? `\norder by ${ident(sort.column)} ${sort.dir}` : '';
		onquery(`select *\nfrom ${ident(schema)}.${ident(table)}${order}\nlimit ${limit};`);
	}

	// --- editing -----------------------------------------------------------------------

	/** Key, editable columns and write access for this table (tables only). */
	let info = $state<EditInfo | null>(null);
	const isTable = $derived(relKind === 'table' || relKind === 'partitioned');

	async function loadInfo() {
		if (!isTable) {
			info = null;
			return;
		}
		try {
			info = await api.get<EditInfo>(`/api/connections/${connectionId}/edit?${new URLSearchParams({ schema, table })}`);
		} catch {
			info = null; // editing just stays unavailable
		}
	}
	$effect(() => {
		void [connectionId, schema, table, isTable];
		untrack(loadInfo);
	});

	const canWrite = $derived(!readOnly && !!info?.writable);
	const hasKey = $derived(!!info?.key.length);
	const colMeta = $derived(new Map((info?.columns ?? []).map((c) => [c.name, c])));
	const keyColumns = $derived(info?.key ?? []);

	/** Staged changes: edited cells per loaded row, rows to delete, and new rows. */
	let edits = $state<Record<number, Record<string, unknown>>>({});
	let deleted = $state<Record<number, true>>({});
	let inserts = $state<Record<string, unknown>[]>([]);
	const checked = new SvelteSet<number>();
	let anchor = -1;
	let editing = $state<{ row: number; col: number } | null>(null);

	const updatedRows = $derived(Object.keys(edits).map(Number).filter((r) => !deleted[r] && Object.keys(edits[r]).length));
	const deletedRows = $derived(Object.keys(deleted).map(Number));
	const changeCount = $derived(updatedRows.length + deletedRows.length + inserts.length);
	const dirty = $derived(changeCount > 0);

	function resetStaging() {
		edits = {};
		deleted = {};
		inserts = [];
		checked.clear();
		anchor = -1;
		editing = null;
	}

	// Relocking (or the unlock running out) ends editing; staged changes stay for later.
	$effect(() => {
		if (!canWrite) editing = null;
	});

	const displayRows = $derived([
		...rows.map((r, i) => {
			const e = edits[i];
			return e ? r.map((v, c) => (columns[c].name in e ? e[columns[c].name] : v)) : r;
		}),
		...inserts.map((ins) => columns.map((c) => ins[c.name] ?? null))
	]);

	const rowState = (r: number) => (r >= rows.length ? 'new' : deleted[r] ? 'deleted' : null);
	const cellState = (r: number, c: number) => {
		const name = columns[c]?.name;
		if (r >= rows.length) return inserts[r - rows.length] && name in inserts[r - rows.length] ? 'edited' : 'default';
		return edits[r] && name in edits[r] ? 'edited' : null;
	};

	function activate(r: number, c: number) {
		if (!info || !isTable) return;
		if (!canWrite) {
			if (info.writable) toast('info', 'Read-only', 'Unlock writes to edit rows.');
			return;
		}
		const col = colMeta.get(columns[c].name);
		if (!col) return;
		if (r < rows.length) {
			if (!hasKey) return void toast('info', 'No primary key — editing disabled', 'Rows can only be added to this table.');
			if (deleted[r]) return;
		}
		if (!col.editable) return void toast('info', `${col.name} can’t be edited`, col.reason);
		editing = { row: r, col: c };
	}

	function save(r: number, c: number, value: unknown) {
		const name = columns[c].name;
		if (r >= rows.length) {
			const ins = inserts[r - rows.length];
			if (value === DEFAULT_VALUE) delete ins[name];
			else ins[name] = value;
		} else if (value !== DEFAULT_VALUE) {
			if (sameValue(value, rows[r][c])) {
				if (edits[r]) {
					delete edits[r][name];
					if (!Object.keys(edits[r]).length) delete edits[r];
				}
			} else (edits[r] ??= {})[name] = value;
		}
		editing = null;
		grid?.focus();
	}

	async function addRow() {
		inserts.push({});
		const r = rows.length + inserts.length - 1;
		await tick();
		grid?.scrollToRow(r);
		const first = columns.findIndex((c) => colMeta.get(c.name)?.editable && !colMeta.get(c.name)?.default);
		if (first !== -1) editing = { row: r, col: first };
	}

	function check(r: number, e: MouseEvent) {
		if (e.shiftKey && anchor >= 0) {
			for (let i = Math.min(anchor, r); i <= Math.max(anchor, r); i++) checked.add(i);
		} else if (e.metaKey || e.ctrlKey) {
			if (checked.has(r)) checked.delete(r);
			else checked.add(r);
		} else if (checked.size === 1 && checked.has(r)) checked.clear();
		else {
			checked.clear();
			checked.add(r);
		}
		anchor = r;
	}

	const checkedDeletable = $derived([...checked].filter((r) => r >= rows.length || (hasKey && !deleted[r])).length);
	const checkedRestorable = $derived([...checked].filter((r) => deleted[r]).length);

	function deleteChecked() {
		const newRows = [...checked].filter((r) => r >= rows.length).sort((a, b) => b - a);
		for (const r of checked) if (r < rows.length && hasKey) deleted[r] = true;
		for (const r of newRows) inserts.splice(r - rows.length, 1);
		checked.clear();
		editing = null;
	}

	function restoreChecked() {
		for (const r of checked) delete deleted[r];
		checked.clear();
	}

	async function discard() {
		if (changeCount > 3 && !(await confirmAction({ title: `Discard ${changeCount} staged changes?`, confirmLabel: 'Discard', danger: true }))) return;
		resetStaging();
	}

	/** Leaving the page of rows (sorting, paging, refreshing) would drop staged changes. */
	async function guard(): Promise<boolean> {
		if (!dirty) return true;
		const ok = await confirmAction({
			title: `Discard ${changeCount} staged change${changeCount === 1 ? '' : 's'}?`,
			body: 'Apply or discard your changes before loading other rows.',
			confirmLabel: 'Discard',
			danger: true
		});
		if (ok) resetStaging();
		return ok;
	}

	function changes(): RowChange[] {
		const index = new Map(columns.map((c, i) => [c.name, i]));
		const keyOf = (r: number) => Object.fromEntries(keyColumns.map((k) => [k, rows[r][index.get(k)!]]));
		return [
			...deletedRows.map((r): RowChange => ({ op: 'delete', key: keyOf(r) })),
			...updatedRows.map((r): RowChange => {
				const set = $state.snapshot(edits[r]);
				return { op: 'update', key: keyOf(r), set, original: Object.fromEntries(Object.keys(set).map((c) => [c, rows[r][index.get(c)!]])) };
			}),
			...inserts.map((values): RowChange => ({ op: 'insert', values: $state.snapshot(values) }))
		];
	}

	let reviewOpen = $state(false);
	let reviewing = $state(false);
	let applying = $state(false);
	let statements = $state<string[]>([]);
	let failure = $state<{ index: number | null; message: string } | null>(null);

	async function review() {
		reviewing = true;
		failure = null;
		try {
			const res = await api.post<{ statements: string[] }>(`/api/connections/${connectionId}/edit`, { schema, table, changes: changes(), dryRun: true });
			statements = res.statements;
			reviewOpen = true;
		} catch (err) {
			toast('error', 'Can’t apply these changes', errorMessage(err));
		} finally {
			reviewing = false;
		}
	}

	async function apply() {
		applying = true;
		failure = null;
		try {
			const res = await api.post<{ counts: { updated: number; inserted: number; deleted: number } }>(`/api/connections/${connectionId}/edit`, {
				schema,
				table,
				changes: changes()
			});
			const c = res.counts;
			toast('success', 'Changes saved', [c.updated && `${c.updated} updated`, c.inserted && `${c.inserted} inserted`, c.deleted && `${c.deleted} deleted`].filter(Boolean).join(', '));
			reviewOpen = false;
			resetStaging();
			await load();
		} catch (err) {
			const failed = err instanceof ApiError ? (err.detail as { failed?: { index: number } } | undefined)?.failed : undefined;
			failure = { index: failed?.index ?? null, message: errorMessage(err) };
		} finally {
			applying = false;
		}
	}

	let importOpen = $state(false);
</script>

<div class="flex h-full flex-col">
	<div class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
		<div class="relative w-64">
			<Search class="absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
			<input class="input h-7 pl-7 text-xs" placeholder="Search all columns…" bind:value={search} disabled={dirty} title={dirty ? 'Apply or discard your changes first' : undefined} />
		</div>
		<button
			class="btn btn-sm {showFilters || activeFilters.length ? 'btn-secondary text-primary' : 'btn-ghost'}"
			disabled={dirty}
			onclick={() => {
				showFilters = !showFilters;
				if (showFilters && !filters.length) filters.push({ column: columns[0]?.name ?? '', op: '=', value: '' });
			}}
		>
			<Filter />Filter{#if activeFilters.length}<span class="rounded bg-primary-soft px-1 text-[10px]">{activeFilters.length}</span>{/if}
		</button>
		{#if info && isTable}
			{#if !canWrite && info.writable}
				<span class="badge" title="Rows can be edited with write access"><Lock />Unlock writes to edit</span>
			{:else if canWrite}
				<div class="flex items-center gap-1 border-l border-border pl-2">
					<button class="btn btn-ghost btn-sm" onclick={addRow} title="Add a row"><Plus />Add row</button>
					{#if checkedRestorable}
						<button class="btn btn-ghost btn-sm" onclick={restoreChecked}><Undo2 />Restore {checkedRestorable}</button>
					{/if}
					<button class="btn btn-ghost btn-sm" disabled={!checkedDeletable} onclick={deleteChecked} title="Select rows by their number, then delete">
						<Trash2 />Delete{#if checkedDeletable}&nbsp;{checkedDeletable} row{checkedDeletable === 1 ? '' : 's'}{/if}
					</button>
					<button class="btn btn-ghost btn-sm" disabled={dirty} onclick={() => (importOpen = true)} title="Import rows from a CSV file"><FileUp />Import CSV</button>
					{#if !hasKey}
						<span class="badge badge-warning" title="Existing rows can only be edited or deleted with a primary key (or a unique key on NOT NULL columns)">No primary key — editing disabled</span>
					{:else if info.keyKind === 'unique'}
						<span class="badge" title="No primary key; rows are identified by a unique key on NOT NULL columns"><KeyRound />{info.key.join(', ')}</span>
					{/if}
				</div>
			{/if}
		{/if}
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
			<button class="btn btn-ghost btn-icon btn-sm" title="Refresh" onclick={async () => (await guard()) && load()}>
				{#if loading}<LoaderCircle class="animate-spin" />{:else}<RefreshCw />{/if}
			</button>
		</div>
	</div>

	{#if dirty}
		<div class="flex items-center gap-3 border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-xs">
			<span class="font-medium">{changeCount} staged change{changeCount === 1 ? '' : 's'}</span>
			<span class="text-muted-foreground">
				{[updatedRows.length && `${updatedRows.length} edited`, inserts.length && `${inserts.length} new`, deletedRows.length && `${deletedRows.length} to delete`].filter(Boolean).join(' · ')}
			</span>
			{#if !canWrite}<span class="text-warning">Unlock writes to apply them.</span>{/if}
			<div class="ml-auto flex items-center gap-1">
				<button class="btn btn-ghost btn-sm" onclick={discard}><RotateCcw />Discard</button>
				<button class="btn btn-primary btn-sm" disabled={reviewing || !canWrite} onclick={review}>
					{#if reviewing}<LoaderCircle class="animate-spin" />{:else}<Check />{/if}Review changes
				</button>
			</div>
		</div>
	{/if}

	{#if showFilters}
		<div class="space-y-1.5 border-b border-border bg-surface px-3 py-2">
			{#each filters as f, i (i)}
				<div class="flex items-center gap-1.5">
					<span class="w-10 text-right text-[11px] text-muted-foreground">{i === 0 ? 'where' : 'and'}</span>
					<select class="input h-7 w-44 font-mono text-xs" bind:value={f.column} disabled={dirty}>
						{#each columns as c (c.name)}<option value={c.name}>{c.name}</option>{/each}
					</select>
					<select class="input h-7 w-32 text-xs" bind:value={f.op} disabled={dirty}>
						{#each OPS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
					</select>
					{#if f.op !== 'null' && f.op !== 'notnull'}
						<input class="input h-7 w-56 font-mono text-xs" placeholder="value" bind:value={f.value} disabled={dirty} />
					{/if}
					<button class="btn btn-ghost btn-icon btn-sm" aria-label="Remove filter" disabled={dirty} onclick={() => filters.splice(i, 1)}><X /></button>
				</div>
			{/each}
			<button class="btn btn-ghost btn-sm ml-11" disabled={dirty} onclick={() => filters.push({ column: columns[0]?.name ?? '', op: '=', value: '' })}>
				<Plus />Add condition
			</button>
		</div>
	{/if}

	<div class="flex min-h-0 flex-1">
		<div class="relative min-w-0 flex-1">
			{#if error}
				<div class="m-4 rounded-lg border border-danger/30 bg-danger/5 p-3 font-mono text-xs text-danger">{error}</div>
			{:else if columns.length}
				<DataGrid
					bind:this={grid}
					{fields}
					rows={displayRows}
					{offset}
					{sort}
					onsort={dirty ? undefined : toggleSort}
					primaryKeys={pks.length ? pks : keyColumns}
					bind:selected
					rowState={canWrite || dirty ? rowState : undefined}
					cellState={canWrite || dirty ? cellState : undefined}
					onactivate={info && isTable ? activate : undefined}
					checked={canWrite ? checked : undefined}
					oncheck={canWrite ? check : undefined}
					{editing}
				>
					{#snippet editor(r, c)}
						{@const col = colMeta.get(columns[c].name)}
						{#if col}
							<CellEditor column={col} value={displayRows[r][c]} isNew={r >= rows.length} onsave={(v) => save(r, c, v)} oncancel={() => ((editing = null), grid?.focus())} />
						{/if}
					{/snippet}
				</DataGrid>
				{#if !displayRows.length && !loading}
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
		{#if canWrite && hasKey}<span class="hidden md:inline">Double-click a cell to edit · click row numbers to select</span>{/if}
		<div class="ml-auto flex items-center gap-1">
			<select class="input h-6 w-20 py-0 text-[11px]" bind:value={limit} disabled={dirty} onchange={() => (offset = 0)}>
				{#each [50, 100, 250, 500, 1000] as n (n)}<option value={n}>{n} / page</option>{/each}
			</select>
			<button class="btn btn-ghost btn-icon btn-sm" disabled={offset === 0 || dirty} onclick={() => (offset = Math.max(0, offset - limit))} aria-label="Previous page"><ChevronLeft /></button>
			<button class="btn btn-ghost btn-icon btn-sm" disabled={!hasNext || dirty} onclick={() => (offset += limit)} aria-label="Next page"><ChevronRight /></button>
		</div>
	</div>
</div>

<Dialog bind:open={reviewOpen} title="Review changes" description="These statements run in one transaction on {schema}.{table}. If any of them fails or finds the row changed since you loaded it, nothing is saved." width="max-w-3xl">
	<ol class="space-y-1.5">
		{#each statements as s, i (i)}
			<li class="rounded-lg border {failure?.index === i ? 'border-danger/50 bg-danger/5' : 'border-border bg-surface'} px-3 py-2 font-mono text-[12px] break-all whitespace-pre-wrap">
				<span class="mr-2 text-muted-foreground select-none">{i + 1}</span>{s};
			</li>
		{/each}
	</ol>
	{#if failure}
		<div class="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs text-danger">{failure.message}</div>
	{/if}
	{#snippet footer()}
		<button class="btn btn-ghost" onclick={() => (reviewOpen = false)}>Back</button>
		<button class="btn btn-primary" disabled={applying || !canWrite} onclick={apply}>
			{#if applying}<LoaderCircle class="animate-spin" />{:else}<Check />{/if}Apply {statements.length} statement{statements.length === 1 ? '' : 's'}
		</button>
	{/snippet}
</Dialog>

{#if info && canWrite}
	<ImportCsv
		bind:open={importOpen}
		{connectionId}
		{engine}
		{schema}
		{table}
		{info}
		ondone={(s, t, created) => {
			if (!created) load();
			onimported?.(s, t, created);
		}}
	/>
{/if}
