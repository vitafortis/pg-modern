<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, Braces, Flame, TriangleAlert, Lock, Undo2 } from '@lucide/svelte';
	import { int } from '#lib/client/format.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import { parsePlan, planText, visibleNodes, type PlanNode, type PlanSummary } from '#lib/plan.ts';

	let {
		plan,
		executedWrite = false,
		readOnly = true
	}: {
		/** EXPLAIN (FORMAT JSON) output. */
		plan: unknown;
		/** ANALYZE executed a write, which was rolled back. */
		executedWrite?: boolean;
		readOnly?: boolean;
	} = $props();

	const parsed = $derived.by((): { summary: PlanSummary; error: null } | { summary: null; error: string } => {
		try {
			return { summary: parsePlan(plan), error: null };
		} catch (err) {
			return { summary: null, error: err instanceof Error ? err.message : String(err) };
		}
	});
	const summary = $derived(parsed.summary);

	const collapsed = new SvelteSet<number>();
	let raw = $state(false);
	let showOutput = $state(false);

	// A new plan starts fully expanded.
	$effect(() => {
		void plan;
		collapsed.clear();
		raw = false;
	});

	const rows = $derived(summary ? visibleNodes(summary, collapsed) : []);
	const json = $derived(JSON.stringify(plan, null, 2));

	function toggle(n: PlanNode) {
		if (collapsed.has(n.id)) collapsed.delete(n.id);
		else collapsed.add(n.id);
	}

	function collapseAll() {
		for (const n of summary?.nodes ?? []) if (n.children.length && n.depth > 0) collapsed.add(n.id);
	}

	async function copy(text: string, what: string) {
		try {
			await navigator.clipboard.writeText(text);
			toast('success', `Copied ${what}`);
		} catch {
			toast('error', 'Could not copy to the clipboard');
		}
	}

	function ms(v: number | null | undefined): string {
		if (v == null) return '—';
		if (v === 0) return '0 ms';
		if (v < 1) return `${v.toFixed(3)} ms`;
		if (v < 100) return `${v.toFixed(2)} ms`;
		if (v < 10_000) return `${v.toFixed(1)} ms`;
		return `${(v / 1000).toFixed(2)} s`;
	}

	function cost(v: number): string {
		if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
		if (v >= 10_000) return `${(v / 1000).toFixed(1)}k`;
		return v.toFixed(2);
	}

	const rowsLabel = (v: number | null) => (v == null ? '—' : int(Math.round(v)));
	const pct = (v: number) => (v >= 0.1 ? `${Math.round(v * 100)}%` : v > 0 ? `${(v * 100).toFixed(1)}%` : '0%');

	const grid = $derived(
		summary?.analyzed
			? 'grid-template-columns: minmax(260px, 1fr) 112px 48px 104px 76px 148px'
			: 'grid-template-columns: minmax(260px, 1fr) 80px 112px 148px'
	);
</script>

<div class="flex h-full min-h-0 flex-col">
	{#if parsed.error}
		<div class="m-3 rounded-xl border border-danger/30 bg-danger/5 p-4 text-[13px]">Couldn’t read this plan: {parsed.error}</div>
	{:else if summary}
		<!-- Summary -->
		<div class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface px-3 py-2">
			<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
				<span class="badge {summary.analyzed ? 'badge-primary' : ''}">{summary.analyzed ? 'EXPLAIN ANALYZE' : 'EXPLAIN'}</span>
				{#if summary.planningMs != null}<span>Planning <b class="font-medium text-foreground tabular-nums">{ms(summary.planningMs)}</b></span>{/if}
				{#if summary.executionMs != null}<span>Execution <b class="font-medium text-foreground tabular-nums">{ms(summary.executionMs)}</b></span>{/if}
				<span>{summary.analyzed ? 'Rows' : 'Est. rows'} <b class="font-medium text-foreground tabular-nums">{int(summary.totalRows)}</b></span>
				<span>Cost <b class="font-medium text-foreground tabular-nums">{cost(summary.totalCost)}</b></span>
				<span>Nodes <b class="font-medium text-foreground tabular-nums">{summary.nodes.length}</b></span>
				{#if summary.misestimates}
					<span class="flex items-center gap-1 text-warning" title="Row estimates off by 10× or more — stale statistics or correlated columns">
						<TriangleAlert class="size-3" />{summary.misestimates} misestimate{summary.misestimates === 1 ? '' : 's'}
					</span>
				{/if}
				{#each summary.triggers as t (t.name + t.relation)}
					<span title="Trigger time">Trigger <b class="font-mono font-medium text-foreground">{t.name}</b>{t.relation ? ` on ${t.relation}` : ''}: <b class="font-medium text-foreground tabular-nums">{ms(t.ms)}</b>{t.calls != null ? ` × ${int(t.calls)}` : ''}</span>
				{/each}
				{#if summary.jit}
					<span title="Just-in-time compilation">JIT <b class="font-medium text-foreground tabular-nums">{ms(summary.jit.totalMs)}</b>{summary.jit.functions != null ? ` · ${summary.jit.functions} functions` : ''}</span>
				{/if}
				{#if Object.keys(summary.settings).length}
					<span class="font-mono text-[10.5px]" title="Planner settings that differ from the defaults">
						{Object.entries(summary.settings)
							.map(([k, v]) => `${k}=${v}`)
							.join(' · ')}
					</span>
				{/if}
			</div>
			<div class="ml-auto flex items-center gap-1">
				{#if !raw}
					<label class="mr-1 flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground select-none" title="Show each node's output columns (VERBOSE)">
						<input type="checkbox" class="accent-primary" bind:checked={showOutput} />Output
					</label>
					{#if collapsed.size}
						<button class="btn btn-ghost btn-sm" onclick={() => collapsed.clear()} title="Expand all"><ChevronsUpDown />Expand</button>
					{:else}
						<button class="btn btn-ghost btn-sm" onclick={collapseAll} title="Collapse all"><ChevronsDownUp />Collapse</button>
					{/if}
				{/if}
				<button class="btn btn-sm {raw ? 'btn-secondary' : 'btn-ghost'}" onclick={() => (raw = !raw)} aria-pressed={raw}><Braces />Raw JSON</button>
				<button class="btn btn-ghost btn-sm" onclick={() => copy(json, 'plan JSON')} title="Copy the plan as JSON (paste into explain.dalibo.com and friends)"><Copy />Copy plan</button>
				<button class="btn btn-ghost btn-sm" onclick={() => copy(planText(summary!), 'plan as text')} title="Copy the plan as text">Text</button>
			</div>
		</div>

		{#if executedWrite}
			<div class="flex items-start gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-[12px]">
				<Undo2 class="mt-0.5 size-3.5 shrink-0 text-warning" />
				<p>
					<b class="font-medium">EXPLAIN ANALYZE executed this statement, then rolled it back.</b>
					<span class="text-muted-foreground">Effects outside the transaction — sequence increments, NOTIFY, dblink or other external calls — are not undone.</span>
				</p>
			</div>
		{/if}

		{#if raw}
			<pre class="min-h-0 flex-1 overflow-auto bg-surface/40 p-3 font-mono text-[11.5px] leading-relaxed">{json}</pre>
		{:else}
			<div class="min-h-0 flex-1 overflow-auto">
				<div class="min-w-fit text-[12px]">
					<div class="sticky top-0 z-10 grid border-b border-border bg-surface/95 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase backdrop-blur" style={grid}>
						<div class="px-3 py-1.5">Node</div>
						{#if summary.analyzed}
							<div class="px-2 py-1.5 text-right" title="Estimated → actual rows per loop">Rows est → act</div>
							<div class="px-2 py-1.5 text-right">Loops</div>
							<div class="px-2 py-1.5 text-right" title="Startup .. total cost">Cost</div>
							<div class="px-2 py-1.5 text-right" title="Actual total time over all loops, including children">Time</div>
							<div class="px-3 py-1.5" title="Time in this node alone (node time × loops minus children), as a share of the total">Self time</div>
						{:else}
							<div class="px-2 py-1.5 text-right">Est. rows</div>
							<div class="px-2 py-1.5 text-right" title="Startup .. total cost">Cost</div>
							<div class="px-3 py-1.5" title="This node's own cost (total minus children), as a share of the total">Self cost</div>
						{/if}
					</div>

					{#each rows as n (n.id)}
						{@const open = !collapsed.has(n.id)}
						<div class="grid border-b border-border/70 hover:bg-accent/30 {n.slowest ? 'bg-warning/5' : ''}" style={grid}>
							<!-- Node -->
							<div class="relative min-w-0 py-1.5 pr-3" style="padding-left:{12 + n.depth * 18}px">
								{#each { length: n.depth } as _, d (d)}
									<span class="absolute inset-y-0 w-px bg-border" style="left:{19 + d * 18}px"></span>
								{/each}
								{#if n.slowest}<span class="absolute inset-y-0 left-0 w-0.5 bg-warning"></span>{/if}
								<div class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
									{#if n.children.length}
										<button class="-ml-0.5 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" onclick={() => toggle(n)} aria-label={open ? 'Collapse' : 'Expand'} aria-expanded={open}>
											{#if open}<ChevronDown class="size-3.5" />{:else}<ChevronRight class="size-3.5" />{/if}
										</button>
									{:else}
										<span class="ml-1 size-1.5 shrink-0 rounded-full bg-muted-foreground/40" style="margin-right:5px"></span>
									{/if}
									{#if n.subplanName}<span class="badge shrink-0">{n.subplanName}</span>{:else if n.relationship && !['Outer', 'Inner', 'Member'].includes(n.relationship)}<span class="badge shrink-0">{n.relationship}</span>{/if}
									<span class="shrink-0 font-semibold {n.neverExecuted ? 'text-muted-foreground' : ''}">{n.nodeType}</span>
									{#if n.target}<span class="min-w-0 font-mono text-[11.5px] break-all text-primary">{n.target}</span>{/if}
									{#each n.tags as tag (tag)}<span class="badge shrink-0">{tag}</span>{/each}
									{#if n.slowest}<span class="badge badge-warning shrink-0"><Flame />{summary.analyzed ? 'slowest' : 'costliest'}</span>{/if}
									{#if n.neverExecuted}<span class="badge shrink-0">never executed</span>{/if}
									{#if !open}<span class="text-[11px] text-muted-foreground">+{n.children.length} hidden</span>{/if}
								</div>
								{#if n.details.length || n.rowsRemovedByFilter || n.rowsRemovedByJoinFilter || n.rowsRemovedByRecheck || n.notes.length || (summary.analyzed && n.sharedHit != null)}
									<div class="mt-0.5 space-y-px pl-5 font-mono text-[11px] leading-snug text-muted-foreground">
										{#each n.details as d (d.label)}
											{#if d.label !== 'Output' || showOutput}
												<p class="break-words"><span class="text-foreground/70">{d.label}:</span> {d.value}</p>
											{/if}
										{/each}
										{#if n.rowsRemovedByFilter}<p><span class="text-foreground/70">Rows removed by filter:</span> {int(n.rowsRemovedByFilter)}</p>{/if}
										{#if n.rowsRemovedByJoinFilter}<p><span class="text-foreground/70">Rows removed by join filter:</span> {int(n.rowsRemovedByJoinFilter)}</p>{/if}
										{#if n.rowsRemovedByRecheck}<p><span class="text-foreground/70">Rows removed by recheck:</span> {int(n.rowsRemovedByRecheck)}</p>{/if}
										{#if summary.analyzed && n.sharedHit != null && (n.sharedHit || n.sharedRead)}
											<p><span class="text-foreground/70">Buffers:</span> shared hit {int(n.sharedHit)}{n.sharedRead ? ` · read ${int(n.sharedRead)}` : ''}</p>
										{/if}
										{#if n.notes.length}<p class="font-sans text-[10.5px]">{n.notes.join(' · ')}</p>{/if}
									</div>
								{/if}
							</div>

							{#if summary.analyzed}
								<div class="px-2 py-1.5 text-right tabular-nums">
									{#if n.neverExecuted}
										<span class="text-muted-foreground">{rowsLabel(n.planRows)} → —</span>
									{:else}
										<span class="text-muted-foreground">{rowsLabel(n.planRows)} →</span>
										<span class={n.misestimated ? 'font-semibold text-warning' : ''}>{rowsLabel(n.actualRows)}</span>
										{#if n.misestimated}
											<span
												class="mt-0.5 ml-auto flex w-fit items-center gap-0.5 rounded bg-warning/15 px-1 text-[10px] font-medium text-warning"
												title="The planner {n.estimateDirection === 'under' ? 'underestimated' : 'overestimated'} rows {Math.round(n.estimateFactor ?? 0)}× — check statistics (ANALYZE) or correlated columns"
											>
												<TriangleAlert class="size-2.5" />{n.estimateDirection === 'under' ? '↑' : '↓'}{n.estimateFactor! >= 100 ? int(Math.round(n.estimateFactor!)) : n.estimateFactor!.toFixed(n.estimateFactor! < 20 ? 1 : 0)}×
											</span>
										{/if}
									{/if}
								</div>
								<div class="px-2 py-1.5 text-right text-muted-foreground tabular-nums">{n.loops != null ? int(n.loops) : '—'}</div>
								<div class="px-2 py-1.5 text-right font-mono text-[11px] text-muted-foreground tabular-nums" title="startup {n.startupCost} · total {n.totalCost}">{cost(n.startupCost)}<span class="opacity-50">..</span>{cost(n.totalCost)}</div>
								<div class="px-2 py-1.5 text-right tabular-nums">{ms(n.inclusiveMs)}</div>
								<div class="px-3 py-1.5">
									<div class="flex items-baseline justify-between gap-2 tabular-nums">
										<span class={n.slowest ? 'font-semibold text-warning' : ''}>{ms(n.exclusiveMs)}</span>
										<span class="text-[10.5px] text-muted-foreground">{pct(n.share)}</span>
									</div>
									<div class="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" title="{pct(n.share)} of total self time">
										<div class="h-full rounded-full {n.slowest ? 'bg-warning' : 'bg-primary/70'}" style="width:{Math.max(n.share > 0 ? 1.5 : 0, n.share * 100)}%"></div>
									</div>
								</div>
							{:else}
								<div class="px-2 py-1.5 text-right tabular-nums">{rowsLabel(n.planRows)}</div>
								<div class="px-2 py-1.5 text-right font-mono text-[11px] text-muted-foreground tabular-nums">{cost(n.startupCost)}<span class="opacity-50">..</span>{cost(n.totalCost)}</div>
								<div class="px-3 py-1.5">
									<div class="flex items-baseline justify-between gap-2 tabular-nums">
										<span class={n.slowest ? 'font-semibold text-warning' : ''}>{cost(n.exclusiveCost)}</span>
										<span class="text-[10.5px] text-muted-foreground">{pct(n.share)}</span>
									</div>
									<div class="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" title="{pct(n.share)} of total cost">
										<div class="h-full rounded-full {n.slowest ? 'bg-warning' : 'bg-primary/70'}" style="width:{Math.max(n.share > 0 ? 1.5 : 0, n.share * 100)}%"></div>
									</div>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<div class="flex min-w-0 items-center gap-3 border-t border-border bg-surface px-3 py-1.5 text-[11px] whitespace-nowrap text-muted-foreground">
			<span class="font-medium text-foreground">EXPLAIN</span>
			{#if summary.analyzed}
				<span class="truncate">Self time = node time × loops − children{summary.nodes.some((n) => n.notes.some((x) => x.includes('workers'))) ? ' (parallel workers averaged)' : ''}</span>
			{:else}
				<span class="truncate">Estimates only — Explain analyze runs the statement for real timings</span>
			{/if}
			<span class="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap"><Lock class="size-3" />{readOnly ? 'read-only transaction, rolled back' : 'rolled back'}</span>
		</div>
	{/if}
</div>
