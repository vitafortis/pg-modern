<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		ChevronRight,
		CircleCheck,
		CircleMinus,
		Copy,
		HeartPulse,
		Info,
		LoaderCircle,
		OctagonAlert,
		RefreshCw,
		SquareTerminal,
		TriangleAlert
	} from '@lucide/svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { ago, duration } from '#lib/client/format.ts';
	import { copyText } from '#lib/client/clipboard.ts';
	import { checkInfo, checkSeverity, sortChecks, summarizeHealth, type CheckResult, type HealthReport, type Severity } from '#lib/health.ts';

	let {
		connectionId,
		active = true,
		onquery
	}: { connectionId: string; active?: boolean; onquery?: (sql: string) => void } = $props();

	let report = $state<HealthReport | null>(null);
	let error = $state('');
	let loading = $state(false);
	let filter = $state<Severity | 'all'>('all');
	const expanded = new SvelteSet<string>();
	let started = false;
	let now = $state(Date.now());

	async function run() {
		loading = true;
		error = '';
		try {
			report = await api.get<HealthReport>(`/api/connections/${connectionId}/health`);
			expanded.clear();
			// Open the checks that found something serious; passing ones stay folded.
			for (const c of report.checks) {
				const sev = checkSeverity(c);
				if (c.status === 'error' || sev === 'critical' || sev === 'warn') expanded.add(c.id);
			}
		} catch (err) {
			error = errorMessage(err);
		} finally {
			loading = false;
		}
	}

	// Run the first time the tab is shown, not when it's restored in the background.
	$effect(() => {
		if (active && !started) {
			started = true;
			untrack(run);
		}
	});

	$effect(() => {
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});

	const ranAgo = $derived(report ? (void now, ago(report.ranAt)) : '');
	const summary = $derived(report ? summarizeHealth(report.checks) : null);
	const sorted = $derived(report ? sortChecks(report.checks) : []);
	const withFindings = $derived(sorted.filter((c) => c.status === 'findings' || c.status === 'error'));
	const quiet = $derived(sorted.filter((c) => c.status === 'ok' || c.status === 'skipped'));
	const visibleChecks = $derived(filter === 'all' ? withFindings : withFindings.filter((c) => c.findings.some((f) => f.severity === filter)));

	const SEV = {
		critical: { label: 'Critical', badge: 'badge-danger', text: 'text-danger', icon: OctagonAlert },
		warn: { label: 'Warning', badge: 'badge-warning', text: 'text-warning', icon: TriangleAlert },
		info: { label: 'Info', badge: 'badge-primary', text: 'text-primary', icon: Info }
	} as const;

	const ENGINE_LABEL = { postgres: 'Postgres', mysql: 'MySQL · MariaDB' } as const;

	function appliesTo(id: string) {
		return (checkInfo(id)?.engines ?? []).map((e) => ENGINE_LABEL[e]).join(' · ');
	}

	function toggle(id: string) {
		if (expanded.has(id)) expanded.delete(id);
		else expanded.add(id);
	}

	function countOf(c: CheckResult, s: Severity) {
		return c.findings.filter((f) => f.severity === s).length;
	}
</script>

{#snippet statusIcon(c: CheckResult)}
	{@const sev = checkSeverity(c)}
	{#if c.status === 'error'}
		<TriangleAlert class="size-4 shrink-0 text-danger" />
	{:else if c.status === 'skipped'}
		<CircleMinus class="size-4 shrink-0 text-muted-foreground" />
	{:else if sev}
		{@const S = SEV[sev]}
		<S.icon class="size-4 shrink-0 {S.text}" />
	{:else}
		<CircleCheck class="size-4 shrink-0 text-success" />
	{/if}
{/snippet}

<div class="h-full overflow-y-auto">
	<div class="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-background/85 px-5 py-2 backdrop-blur">
		<h2 class="flex items-center gap-2 text-[13px] font-semibold"><HeartPulse class="size-4 text-primary" />Health</h2>
		<span class="text-[11px] text-muted-foreground">Read-only checks · suggested fixes are never run for you</span>
		<div class="ml-auto flex items-center gap-2">
			{#if report}
				<span class="text-[11px] text-muted-foreground tabular-nums">Checked {ranAgo} · {duration(report.durationMs)}</span>
			{/if}
			<button class="btn btn-secondary btn-sm" onclick={run} disabled={loading}>
				<RefreshCw class={loading ? 'animate-spin' : ''} />{loading ? 'Running…' : 'Re-run'}
			</button>
		</div>
	</div>

	{#if !report && error}
		<div class="m-5 rounded-xl border border-danger/30 bg-danger/5 p-4">
			<p class="text-[13px] font-medium">Could not run the health checks</p>
			<p class="mt-1 font-mono text-xs text-muted-foreground">{error}</p>
			<button class="btn btn-secondary btn-sm mt-3" onclick={run}><RefreshCw />Try again</button>
		</div>
	{:else if !report || !summary}
		<div class="grid h-60 place-items-center text-center">
			<div>
				<LoaderCircle class="mx-auto size-5 animate-spin text-muted-foreground" />
				<p class="mt-2 text-xs text-muted-foreground">Running checks…</p>
			</div>
		</div>
	{:else}
		<div class="space-y-5 p-5">
			{#if error}
				<p class="flex items-center gap-2 rounded-lg bg-danger/5 p-2.5 text-xs text-danger"><TriangleAlert class="size-3.5" />Re-run failed: {error}</p>
			{/if}

			<div class="grid grid-cols-2 gap-3 md:grid-cols-4 {summary.errors ? '2xl:grid-cols-5' : ''}">
				{#each [{ key: 'critical', label: 'Critical', value: summary.critical, tone: 'text-danger', icon: OctagonAlert }, { key: 'warn', label: 'Warnings', value: summary.warn, tone: 'text-warning', icon: TriangleAlert }, { key: 'info', label: 'Info', value: summary.info, tone: 'text-primary', icon: Info }] as s (s.key)}
					<button
						class="card p-3.5 text-left transition-colors hover:border-primary/40 {filter === s.key ? 'border-primary/60 ring-2 ring-primary/15' : ''}"
						aria-pressed={filter === s.key}
						title={filter === s.key ? 'Show all findings' : `Show only ${s.label.toLowerCase()}`}
						onclick={() => (filter = filter === s.key ? 'all' : (s.key as Severity))}
					>
						<div class="flex items-center gap-2 text-xs text-muted-foreground"><s.icon class="size-3.5 {s.tone}" />{s.label}</div>
						<p class="mt-1.5 text-xl font-semibold tracking-tight tabular-nums {s.value ? s.tone : ''}">{s.value}</p>
					</button>
				{/each}
				<div class="card p-3.5">
					<div class="flex items-center gap-2 text-xs text-muted-foreground"><CircleCheck class="size-3.5 text-success" />Checks passed</div>
					<p class="mt-1.5 text-xl font-semibold tracking-tight tabular-nums">
						{summary.passed}<span class="text-sm font-normal text-muted-foreground"> / {report.checks.length}</span>
					</p>
				</div>
				{#if summary.errors}
					<div class="card border-danger/30 p-3.5">
						<div class="flex items-center gap-2 text-xs text-muted-foreground"><TriangleAlert class="size-3.5 text-danger" />Couldn’t run</div>
						<p class="mt-1.5 text-xl font-semibold tracking-tight text-danger tabular-nums">{summary.errors}</p>
					</div>
				{/if}
			</div>

			{#if filter !== 'all'}
				<p class="text-xs text-muted-foreground">
					Showing {SEV[filter].label.toLowerCase()} findings only. <button class="text-primary hover:underline" onclick={() => (filter = 'all')}>Show all</button>
				</p>
			{/if}

			{#if !withFindings.length}
				<div class="card flex items-center gap-3 p-4">
					<CircleCheck class="size-5 text-success" />
					<div>
						<p class="text-[13px] font-medium">Nothing to report</p>
						<p class="text-xs text-muted-foreground">Every check passed. Statistics-based checks are only as good as the statistics, so re-run after a busy day.</p>
					</div>
				</div>
			{/if}

			{#each visibleChecks as c (c.id)}
				{@const open = expanded.has(c.id)}
				<section class="card overflow-hidden">
					<button class="flex w-full items-center gap-2.5 px-4 py-3 text-left hover:bg-accent/40" aria-expanded={open} onclick={() => toggle(c.id)}>
						<ChevronRight class="size-3.5 shrink-0 text-muted-foreground transition-transform {open ? 'rotate-90' : ''}" />
						{@render statusIcon(c)}
						<span class="text-[13px] font-semibold">{c.title}</span>
						{#if c.status === 'error'}
							<span class="badge badge-danger">error</span>
						{:else}
							{#each ['critical', 'warn', 'info'] as const as s (s)}
								{@const n = countOf(c, s)}
								{#if n}<span class="badge {SEV[s].badge} tabular-nums">{n} {SEV[s].label.toLowerCase()}</span>{/if}
							{/each}
							{#if c.truncated}<span class="badge" title="Only the most important findings are listed">more not shown</span>{/if}
						{/if}
						<span class="ml-auto hidden text-[11px] text-muted-foreground sm:inline">{appliesTo(c.id)}</span>
					</button>
					{#if open}
						<div class="space-y-3 border-t border-border px-4 py-3">
							<p class="text-xs text-muted-foreground">
								{checkInfo(c.id)?.description}
								{#if c.note}<span class="text-foreground/80">{c.note}</span>{/if}
							</p>
							{#if c.error}
								<p class="flex items-start gap-2 rounded-lg bg-danger/5 p-2.5 font-mono text-[11px] text-danger">
									<TriangleAlert class="mt-px size-3.5 shrink-0" />{c.error}
								</p>
								<p class="text-[11px] text-muted-foreground">The other checks ran normally. Missing privileges are the usual cause — on Postgres, membership in pg_monitor (or pg_read_all_stats) helps.</p>
							{/if}
							{#each c.findings.filter((f) => filter === 'all' || f.severity === filter) as f, i (i)}
								{@const S = SEV[f.severity]}
								<div class="rounded-lg border border-border bg-surface/60 p-3">
									<div class="flex items-start gap-2">
										<span class="badge {S.badge} mt-px shrink-0"><S.icon />{S.label}</span>
										<p class="text-[13px] font-medium leading-snug">{f.title}</p>
									</div>
									<p class="mt-1.5 text-xs leading-relaxed text-muted-foreground">{f.explanation}</p>
									{#if f.objects.length}
										<div class="mt-2 flex flex-wrap gap-1">
											{#each f.objects as o (o)}<span class="badge font-mono">{o}</span>{/each}
										</div>
									{/if}
									{#if f.fix}
										<div class="mt-2.5 overflow-hidden rounded-lg border border-border bg-background">
											<div class="flex items-center gap-1 border-b border-border px-2 py-1">
												<span class="mr-auto text-[11px] text-muted-foreground">Suggested fix — review before running</span>
												<button class="btn btn-ghost btn-sm" onclick={() => copyText(f.fix!, 'SQL copied')}><Copy />Copy</button>
												{#if onquery}
													<button class="btn btn-ghost btn-sm" onclick={() => onquery(f.fix!)}><SquareTerminal />Open in query editor</button>
												{/if}
											</div>
											<pre class="overflow-x-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre">{f.fix}</pre>
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</section>
			{/each}

			{#if quiet.length && filter === 'all'}
				<section class="card overflow-hidden">
					<div class="border-b border-border px-4 py-2.5">
						<h3 class="text-[13px] font-semibold">Passed{quiet.some((c) => c.status === 'skipped') ? ' and skipped' : ''}</h3>
					</div>
					<ul class="divide-y divide-border">
						{#each quiet as c (c.id)}
							<li class="flex items-start gap-2.5 px-4 py-2.5">
								<span class="mt-px">{@render statusIcon(c)}</span>
								<div class="min-w-0 flex-1">
									<p class="text-[13px]">{c.title}{#if c.status === 'skipped'}<span class="ml-1.5 badge">skipped</span>{/if}</p>
									<p class="text-[11px] text-muted-foreground">{c.note ?? checkInfo(c.id)?.description}</p>
								</div>
								<span class="hidden text-[11px] text-muted-foreground sm:inline">{appliesTo(c.id)}</span>
							</li>
						{/each}
					</ul>
				</section>
			{/if}
		</div>
	{/if}
</div>
