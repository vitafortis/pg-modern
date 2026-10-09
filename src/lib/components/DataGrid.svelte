<script lang="ts" module>
	export interface GridField {
		name: string;
		type: string;
	}
	export interface SelectedCell {
		row: number;
		col: number;
		value: unknown;
		field: GridField;
	}
</script>

<script lang="ts">
	import { ArrowDown, ArrowUp, KeyRound } from '@lucide/svelte';
	import { cellText } from '#lib/client/format.ts';

	let {
		fields,
		rows,
		offset = 0,
		sort,
		onsort,
		primaryKeys = [],
		selected = $bindable(null)
	}: {
		fields: GridField[];
		rows: unknown[][];
		offset?: number;
		sort?: { column: string; dir: 'asc' | 'desc' } | null;
		onsort?: (column: string) => void;
		primaryKeys?: string[];
		selected?: SelectedCell | null;
	} = $props();

	const ROW_H = 30;
	const HEADER_H = 34;
	const OVERSCAN = 12;

	let viewport: HTMLDivElement;
	let scrollTop = $state(0);
	let height = $state(600);
	let widths = $state<number[]>([]);

	const NUMERIC = /^(smallint|integer|bigint|tinyint|mediumint|int\d?|numeric|decimal|real|double( precision)?|float\d?|oid|money|year)/;
	const isNumeric = (type: string) => NUMERIC.test(type);

	// Size columns from the header and a sample of values; users can drag to resize.
	$effect(() => {
		const sample = rows.slice(0, 60);
		widths = fields.map((f, i) => {
			// Header shows name (sans, semibold) + type (mono, 10px) + optional key/sort icons.
			const header = f.name.length * 7.4 + Math.min(f.type.length, 24) * 6.2 + 48 + (primaryKeys.includes(f.name) ? 16 : 0);
			const longest = Math.max(0, ...sample.map((r) => Math.min(cellText(r[i]).length, 60)));
			return Math.round(Math.min(Math.max(header, longest * 7.4 + 24, 72), 380));
		});
	});

	const gutter = $derived(Math.max(44, String(offset + rows.length).length * 8 + 24));
	const template = $derived(`${gutter}px ${widths.map((w) => `${w}px`).join(' ')}`);
	const totalWidth = $derived(gutter + widths.reduce((a, b) => a + b, 0));
	const start = $derived(Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN));
	const end = $derived(Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN));
	const visible = $derived(rows.slice(start, end));

	function resize(e: PointerEvent, i: number) {
		e.preventDefault();
		e.stopPropagation();
		const startX = e.clientX;
		const startW = widths[i];
		const move = (ev: PointerEvent) => (widths[i] = Math.max(56, startW + ev.clientX - startX));
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	}

	function select(row: number, col: number) {
		selected = { row, col, value: rows[row][col], field: fields[col] };
	}

	function onkeydown(e: KeyboardEvent) {
		if (!selected) return;
		const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
		const m = moves[e.key];
		if (m) {
			e.preventDefault();
			const row = Math.min(Math.max(selected.row + m[0], 0), rows.length - 1);
			const col = Math.min(Math.max(selected.col + m[1], 0), fields.length - 1);
			select(row, col);
			const top = row * ROW_H;
			if (top < viewport.scrollTop) viewport.scrollTop = top;
			else if (top + ROW_H > viewport.scrollTop + height - HEADER_H) viewport.scrollTop = top + ROW_H - height + HEADER_H;
		} else if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
			navigator.clipboard.writeText(cellText(selected.value));
		} else if (e.key === 'Escape') {
			selected = null;
		}
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	bind:this={viewport}
	bind:clientHeight={height}
	onscroll={() => (scrollTop = viewport.scrollTop)}
	{onkeydown}
	tabindex="0"
	role="grid"
	aria-rowcount={rows.length}
	class="relative h-full overflow-auto font-mono text-[12px] outline-none"
>
	<div style="width:{totalWidth}px; min-width:100%; height:{HEADER_H + rows.length * ROW_H}px" class="relative">
		<div
			class="sticky top-0 z-10 grid border-b border-border bg-surface/95 backdrop-blur"
			style="grid-template-columns:{template}; height:{HEADER_H}px"
			role="row"
		>
			<div class="sticky left-0 z-10 border-r border-border bg-surface"></div>
			{#each fields as f, i (i)}
				<div class="group relative flex min-w-0 items-center border-r border-border/70" role="columnheader">
					<button
						class="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2.5 text-left font-sans {onsort ? 'hover:bg-accent/60' : 'cursor-default'}"
						onclick={() => onsort?.(f.name)}
						title="{f.name} · {f.type}"
					>
						{#if primaryKeys.includes(f.name)}<KeyRound class="size-3 shrink-0 text-warning" />{/if}
						<span class="truncate text-[12px] font-semibold text-foreground">{f.name}</span>
						<span class="truncate font-mono text-[10px] font-normal text-muted-foreground/80">{f.type}</span>
						{#if sort?.column === f.name}
							{#if sort.dir === 'asc'}<ArrowUp class="ml-auto size-3 shrink-0 text-primary" />{:else}<ArrowDown class="ml-auto size-3 shrink-0 text-primary" />{/if}
						{/if}
					</button>
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div class="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize hover:bg-primary/40" onpointerdown={(e) => resize(e, i)}></div>
				</div>
			{/each}
		</div>

		<div style="transform:translateY({start * ROW_H}px)">
			{#each visible as row, vi (start + vi)}
				{@const r = start + vi}
				<div
					class="grid border-b border-border/50 {r % 2 ? 'bg-muted/25' : ''} hover:bg-accent/40"
					style="grid-template-columns:{template}; height:{ROW_H}px"
					role="row"
				>
					<div class="sticky left-0 flex items-center justify-end border-r border-border bg-surface pr-2.5 text-[11px] text-muted-foreground/70 tabular-nums">
						{offset + r + 1}
					</div>
					{#each row as value, c (c)}
						{@const sel = selected?.row === r && selected?.col === c}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<div
							role="gridcell"
							tabindex="-1"
							onclick={() => select(r, c)}
							class="flex min-w-0 items-center border-r border-border/40 px-2.5 {sel ? 'bg-primary-soft ring-1 ring-primary ring-inset' : ''} {isNumeric(fields[c].type) ? 'justify-end tabular-nums' : ''}"
						>
							{#if value === null || value === undefined}
								<span class="text-[11px] text-muted-foreground/50 italic">NULL</span>
							{:else if typeof value === 'boolean'}
								<span class={value ? 'text-success' : 'text-muted-foreground'}>{value}</span>
							{:else if typeof value === 'object'}
								<span class="truncate text-[var(--syntax-keyword)]">{JSON.stringify(value)}</span>
							{:else}
								<span class="truncate">{String(value).slice(0, 500)}</span>
							{/if}
						</div>
					{/each}
				</div>
			{/each}
		</div>
	</div>
</div>
