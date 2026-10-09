<script lang="ts">
	import { untrack } from 'svelte';
	import { Download, Eye, Globe, KeyRound, Layers, Link2, LoaderCircle, Maximize, Minus, Network, Plus, Search, Split, Table2 } from '@lucide/svelte';
	import Switch from '#lib/components/Switch.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { estimate, layoutDiagram, tableKey, HEADER, PAD_X, type DiagramLayout, type Measure } from '#lib/client/diagram-layout.ts';
	import type { RelationSummary, SchemaDiagram, SchemaTree } from '#lib/types.ts';

	let {
		connectionId,
		schema = $bindable(),
		onopen
	}: {
		connectionId: string;
		schema: string;
		onopen: (schema: string, table: string, kind: RelationSummary['kind']) => void;
	} = $props();

	const uid = $props.id();
	const SANS = "'Geist Variable', ui-sans-serif, system-ui, sans-serif";
	const MONO = "'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace";
	const FONTS = { header: `600 13px ${SANS}`, name: `12px ${SANS}`, type: `11px ${MONO}` };
	const kindIcon = { table: Table2, view: Eye, matview: Layers, foreign: Globe, partitioned: Split };
	const MIN_ZOOM = 0.08;
	const MAX_ZOOM = 2.5;

	let schemas = $state<string[]>([]);
	let data = $state<SchemaDiagram | null>(null);
	let loading = $state(true);
	let error = $state('');
	let compact = $state(false);
	let views = $state(false);
	let filter = $state('');
	let hovered = $state<string | null>(null);
	let fontsReady = $state(false);
	let width = $state(0);
	let height = $state(0);
	let view = $state({ x: 0, y: 0, k: 1 });
	let needsFit = true;
	let svg = $state<SVGSVGElement>();
	let content = $state<SVGGElement>();

	// Measure text with the real fonts once they have loaded; estimates until then.
	let ctx: CanvasRenderingContext2D | null = null;
	const measure: Measure = (text, font) => {
		ctx ??= document.createElement('canvas').getContext('2d');
		if (!ctx) return estimate(text, font);
		ctx.font = FONTS[font];
		return ctx.measureText(text).width;
	};
	$effect(() => {
		document.fonts.ready.then(() => (fontsReady = true));
	});

	$effect(() => {
		void connectionId;
		api
			.get<SchemaTree>(`/api/connections/${connectionId}/schema`)
			.then((t) => (schemas = t.schemas.map((s) => s.name)))
			.catch(() => {});
	});

	$effect(() => {
		const url = `/api/connections/${connectionId}/diagram?schema=${encodeURIComponent(schema)}${views ? '&views=1' : ''}`;
		const ctrl = new AbortController();
		untrack(() => {
			loading = true;
			error = '';
		});
		api
			.get<SchemaDiagram>(url, ctrl.signal)
			.then((d) => {
				data = d;
				hovered = null;
			})
			.catch((e) => {
				if (ctrl.signal.aborted) return;
				data = null;
				error = errorMessage(e);
			})
			.finally(() => {
				if (!ctrl.signal.aborted) loading = false;
			});
		return () => ctrl.abort();
	});

	const layout = $derived<DiagramLayout | null>(data && fontsReady ? layoutDiagram(data, { compact, measure }) : null);

	// Re-fit whenever the layout changes, once the tab is actually visible.
	$effect(() => {
		void layout;
		needsFit = true;
	});
	$effect(() => {
		void layout;
		if (needsFit && width > 0 && height > 0 && layout) {
			needsFit = false;
			untrack(fit);
		}
	});

	const needle = $derived(filter.trim().toLowerCase());
	const matches = $derived(new Set(layout && needle ? layout.nodes.filter((n) => n.title.toLowerCase().includes(needle)).map((n) => n.key) : []));
	const neighbors = $derived.by(() => {
		if (!layout || !hovered) return null;
		const s = new Set([hovered]);
		for (const e of layout.edges) {
			if (e.from === hovered) s.add(e.to);
			if (e.to === hovered) s.add(e.from);
		}
		return s;
	});
	const focus = $derived(neighbors ?? (needle ? matches : null));
	const ownTables = $derived(data?.tables.filter((t) => !t.external).length ?? 0);

	function edgeState(from: string, to: string): 'normal' | 'hot' | 'dim' {
		if (hovered) return from === hovered || to === hovered ? 'hot' : 'dim';
		if (needle) return matches.has(from) || matches.has(to) ? 'normal' : 'dim';
		return 'normal';
	}

	function fit() {
		if (!layout || !width || !height) return;
		const b = layout.bounds;
		const pad = 40;
		const k = Math.min(MAX_ZOOM, 1, Math.max(MIN_ZOOM, Math.min((width - pad * 2) / Math.max(b.width, 1), (height - pad * 2) / Math.max(b.height, 1))));
		view = { k, x: (width - b.width * k) / 2 - b.x * k, y: Math.max(pad, (height - b.height * k) / 2) - b.y * k };
	}

	function zoomAt(px: number, py: number, factor: number) {
		const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * factor));
		const r = k / view.k;
		view = { k, x: px - (px - view.x) * r, y: py - (py - view.y) * r };
	}

	function centerOn(key: string) {
		const n = layout?.nodes.find((n) => n.key === key);
		if (!n) return;
		const k = Math.max(view.k, 0.8);
		view = { k, x: width / 2 - (n.x + n.width / 2) * k, y: height / 2 - (n.y + n.height / 2) * k };
	}

	// Wheel and pinch zoom; needs a non-passive listener to stop the page scrolling.
	$effect(() => {
		const el = svg;
		if (!el) return;
		const onwheel = (e: WheelEvent) => {
			e.preventDefault();
			const r = el.getBoundingClientRect();
			const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
			zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-Math.max(-60, Math.min(60, dy)) * (e.ctrlKey ? 0.01 : 0.002)));
		};
		el.addEventListener('wheel', onwheel, { passive: false });
		return () => el.removeEventListener('wheel', onwheel);
	});

	// Drag anywhere to pan; two pointers pinch-zoom.
	const pointers = new Map<number, { x: number; y: number }>();
	let travelled = 0;
	let pinch = 0;

	function onpointerdown(e: PointerEvent) {
		if (e.button !== 0) return;
		if (!pointers.size) travelled = 0;
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.size === 2) {
			const [a, b] = [...pointers.values()];
			pinch = Math.hypot(a.x - b.x, a.y - b.y);
		}
		window.addEventListener('pointermove', onpointermove);
		window.addEventListener('pointerup', onpointerup);
		window.addEventListener('pointercancel', onpointerup);
	}

	function onpointermove(e: PointerEvent) {
		const prev = pointers.get(e.pointerId);
		if (!prev) return;
		const cur = { x: e.clientX, y: e.clientY };
		pointers.set(e.pointerId, cur);
		if (pointers.size === 2 && svg) {
			const [a, b] = [...pointers.values()];
			const dist = Math.hypot(a.x - b.x, a.y - b.y);
			const r = svg.getBoundingClientRect();
			if (pinch) zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, dist / pinch);
			pinch = dist;
			travelled += 10;
			return;
		}
		const dx = cur.x - prev.x;
		const dy = cur.y - prev.y;
		travelled += Math.abs(dx) + Math.abs(dy);
		view = { ...view, x: view.x + dx, y: view.y + dy };
	}

	function onpointerup(e: PointerEvent) {
		pointers.delete(e.pointerId);
		pinch = 0;
		if (!pointers.size) {
			window.removeEventListener('pointermove', onpointermove);
			window.removeEventListener('pointerup', onpointerup);
			window.removeEventListener('pointercancel', onpointerup);
		}
	}

	function open(n: DiagramLayout['nodes'][number]) {
		if (travelled > 4) return; // that was a pan, not a click
		onopen(n.table.schema, n.table.name, n.table.kind);
	}

	function zoomButton(factor: number) {
		zoomAt(width / 2, height / 2, factor);
	}

	const VARS = ['--background', '--card', '--surface', '--muted', '--muted-foreground', '--foreground', '--border', '--primary', '--primary-soft', '--warning'];

	function exportSvg() {
		if (!layout || !content) return;
		const b = layout.bounds;
		const pad = 32;
		const cs = getComputedStyle(svg ?? document.documentElement);
		const vars = VARS.map((v) => `${v}:${cs.getPropertyValue(v).trim()}`).join(';');
		const [w, h] = [Math.ceil(b.width + pad * 2), Math.ceil(b.height + pad * 2)];
		const out =
			`<?xml version="1.0" encoding="UTF-8"?>\n` +
			`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${b.x - pad} ${b.y - pad} ${w} ${h}" font-family="${SANS}" style="${vars}">` +
			`<rect x="${b.x - pad}" y="${b.y - pad}" width="${w}" height="${h}" style="fill:var(--background)"/>` +
			content.innerHTML.replace(/<!--[\s\S]*?-->/g, '') +
			`</svg>`;
		const a = document.createElement('a');
		a.href = URL.createObjectURL(new Blob([out], { type: 'image/svg+xml' }));
		a.download = `${schema}-diagram.svg`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 1000);
	}
</script>

<div class="flex h-full flex-col">
	<div class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
		<Network class="size-3.5 text-primary" />
		<select class="input h-7 w-auto min-w-28 py-0 text-xs" bind:value={schema} aria-label="Schema">
			{#each schemas.includes(schema) ? schemas : [schema, ...schemas] as s (s)}
				<option value={s}>{s}</option>
			{/each}
		</select>
		<div class="relative w-48">
			<Search class="absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
			<input
				class="input h-7 pl-7 text-xs"
				placeholder="Highlight tables…"
				bind:value={filter}
				onkeydown={(e) => {
					if (e.key === 'Enter' && matches.size) centerOn([...matches][0]);
					if (e.key === 'Escape') filter = '';
				}}
			/>
		</div>
		{#if needle}
			<span class="text-[11px] text-muted-foreground tabular-nums">{matches.size} {matches.size === 1 ? 'match' : 'matches'}</span>
		{/if}
		<div class="ml-auto flex items-center gap-3">
			{#if data}
				<span class="text-[11px] text-muted-foreground tabular-nums">
					{ownTables} {ownTables === 1 ? 'table' : 'tables'} · {data.foreignKeys.length} {data.foreignKeys.length === 1 ? 'relation' : 'relations'}
				</span>
				{#if data.truncated}<span class="badge badge-warning" title="The diagram shows the first {ownTables} relations">Truncated</span>{/if}
			{/if}
			<span class="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Switch bind:checked={compact} label="Show only key columns" />Keys only</span>
			<span class="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Switch bind:checked={views} label="Include views" />Views</span>
			<button class="btn btn-secondary btn-sm" onclick={exportSvg} disabled={!layout?.nodes.length}><Download />Export SVG</button>
		</div>
	</div>

	<div class="relative min-h-0 flex-1 overflow-hidden bg-background" bind:clientWidth={width} bind:clientHeight={height}>
		{#if error}
			<div class="grid h-full place-items-center p-6">
				<div class="max-w-lg rounded-lg border border-danger/30 bg-danger/5 p-3 font-mono text-xs text-danger">{error}</div>
			</div>
		{:else if !layout}
			<div class="grid h-full place-items-center"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
		{:else if !layout.nodes.length}
			<div class="grid h-full place-items-center">
				<div class="text-center">
					<Network class="mx-auto size-8 text-muted-foreground/50" />
					<p class="mt-2 text-sm font-medium">No tables in this schema</p>
					<p class="mt-0.5 text-xs text-muted-foreground">Pick another schema{views ? '' : ' or include views'}.</p>
				</div>
			</div>
		{:else}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<svg
				bind:this={svg}
				class="block h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
				role="img"
				aria-label="Schema diagram of {schema}"
				{onpointerdown}
			>
				<defs>
					<pattern id="{uid}-dots" patternUnits="userSpaceOnUse" width={18 * view.k} height={18 * view.k} x={view.x} y={view.y}>
						<circle cx={view.k} cy={view.k} r={Math.max(0.6, view.k)} style="fill:var(--border)" />
					</pattern>
				</defs>
				<rect width="100%" height="100%" fill="url(#{uid}-dots)" />
				<g transform="translate({view.x} {view.y}) scale({view.k})">
					<g bind:this={content} font-family={SANS}>
						<g fill="none" stroke-linecap="round" stroke-linejoin="round">
							{#each layout.edges as e (e.key)}
								{@const st = edgeState(e.from, e.to)}
								<g
									style="stroke:{st === 'hot' ? 'var(--primary)' : 'var(--muted-foreground)'};opacity:{st === 'hot' ? 1 : st === 'dim' ? 0.12 : 0.55}"
									stroke-width={st === 'hot' ? 1.75 : 1.25}
								>
									<title>{e.fk.name}: {e.fk.fromTable}({e.fk.fromColumns.join(', ')}) → {e.fk.toTable}({e.fk.toColumns.join(', ')})</title>
									<path d={e.path} />
									<path d={e.ends} />
								</g>
							{/each}
						</g>
						{#each layout.nodes as n (n.key)}
							{@const ext = !!n.table.external}
							{@const hot = hovered === n.key || matches.has(n.key)}
							{@const dim = focus && !focus.has(n.key)}
							{@const Icon = ext ? Globe : kindIcon[n.table.kind]}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<g
								transform="translate({n.x} {n.y})"
								style="opacity:{dim ? 0.25 : ext ? 0.7 : 1};transition:opacity 120ms"
								onpointerenter={() => pointers.size || (hovered = n.key)}
								onpointerleave={() => hovered === n.key && (hovered = null)}
							>
								<rect
									width={n.width}
									height={n.height}
									rx="10"
									style="fill:{ext ? 'var(--surface)' : 'var(--card)'};stroke:{hot ? 'var(--primary)' : 'var(--border)'}"
									stroke-width={hot ? 1.5 : 1}
									stroke-dasharray={ext ? '4 3' : undefined}
								/>
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<g class="cursor-pointer" onclick={() => open(n)}>
									<title>Open {n.table.schema}.{n.table.name}</title>
									<path
										d="M0.5,{HEADER} V10 A9.5,9.5 0 0 1 10,0.5 H{n.width - 10} A9.5,9.5 0 0 1 {n.width - 0.5},10 V{HEADER} Z"
										style="fill:{hot ? 'var(--primary-soft)' : 'var(--muted)'}"
									/>
									<g style="color:{ext ? 'var(--muted-foreground)' : 'var(--primary)'}">
										<Icon x={PAD_X} y={(HEADER - 14) / 2} width={14} height={14} strokeWidth={2} />
									</g>
									<text x={PAD_X + 20} y={HEADER / 2} dominant-baseline="central" font-size="13" font-weight="600" style="fill:var(--foreground)">
										{#if ext}<tspan style="fill:var(--muted-foreground)" font-weight="500">{n.table.schema}.</tspan>{/if}{n.table.name}
									</text>
									{#if n.hidden && compact}
										<text x={n.width - PAD_X} y={HEADER / 2} dominant-baseline="central" text-anchor="end" font-size="11" style="fill:var(--muted-foreground)">+{n.hidden}</text>
									{/if}
								</g>
								{#if n.rows.length}
									<line x1="0" x2={n.width} y1={HEADER} y2={HEADER} style="stroke:var(--border)" />
								{/if}
								{#each n.rows as r (r.name)}
									{#if r.isPrimaryKey}
										<g style="color:var(--warning)"><KeyRound x={PAD_X} y={r.cy - 6} width={12} height={12} strokeWidth={2.25} /></g>
									{:else if r.isForeignKey}
										<g style="color:var(--primary)"><Link2 x={PAD_X} y={r.cy - 6} width={12} height={12} strokeWidth={2.25} /></g>
									{/if}
									<text
										x={PAD_X + 20}
										y={r.cy}
										dominant-baseline="central"
										font-size="12"
										font-weight={r.isPrimaryKey ? 500 : 400}
										style="fill:var(--foreground)"
									>{r.label}{#if !r.nullable && !r.isPrimaryKey}<tspan style="fill:var(--muted-foreground)" font-size="10" dx="2">*</tspan>{/if}</text>
									<text
										x={n.width - PAD_X}
										y={r.cy}
										dominant-baseline="central"
										text-anchor="end"
										font-size="11"
										font-family={MONO}
										style="fill:var(--muted-foreground)">{r.typeLabel}</text
									>
								{/each}
							</g>
						{/each}
					</g>
				</g>
			</svg>

			<div class="absolute bottom-3 left-3 flex items-center gap-3 rounded-lg border border-border bg-card/90 px-2.5 py-1.5 text-[11px] text-muted-foreground shadow-surface backdrop-blur-sm">
				<span class="flex items-center gap-1"><KeyRound class="size-3 text-warning" />primary key</span>
				<span class="flex items-center gap-1"><Link2 class="size-3 text-primary" />foreign key</span>
				<span><span class="text-foreground">*</span> not null</span>
			</div>

			<div class="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-lg border border-border bg-card/90 p-0.5 shadow-surface backdrop-blur-sm">
				<button class="btn btn-ghost btn-icon btn-sm" title="Zoom out" onclick={() => zoomButton(1 / 1.25)}><Minus /></button>
				<button class="h-7 w-11 rounded-md text-[11px] text-muted-foreground tabular-nums hover:bg-accent hover:text-foreground" title="Reset to 100%" onclick={() => zoomButton(1 / view.k)}>
					{Math.round(view.k * 100)}%
				</button>
				<button class="btn btn-ghost btn-icon btn-sm" title="Zoom in" onclick={() => zoomButton(1.25)}><Plus /></button>
				<button class="btn btn-ghost btn-icon btn-sm" title="Fit to view" onclick={fit}><Maximize /></button>
			</div>

			{#if loading}
				<div class="absolute top-3 right-3"><LoaderCircle class="size-4 animate-spin text-muted-foreground" /></div>
			{/if}
		{/if}
	</div>
</div>
