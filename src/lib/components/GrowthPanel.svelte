<script lang="ts">
	import { LoaderCircle, RefreshCw, TrendingUp } from '@lucide/svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { ago, bytes } from '#lib/client/format.ts';
	import { isAdmin, toast } from '#lib/client/state.svelte.ts';
	import { GROWTH_RANGES, type GrowthData, type GrowthRange, type SizePoint } from '#lib/alerts.ts';

	let { connectionId, onopen }: { connectionId: string; onopen?: (schema: string, table: string) => void } = $props();

	let range = $state<GrowthRange>('30d');
	let data = $state<GrowthData | null>(null);
	let error = $state('');
	let sampling = $state(false);

	$effect(() => {
		const url = `/api/connections/${connectionId}/growth?range=${range}`;
		error = '';
		api
			.get<GrowthData>(url)
			.then((d) => (data = d))
			.catch((e) => (error = errorMessage(e)));
	});

	async function sampleNow() {
		sampling = true;
		try {
			data = await api.post<GrowthData>(`/api/connections/${connectionId}/growth?range=${range}`);
		} catch (err) {
			toast('error', 'Could not sample sizes', errorMessage(err));
		} finally {
			sampling = false;
		}
	}

	// --- chart geometry (viewBox units; the SVG scales to its container width) ---
	const W = 640;
	const H = 180;
	const PAD = { top: 12, right: 12, bottom: 22, left: 56 };
	const iw = W - PAD.left - PAD.right;
	const ih = H - PAD.top - PAD.bottom;

	const series = $derived(data?.series ?? []);
	const span = $derived.by(() => {
		if (!series.length) return null;
		const t0 = series[0].at;
		const t1 = series.at(-1)!.at;
		let lo = Math.min(...series.map((p) => p.bytes));
		let hi = Math.max(...series.map((p) => p.bytes));
		// Sizes are levels: show the change, with some headroom, not a range from zero.
		const pad = Math.max((hi - lo) * 0.15, hi * 0.02, 1);
		lo = Math.max(0, lo - pad);
		hi = hi + pad;
		return { t0, t1: t1 === t0 ? t0 + 1 : t1, lo, hi };
	});
	const x = (t: number) => (span ? PAD.left + ((t - span.t0) / (span.t1 - span.t0)) * iw : 0);
	const y = (b: number) => (span ? PAD.top + ih - ((b - span.lo) / (span.hi - span.lo)) * ih : 0);
	const line = $derived(series.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.bytes).toFixed(1)}`).join(''));
	const area = $derived(series.length ? `${line}L${x(series.at(-1)!.at).toFixed(1)},${PAD.top + ih}L${x(series[0].at).toFixed(1)},${PAD.top + ih}Z` : '');
	const yTicks = $derived(span ? [0, 1, 2, 3].map((i) => span.lo + ((span.hi - span.lo) * i) / 3) : []);
	const xTicks = $derived.by(() => {
		if (!span || series.length < 2) return [];
		const n = 4;
		return Array.from({ length: n + 1 }, (_, i) => span.t0 + ((span.t1 - span.t0) * i) / n);
	});
	const dateFmt = (t: number) =>
		new Date(t).toLocaleDateString(undefined, range === '1y' ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' });

	const change = $derived(series.length >= 2 ? series.at(-1)!.bytes - series[0].bytes : null);
	const changePct = $derived(change != null && series[0].bytes > 0 ? (100 * change) / series[0].bytes : null);

	// --- hover ---
	let svg = $state<SVGSVGElement>();
	let hover = $state<SizePoint | null>(null);
	function onmove(e: PointerEvent) {
		if (!svg || !series.length || !span) return;
		const r = svg.getBoundingClientRect();
		const vx = ((e.clientX - r.left) / r.width) * W;
		const t = span.t0 + ((vx - PAD.left) / iw) * (span.t1 - span.t0);
		let best = series[0];
		for (const p of series) if (Math.abs(p.at - t) < Math.abs(best.at - t)) best = p;
		hover = best;
	}
	const tipLeft = $derived(hover ? (x(hover.at) / W) * 100 : 0);
	const signed = (n: number) => `${n >= 0 ? '+' : '−'}${bytes(Math.abs(n))}`;
	const maxDelta = $derived(Math.max(1, ...(data?.tables.map((t) => Math.abs(t.delta)) ?? [1])));
</script>

<section class="card p-4">
	<div class="mb-3 flex flex-wrap items-center gap-2">
		<h3 class="flex items-center gap-2 text-[13px] font-semibold"><TrendingUp class="size-4 text-primary" />Growth</h3>
		{#if change != null}
			<span class="text-[11px] text-muted-foreground tabular-nums">
				{signed(change)}{#if changePct != null}{' '}({changePct >= 0 ? '+' : ''}{changePct.toFixed(1)}%){/if} over {range === '1y' ? 'the year' : range}
			</span>
		{/if}
		<div class="ml-auto flex items-center gap-2">
			{#if data?.lastSampleAt}<span class="text-[11px] text-muted-foreground">sampled {ago(new Date(data.lastSampleAt).toISOString())}</span>{/if}
			{#if isAdmin()}
				<button class="btn btn-ghost btn-sm" title="Sample sizes now" disabled={sampling} onclick={sampleNow}>
					{#if sampling}<LoaderCircle class="animate-spin" />{:else}<RefreshCw />{/if}Sample
				</button>
			{/if}
			<div class="inline-flex rounded-lg border border-border bg-surface p-0.5" role="tablist" aria-label="Range">
				{#each GROWTH_RANGES as r (r)}
					<button
						role="tab"
						aria-selected={range === r}
						class="h-6 rounded-md px-2 text-[11px] font-medium {range === r ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground hover:text-foreground'}"
						onclick={() => (range = r)}>{r}</button
					>
				{/each}
			</div>
		</div>
	</div>

	{#if error}
		<p class="font-mono text-xs text-danger">{error}</p>
	{:else if !data}
		<div class="grid h-44 place-items-center"><LoaderCircle class="size-4 animate-spin text-muted-foreground" /></div>
	{:else if series.length < 2}
		<div class="grid h-44 place-items-center rounded-lg border border-dashed border-border px-6 text-center text-xs text-muted-foreground">
			Size history builds up as pg·modern samples this database once an hour. Check back in a few hours.
		</div>
	{:else}
		<div class="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
			<div class="relative">
				<svg
					bind:this={svg}
					viewBox="0 0 {W} {H}"
					class="block h-auto w-full touch-none select-none"
					role="img"
					aria-label="Database size over {range}, from {bytes(series[0].bytes)} to {bytes(series.at(-1)!.bytes)}"
					onpointermove={onmove}
					onpointerleave={() => (hover = null)}
				>
					<defs>
						<linearGradient id="growth-fill-{connectionId}" x1="0" x2="0" y1="0" y2="1">
							<stop offset="0%" stop-color="var(--primary)" stop-opacity="0.22" />
							<stop offset="100%" stop-color="var(--primary)" stop-opacity="0" />
						</linearGradient>
					</defs>
					{#each yTicks as t, i (i)}
						<line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--border)" stroke-dasharray={i ? '2 3' : undefined} />
						<text x={PAD.left - 8} y={y(t)} dy="0.32em" text-anchor="end" class="fill-muted-foreground text-[10px] tabular-nums">{bytes(t)}</text>
					{/each}
					{#each xTicks as t, i (i)}
						<text x={x(t)} y={H - 6} text-anchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'} class="fill-muted-foreground text-[10px]">{dateFmt(t)}</text>
					{/each}
					<path d={area} fill="url(#growth-fill-{connectionId})" />
					<path d={line} fill="none" stroke="var(--primary)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
					{#if hover}
						<line x1={x(hover.at)} x2={x(hover.at)} y1={PAD.top} y2={PAD.top + ih} stroke="var(--muted-foreground)" stroke-opacity="0.5" />
						<circle cx={x(hover.at)} cy={y(hover.bytes)} r="4" fill="var(--primary)" stroke="var(--card)" stroke-width="2" />
					{/if}
				</svg>
				{#if hover}
					<div
						class="pointer-events-none absolute top-0 z-10 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[11px] shadow-surface-lg whitespace-nowrap"
						style="left:{tipLeft}%; transform: translateX({tipLeft > 60 ? 'calc(-100% - 10px)' : '10px'})"
					>
						<p class="font-semibold tabular-nums">{bytes(hover.bytes)}</p>
						<p class="text-muted-foreground">
							{new Date(hover.at).toLocaleString(undefined, range === '7d' ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' })}
						</p>
					</div>
				{/if}
			</div>

			<div>
				<p class="mb-1.5 text-[11px] font-medium text-muted-foreground">Fastest-growing tables ({range})</p>
				<div class="space-y-0.5">
					{#each data.tables.filter((t) => t.delta !== 0).slice(0, 8) as t (t.schema + '.' + t.name)}
						<button
							class="group relative block w-full overflow-hidden rounded-md px-2 py-1 text-left hover:bg-accent/50 disabled:cursor-default"
							disabled={!onopen}
							onclick={() => onopen?.(t.schema, t.name)}
						>
							<div class="absolute inset-y-0 left-0 rounded-md {t.delta >= 0 ? 'bg-primary-soft' : 'bg-muted'}" style="width:{(Math.abs(t.delta) / maxDelta) * 100}%"></div>
							<div class="relative flex items-center gap-2 text-xs">
								<span class="min-w-0 truncate font-mono"><span class="text-muted-foreground">{t.schema}.</span>{t.name}</span>
								<span class="ml-auto text-[11px] text-muted-foreground tabular-nums">{bytes(t.bytes)}</span>
								<span class="w-24 text-right text-[11px] font-medium tabular-nums">
									{signed(t.delta)}{#if t.deltaPct != null}<span class="ml-1 font-normal text-muted-foreground">{t.deltaPct >= 0 ? '+' : ''}{Math.round(t.deltaPct)}%</span>{:else}<span class="ml-1 font-normal text-muted-foreground">new</span>{/if}
								</span>
							</div>
						</button>
					{:else}
						<p class="px-2 py-1 text-xs text-muted-foreground">No table changed size in this range.</p>
					{/each}
				</div>
			</div>
		</div>
	{/if}
</section>
