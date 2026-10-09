<script lang="ts">
	import { onMount } from 'svelte';
	import { CircleAlert, CircleCheck, Download, History, LoaderCircle, Lock, Play, PencilLine, Square, ListVideo, Trash2, Braces } from '@lucide/svelte';
	import { Bookmark, ChevronDown, Save, Workflow, Gauge } from '@lucide/svelte';
	import SqlEditor from './SqlEditor.svelte';
	import DataGrid, { type SelectedCell } from './DataGrid.svelte';
	import CellInspector from './CellInspector.svelte';
	import Dialog from './Dialog.svelte';
	import PlanView from './PlanView.svelte';
	import SavedQueries from './SavedQueries.svelte';
	import SaveQueryDialog from './SaveQueryDialog.svelte';
	import { api, ApiError, errorMessage } from '#lib/client/api.ts';
	import { ago, csv, download, duration, int } from '#lib/client/format.ts';
	import { splitRanges } from '#lib/sql-split.ts';
	import type { Engine, Flavor, HistoryEntry, QueryError, QueryResult, SavedQuery } from '#lib/types.ts';
	import { confirmAction, session } from '#lib/client/state.svelte.ts';
	import { loadSaved, saved as savedStore } from '#lib/client/saved.svelte.ts';

	type Outcome = {
		results: (QueryResult & { sql: string })[];
		error?: QueryError & { statementIndex: number; sql: string };
	};

	let {
		connectionId,
		readOnly,
		engine = 'postgres',
		flavor = null,
		defaultSchema = 'public',
		sql = $bindable(''),
		completion,
		connectionName = '',
		savedQuery = $bindable()
	}: {
		connectionId: string;
		readOnly: boolean;
		engine?: Engine;
		flavor?: Flavor | null;
		/** Unqualified table names in the editor complete from this schema. */
		defaultSchema?: string;
		sql: string;
		completion: Record<string, Record<string, string[]>>;
		connectionName?: string;
		/** The saved query this tab was opened from or saved as; Save updates it. */
		savedQuery?: { id: string; name: string } | null;
	} = $props();

	let editor: SqlEditor;
	let outcome = $state<Outcome | null>(null);
	let active = $state(0);
	let running = $state(false);
	let runId = $state<string | null>(null);
	let elapsed = $state(0);
	let selected = $state<SelectedCell | null>(null);
	let panel = $state<'history' | 'saved' | null>(null);
	let history = $state<HistoryEntry[]>([]);
	let pending = $state<string | null>(null);
	let split = $state(42);

	/** Postgres returns EXPLAIN's JSON; MySQL/MariaDB a text (or JSON text) plan with `format: 'text'`. */
	type PlanOutcome = { plan: unknown; analyzed: boolean; executedWrite: boolean; readOnly: boolean; format?: 'text' };
	let planResult = $state<PlanOutcome | null>(null);
	let planError = $state<(QueryError & { sql: string; statementIndex: number }) | null>(null);
	/** Which result area is showing: the query results or the EXPLAIN plan. */
	let view = $state<'results' | 'plan'>('results');
	let explainMenu = $state(false);
	let explainMenuEl = $state<HTMLElement>();
	let saveOpen = $state(false);
	let saveMode = $state<'save' | 'edit'>('save');
	let saveTarget = $state<SavedQuery | null>(null);

	const savedRecord = $derived(savedQuery ? (savedStore.list.find((q) => q.id === savedQuery!.id) ?? null) : null);

	const DESTRUCTIVE = /^\s*(drop|truncate)\b|^\s*(delete|update)\b(?![\s\S]*\bwhere\b)/i;

	const mysql = $derived(engine === 'mysql');
	const sqlite = $derived(engine === 'sqlite');

	function stripComments(s: string) {
		const out = s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
		return mysql ? out.replace(/#[^\n]*/g, '') : out;
	}

	function run(text: string) {
		if (!text.trim() || running) return;
		if (!readOnly && splitRanges(text, engine).some((r) => DESTRUCTIVE.test(stripComments(r.text)))) {
			pending = text;
			return;
		}
		execute(text);
	}

	async function execute(text: string, confirmed = false) {
		pending = null;
		running = true;
		selected = null;
		runId = crypto.randomUUID();
		const started = performance.now();
		const timer = setInterval(() => (elapsed = performance.now() - started), 100);
		try {
			outcome = await api.post<Outcome>(`/api/connections/${connectionId}/query`, { sql: text, runId, confirmed });
			active = Math.max(0, outcome.results.length - 1);
			view = 'results';
		} catch (err) {
			// The server's own check caught something destructive; ask, then resend confirmed.
			if (err instanceof ApiError && err.status === 409 && err.detail && 'confirm' in err.detail) pending = text;
			else outcome = { results: [], error: { message: errorMessage(err), statementIndex: 0, sql: text } };
			view = 'results';
		} finally {
			clearInterval(timer);
			running = false;
			runId = null;
			if (panel === 'history') loadHistory();
		}
	}

	/** Statements EXPLAIN ANALYZE would really execute (mirrors the server's `modifiesData`; MySQL only analyzes reads). */
	function modifiesData(text: string) {
		if (mysql || sqlite) return false;
		const s = stripComments(text).trim().toLowerCase();
		if (!/^(select|values|table|with|\()/.test(s)) return true;
		return /\b(insert|update|delete|merge)\b/.test(s) || /^select\b[^;]*?\binto\b/.test(s);
	}

	async function explain(text: string, analyze: boolean) {
		explainMenu = false;
		if (!text.trim() || running) return;
		if (analyze && !readOnly && modifiesData(text)) {
			const ok = await confirmAction({
				title: 'Explain analyze a write?',
				body: 'EXPLAIN ANALYZE really executes the statement, then rolls it back. Sequence increments and other side effects outside the transaction are not undone.',
				detail: text,
				confirmLabel: 'Execute and roll back',
				danger: true
			});
			if (!ok) return;
		}
		running = true;
		runId = crypto.randomUUID();
		const started = performance.now();
		const timer = setInterval(() => (elapsed = performance.now() - started), 100);
		try {
			planResult = await api.post<PlanOutcome>(`/api/connections/${connectionId}/explain`, { sql: text, analyze, runId });
			planError = null;
		} catch (err) {
			const detail = err instanceof ApiError ? err.detail : undefined;
			planError = { ...(detail ?? {}), message: errorMessage(err), statementIndex: 0, sql: text };
			planResult = null;
		} finally {
			clearInterval(timer);
			running = false;
			runId = null;
			view = 'plan';
			if (panel === 'history') loadHistory();
		}
	}

	function togglePanel(which: 'history' | 'saved') {
		panel = panel === which ? null : which;
		if (panel === 'history') loadHistory();
		if (panel === 'saved') loadSaved(connectionId).catch(() => {});
	}

	function openSave() {
		saveMode = 'save';
		saveTarget = savedRecord;
		saveOpen = true;
	}

	function onsaved(q: SavedQuery) {
		if (saveMode === 'save' || q.id === savedQuery?.id) savedQuery = { id: q.id, name: q.name };
	}

	function loadSavedQuery(q: SavedQuery) {
		sql = q.sql;
		savedQuery = { id: q.id, name: q.name };
		editor.focus();
	}

	async function cancel() {
		if (runId) await api.post(`/api/connections/${connectionId}/cancel`, { runId });
	}

	async function loadHistory() {
		history = await api.get<HistoryEntry[]>(`/api/connections/${connectionId}/history`);
	}

	async function clearHistory() {
		await api.del(`/api/connections/${connectionId}/history`);
		history = [];
	}

	function resizeSplit(e: PointerEvent) {
		const container = (e.currentTarget as HTMLElement).parentElement!;
		const rect = container.getBoundingClientRect();
		const move = (ev: PointerEvent) => (split = Math.min(85, Math.max(15, ((ev.clientY - rect.top) / rect.height) * 100)));
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	}

	/** Line/column of a 1-based character position inside the failed statement. */
	function errorLocation(e: QueryError & { sql: string }) {
		if (!e.position) return null;
		const before = e.sql.slice(0, e.position - 1);
		const line = before.split('\n').length;
		return { line, col: e.position - before.lastIndexOf('\n') - 1, text: e.sql.split('\n')[line - 1] };
	}

	onMount(() => editor.focus());

	const result = $derived(outcome?.results[active]);
	const fields = $derived(result?.fields.map((f) => ({ name: f.name, type: f.type })) ?? []);
</script>

<svelte:window
	onclick={(e) => explainMenu && !explainMenuEl?.contains(e.target as Node) && (explainMenu = false)}
	onkeydown={(e) => explainMenu && e.key === 'Escape' && (explainMenu = false)}
/>

<div class="flex h-full flex-col">
	<div class="flex items-center gap-2 border-b border-border px-3 py-2">
		{#if running}
			<button class="btn btn-danger btn-sm" onclick={cancel}><Square />Cancel</button>
			<span class="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums"><LoaderCircle class="size-3.5 animate-spin" />{duration(elapsed)}</span>
		{:else}
			<button class="btn btn-primary btn-sm" onclick={() => editor.runCurrent()} title="Run statement under cursor or selection"><Play />Run<span class="kbd ml-1 border-white/20 bg-white/10 text-white/80">⌘↵</span></button>
			<button class="btn btn-secondary btn-sm" onclick={() => editor.runAll()} title="Run every statement"><ListVideo />Run all<span class="kbd ml-1">⇧⌘↵</span></button>
			<div class="relative flex" bind:this={explainMenuEl}>
				<button class="btn btn-secondary btn-sm rounded-r-none" onclick={() => editor.explainCurrent(false)} title="EXPLAIN the statement under the cursor (estimates only)"><Workflow />Explain</button>
				<button
					class="btn btn-secondary btn-sm btn-icon -ml-px w-6 rounded-l-none"
					onclick={() => (explainMenu = !explainMenu)}
					aria-label="More explain options"
					aria-expanded={explainMenu}
					aria-haspopup="menu"><ChevronDown /></button
				>
				{#if explainMenu}
					<div class="absolute top-full left-0 z-30 mt-1 w-72 rounded-xl border border-border bg-card p-1 shadow-surface-lg" role="menu">
						<button class="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-accent" role="menuitem" onclick={() => editor.explainCurrent(false)}>
							<Workflow class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
							<span class="min-w-0 flex-1">
								<span class="block text-[13px] font-medium">Explain</span>
								<span class="block text-[11px] text-muted-foreground">{sqlite ? 'EXPLAIN QUERY PLAN.' : mysql ? 'The optimizer’s plan.' : 'The planner’s estimates.'} Doesn’t run the query.</span>
							</span>
						</button>
						{#if !sqlite}
						<button class="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-accent" role="menuitem" onclick={() => editor.explainCurrent(true)}>
							<Gauge class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
							<span class="min-w-0 flex-1">
								<span class="flex items-center justify-between text-[13px] font-medium">Explain analyze <span class="kbd">⌥⌘↵</span></span>
								<span class="block text-[11px] text-muted-foreground">
									{#if mysql}
										Runs the query for real timings ({flavor === 'mariadb' ? 'ANALYZE FORMAT=JSON' : 'EXPLAIN ANALYZE, MySQL 8.0.18+'}). Reads only.
									{:else}
										Runs it for real timings, then rolls back.{#if !readOnly}<span class="text-warning"> Writes are executed and undone — sequences and other side effects stay.</span>{/if}
									{/if}
								</span>
							</span>
						</button>
						{:else}
							<p class="px-2.5 py-2 text-[11px] text-muted-foreground">SQLite has no EXPLAIN ANALYZE; the plan shows which tables are scanned and which indexes are used.</p>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
		<div class="ml-auto flex items-center gap-1.5">
			{#if readOnly}
				<span class="badge badge-primary" title="Runs inside READ ONLY transaction, rolled back after"><Lock />Read-only transaction</span>
			{:else}
				<span class="badge badge-warning"><PencilLine />Writes enabled</span>
			{/if}
			<button class="btn btn-ghost btn-sm" onclick={openSave} title={savedRecord?.canEdit ? `Update “${savedRecord.name}” (⌘S)` : 'Save this query (⌘S)'}><Save />Save</button>
			<button class="btn btn-sm {panel === 'saved' ? 'btn-secondary' : 'btn-ghost'}" onclick={() => togglePanel('saved')} aria-pressed={panel === 'saved'}><Bookmark />Saved</button>
			<button class="btn btn-sm {panel === 'history' ? 'btn-secondary' : 'btn-ghost'}" onclick={() => togglePanel('history')} aria-pressed={panel === 'history'}>
				<History />History
			</button>
		</div>
	</div>

	<div class="flex min-h-0 flex-1">
		<div class="flex min-w-0 flex-1 flex-col">
			<div style="height:{split}%" class="min-h-0 bg-surface">
				<SqlEditor bind:this={editor} bind:value={sql} schema={completion} {engine} {flavor} {defaultSchema} onrun={run} onsave={openSave} onexplain={explain} />
			</div>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="h-1 shrink-0 cursor-row-resize border-y border-border bg-surface hover:bg-primary/40" onpointerdown={resizeSplit}></div>

			<div class="flex min-h-0 flex-1 flex-col">
				{#if outcome || planResult || planError}
					{#if (outcome && outcome.results.length > 1) || planResult || planError}
						<div class="flex gap-1 overflow-x-auto border-b border-border px-2 pt-1.5">
							{#if outcome && outcome.results.length > 1}
								{#each outcome.results as r, i (i)}
									<button
										class="rounded-t-md border-x border-t px-2.5 py-1 text-[11px] whitespace-nowrap {view === 'results' && active === i
											? 'border-border bg-card text-foreground'
											: 'border-transparent text-muted-foreground hover:text-foreground'}"
										onclick={() => ((active = i), (selected = null), (view = 'results'))}
									>
										{i + 1}. {r.command} <span class="opacity-60">{r.rowCount ?? r.rows.length}</span>
									</button>
								{/each}
							{:else if outcome}
								<button
									class="rounded-t-md border-x border-t px-2.5 py-1 text-[11px] whitespace-nowrap {view === 'results'
										? 'border-border bg-card text-foreground'
										: 'border-transparent text-muted-foreground hover:text-foreground'}"
									onclick={() => (view = 'results')}
								>
									Results{#if result} <span class="opacity-60">{result.rowCount ?? result.rows.length}</span>{/if}
								</button>
							{/if}
							{#if planResult || planError}
								<button
									class="flex items-center gap-1 rounded-t-md border-x border-t px-2.5 py-1 text-[11px] whitespace-nowrap {view === 'plan'
										? 'border-border bg-card text-foreground'
										: 'border-transparent text-muted-foreground hover:text-foreground'}"
									onclick={() => (view = 'plan')}
								>
									<Workflow class="size-3" />Plan{#if planResult?.analyzed} <span class="opacity-60">analyze</span>{/if}{#if planError} <span class="text-danger">error</span>{/if}
								</button>
							{/if}
						</div>
					{/if}

					{#if view === 'plan' && (planResult || planError)}
						{#if planResult?.format === 'text'}
							<div class="min-h-0 flex-1 overflow-auto">
								<div class="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
									<Workflow class="size-3.5" />{planResult.analyzed ? 'Measured plan' : 'Estimated plan'}
									<span class="flex items-center gap-1"><Lock class="size-3" />read-only</span>
								</div>
								<pre class="p-4 font-mono text-[12px] leading-relaxed whitespace-pre">{String(planResult.plan)}</pre>
							</div>
						{:else if planResult}
							<div class="min-h-0 flex-1"><PlanView plan={planResult.plan} executedWrite={planResult.executedWrite} readOnly={planResult.readOnly} /></div>
						{:else if planError}
							{@render queryError(planError, false)}
						{/if}
					{:else if outcome}
						{#if outcome.error && (!result || active === outcome.results.length - 1)}
							{@render queryError(outcome.error, true)}
						{/if}

						{#if result}
							{#if result.fields.length}
								<div class="flex min-h-0 flex-1">
									<div class="min-w-0 flex-1"><DataGrid {fields} rows={result.rows} bind:selected /></div>
									<CellInspector bind:cell={selected} />
								</div>
							{:else if !outcome.error}
								<div class="m-3 flex items-center gap-2.5 rounded-xl border border-success/30 bg-success/5 p-4 text-[13px]">
									<CircleCheck class="size-4 text-success" />
									<span><b class="font-medium">{result.command}</b>{#if result.rowCount != null} · {int(result.rowCount)} row{result.rowCount === 1 ? '' : 's'} affected{/if}</span>
								</div>
							{/if}
							<div class="mt-auto flex items-center gap-3 border-t border-border bg-surface px-3 py-1.5 text-[11px] text-muted-foreground">
								<span class="font-medium text-foreground">{result.command}</span>
								<span class="tabular-nums">{int(result.rows.length)} row{result.rows.length === 1 ? '' : 's'}</span>
								<span class="tabular-nums">{duration(result.durationMs)}</span>
								{#if result.truncated}<span class="badge badge-warning">truncated — add a LIMIT</span>{/if}
								{#if result.readOnly}<span class="flex items-center gap-1"><Lock class="size-3" />rolled back</span>{/if}
								{#if result.fields.length}
									<div class="ml-auto flex gap-1">
										<button class="btn btn-ghost btn-sm" onclick={() => download('result.csv', csv(fields.map((f) => f.name), result.rows), 'text/csv')}><Download />CSV</button>
										<button
											class="btn btn-ghost btn-sm"
											onclick={() =>
												download(
													'result.json',
													JSON.stringify(result.rows.map((r) => Object.fromEntries(fields.map((f, i) => [f.name, r[i]]))), null, 2),
													'application/json'
												)}><Braces />JSON</button
										>
									</div>
								{/if}
							</div>
						{/if}
					{/if}
				{:else}
					<div class="grid flex-1 place-items-center text-center text-xs text-muted-foreground">
						<div>
							<p>Run a query to see results.</p>
							{#if sqlite}<p class="mt-1">{readOnly ? 'Read-only: SELECT, VALUES, EXPLAIN and read-only PRAGMAs run here, inside a transaction that is rolled back.' : 'Statements change the file directly; an unfinished BEGIN is rolled back.'}</p>{/if}
							{#if mysql}<p class="mt-1">{readOnly ? 'Read-only: SELECT, SHOW, DESCRIBE and EXPLAIN run here.' : 'Statements run one at a time; DELIMITER blocks are supported.'}</p>{/if}
							<p class="mt-2"><span class="kbd">⌘↵</span> statement · <span class="kbd">⇧⌘↵</span> everything · <span class="kbd">⌥⌘↵</span> explain analyze · <span class="kbd">⌘S</span> save · <span class="kbd">⌃Space</span> complete</p>
						</div>
					</div>
				{/if}
			</div>
		</div>

		{#if panel === 'saved'}
			<aside class="flex w-80 shrink-0 flex-col border-l border-border bg-surface">
				<div class="flex items-center justify-between border-b border-border px-3 py-2">
					<span class="text-[13px] font-semibold">Saved queries</span>
					<button class="btn btn-ghost btn-sm" title="Save the editor's query (⌘S)" onclick={openSave}><Save />Save</button>
				</div>
				<div class="min-h-0 flex-1">
					<SavedQueries
						activeId={savedQuery?.id ?? null}
						onload={loadSavedQuery}
						onrun={(q) => (loadSavedQuery(q), run(q.sql))}
						onedit={(q) => ((saveMode = 'edit'), (saveTarget = q), (saveOpen = true))}
					/>
				</div>
			</aside>
		{/if}
		{#if panel === 'history'}
			<aside class="flex w-80 shrink-0 flex-col border-l border-border bg-surface">
				<div class="flex items-center justify-between border-b border-border px-3 py-2">
					<span class="text-[13px] font-semibold">History</span>
					<button class="btn btn-ghost btn-icon btn-sm" title="Clear history" onclick={clearHistory}><Trash2 /></button>
				</div>
				<div class="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
					{#each history as h (h.id)}
						<button class="block w-full px-3 py-2 text-left hover:bg-accent/50" onclick={() => (sql = h.sql)}>
							<pre class="line-clamp-3 font-mono text-[11px] whitespace-pre-wrap {h.ok ? '' : 'text-danger'}">{h.sql}</pre>
							<p class="mt-1 text-[10px] text-muted-foreground">
								{#if h.userEmail && h.userEmail !== session.viewer?.email}<span class="text-foreground/80">{h.userEmail}</span> · {/if}{#if !h.readOnly}<span class="text-warning">write</span> · {/if}{ago(h.createdAt)} · {duration(h.durationMs)}{#if h.rowCount != null} · {h.rowCount} rows{/if}
							</p>
						</button>
					{:else}
						<p class="p-4 text-center text-xs text-muted-foreground">Nothing yet</p>
					{/each}
				</div>
			</aside>
		{/if}
	</div>
</div>

{#snippet queryError(e: QueryError & { sql: string; statementIndex: number }, showStatement: boolean)}
	{@const loc = errorLocation(e)}
	<div class="m-3 rounded-xl border border-danger/30 bg-danger/5 p-4">
		<div class="flex items-start gap-2.5">
			<CircleAlert class="mt-0.5 size-4 shrink-0 text-danger" />
			<div class="min-w-0 flex-1">
				<p class="text-[13px] font-medium">{e.message}</p>
				<p class="mt-1 font-mono text-[11px] text-muted-foreground">
					{[e.sqlState ? `SQLSTATE ${e.sqlState}` : e.code && `SQLSTATE ${e.code}`, e.sqlState && e.code, showStatement && `statement ${e.statementIndex + 1}`, loc && `line ${loc.line}, col ${loc.col}`]
						.filter(Boolean)
						.join(' · ')}
				</p>
				{#if loc}
					<pre class="mt-2 overflow-x-auto rounded-md bg-background/60 p-2 font-mono text-[11px]">{loc.text}
{' '.repeat(Math.max(0, loc.col - 1))}<span class="text-danger">^</span></pre>
				{/if}
				{#if e.detail}<p class="mt-2 text-xs text-muted-foreground"><b class="font-medium text-foreground">Detail:</b> {e.detail}</p>{/if}
				{#if e.hint}<p class="mt-1 text-xs text-muted-foreground"><b class="font-medium text-foreground">Hint:</b> {e.hint}</p>{/if}
			</div>
		</div>
	</div>
{/snippet}

<SaveQueryDialog
	bind:open={saveOpen}
	{connectionId}
	{connectionName}
	{sql}
	existing={saveTarget}
	mode={saveMode}
	{onsaved}
/>

<Dialog bind:open={() => pending !== null, (v) => !v && (pending = null)} title="Run destructive statement?" description="You have write access here. Dropping, truncating, or changing every row can't be undone.">
	<pre class="max-h-48 overflow-auto rounded-lg border border-border bg-surface p-3 font-mono text-xs">{pending}</pre>
	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (pending = null)}>Cancel</button>
		<button class="btn btn-danger" onclick={() => pending && execute(pending, true)}>Run it</button>
	{/snippet}
</Dialog>
