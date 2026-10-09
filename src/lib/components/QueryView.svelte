<script lang="ts">
	import { onMount } from 'svelte';
	import { CircleAlert, CircleCheck, Download, History, LoaderCircle, Lock, Play, PencilLine, Square, ListVideo, Trash2, Braces } from '@lucide/svelte';
	import SqlEditor from './SqlEditor.svelte';
	import DataGrid, { type SelectedCell } from './DataGrid.svelte';
	import CellInspector from './CellInspector.svelte';
	import Dialog from './Dialog.svelte';
	import { api, ApiError, errorMessage } from '#lib/client/api.ts';
	import { ago, csv, download, duration, int } from '#lib/client/format.ts';
	import { splitRanges } from '#lib/sql-split.ts';
	import type { HistoryEntry, QueryError, QueryResult } from '#lib/types.ts';
	import { session } from '#lib/client/state.svelte.ts';

	type Outcome = {
		results: (QueryResult & { sql: string })[];
		error?: QueryError & { statementIndex: number; sql: string };
	};

	let {
		connectionId,
		readOnly,
		sql = $bindable(''),
		completion
	}: {
		connectionId: string;
		readOnly: boolean;
		sql: string;
		completion: Record<string, Record<string, string[]>>;
	} = $props();

	let editor: SqlEditor;
	let outcome = $state<Outcome | null>(null);
	let active = $state(0);
	let running = $state(false);
	let runId = $state<string | null>(null);
	let elapsed = $state(0);
	let selected = $state<SelectedCell | null>(null);
	let showHistory = $state(false);
	let history = $state<HistoryEntry[]>([]);
	let pending = $state<string | null>(null);
	let split = $state(42);

	const DESTRUCTIVE = /^\s*(drop|truncate)\b|^\s*(delete|update)\b(?![\s\S]*\bwhere\b)/i;

	function stripComments(s: string) {
		return s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
	}

	function run(text: string) {
		if (!text.trim() || running) return;
		if (!readOnly && splitRanges(text).some((r) => DESTRUCTIVE.test(stripComments(r.text)))) {
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
		} catch (err) {
			// The server's own check caught something destructive; ask, then resend confirmed.
			if (err instanceof ApiError && err.status === 409 && err.detail && 'confirm' in err.detail) pending = text;
			else outcome = { results: [], error: { message: errorMessage(err), statementIndex: 0, sql: text } };
		} finally {
			clearInterval(timer);
			running = false;
			runId = null;
			if (showHistory) loadHistory();
		}
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

<div class="flex h-full flex-col">
	<div class="flex items-center gap-2 border-b border-border px-3 py-2">
		{#if running}
			<button class="btn btn-danger btn-sm" onclick={cancel}><Square />Cancel</button>
			<span class="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums"><LoaderCircle class="size-3.5 animate-spin" />{duration(elapsed)}</span>
		{:else}
			<button class="btn btn-primary btn-sm" onclick={() => editor.runCurrent()} title="Run statement under cursor or selection"><Play />Run<span class="kbd ml-1 border-white/20 bg-white/10 text-white/80">⌘↵</span></button>
			<button class="btn btn-secondary btn-sm" onclick={() => editor.runAll()} title="Run every statement"><ListVideo />Run all<span class="kbd ml-1">⇧⌘↵</span></button>
		{/if}
		<div class="ml-auto flex items-center gap-1.5">
			{#if readOnly}
				<span class="badge badge-primary" title="Runs inside READ ONLY transaction, rolled back after"><Lock />Read-only transaction</span>
			{:else}
				<span class="badge badge-warning"><PencilLine />Writes enabled</span>
			{/if}
			<button
				class="btn btn-sm {showHistory ? 'btn-secondary' : 'btn-ghost'}"
				onclick={() => {
					showHistory = !showHistory;
					if (showHistory) loadHistory();
				}}
			>
				<History />History
			</button>
		</div>
	</div>

	<div class="flex min-h-0 flex-1">
		<div class="flex min-w-0 flex-1 flex-col">
			<div style="height:{split}%" class="min-h-0 bg-surface">
				<SqlEditor bind:this={editor} bind:value={sql} schema={completion} onrun={run} />
			</div>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="h-1 shrink-0 cursor-row-resize border-y border-border bg-surface hover:bg-primary/40" onpointerdown={resizeSplit}></div>

			<div class="flex min-h-0 flex-1 flex-col">
				{#if outcome}
					{#if outcome.results.length > 1}
						<div class="flex gap-1 overflow-x-auto border-b border-border px-2 pt-1.5">
							{#each outcome.results as r, i (i)}
								<button
									class="rounded-t-md border-x border-t px-2.5 py-1 text-[11px] whitespace-nowrap {active === i
										? 'border-border bg-card text-foreground'
										: 'border-transparent text-muted-foreground hover:text-foreground'}"
									onclick={() => ((active = i), (selected = null))}
								>
									{i + 1}. {r.command} <span class="opacity-60">{r.rowCount ?? r.rows.length}</span>
								</button>
							{/each}
						</div>
					{/if}

					{#if outcome.error && (!result || active === outcome.results.length - 1)}
						{@const loc = errorLocation(outcome.error)}
						<div class="m-3 rounded-xl border border-danger/30 bg-danger/5 p-4">
							<div class="flex items-start gap-2.5">
								<CircleAlert class="mt-0.5 size-4 shrink-0 text-danger" />
								<div class="min-w-0 flex-1">
									<p class="text-[13px] font-medium">{outcome.error.message}</p>
									<p class="mt-1 font-mono text-[11px] text-muted-foreground">
										{[
											outcome.error.code && `SQLSTATE ${outcome.error.code}`,
											`statement ${outcome.error.statementIndex + 1}`,
											loc && `line ${loc.line}, col ${loc.col}`
										]
											.filter(Boolean)
											.join(' · ')}
									</p>
									{#if loc}
										<pre class="mt-2 overflow-x-auto rounded-md bg-background/60 p-2 font-mono text-[11px]">{loc.text}
{' '.repeat(Math.max(0, loc.col - 1))}<span class="text-danger">^</span></pre>
									{/if}
									{#if outcome.error.detail}<p class="mt-2 text-xs text-muted-foreground"><b class="font-medium text-foreground">Detail:</b> {outcome.error.detail}</p>{/if}
									{#if outcome.error.hint}<p class="mt-1 text-xs text-muted-foreground"><b class="font-medium text-foreground">Hint:</b> {outcome.error.hint}</p>{/if}
								</div>
							</div>
						</div>
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
				{:else}
					<div class="grid flex-1 place-items-center text-center text-xs text-muted-foreground">
						<div>
							<p>Run a query to see results.</p>
							<p class="mt-2"><span class="kbd">⌘↵</span> statement · <span class="kbd">⇧⌘↵</span> everything · <span class="kbd">⌃Space</span> complete</p>
						</div>
					</div>
				{/if}
			</div>
		</div>

		{#if showHistory}
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

<Dialog bind:open={() => pending !== null, (v) => !v && (pending = null)} title="Run destructive statement?" description="You have write access here. Dropping, truncating, or changing every row can't be undone.">
	<pre class="max-h-48 overflow-auto rounded-lg border border-border bg-surface p-3 font-mono text-xs">{pending}</pre>
	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (pending = null)}>Cancel</button>
		<button class="btn btn-danger" onclick={() => pending && execute(pending, true)}>Run it</button>
	{/snippet}
</Dialog>
