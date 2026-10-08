<script lang="ts">
	import { Copy, X } from '@lucide/svelte';
	import type { SelectedCell } from './DataGrid.svelte';
	import { toast } from '#lib/client/state.svelte.ts';

	let { cell = $bindable() }: { cell: SelectedCell | null } = $props();

	const pretty = $derived.by(() => {
		if (!cell) return '';
		const v = cell.value;
		if (v === null || v === undefined) return 'NULL';
		if (typeof v === 'object') return JSON.stringify(v, null, 2);
		if (typeof v === 'string' && /^[[{]/.test(v.trim())) {
			try {
				return JSON.stringify(JSON.parse(v), null, 2);
			} catch {}
		}
		return String(v);
	});

	function copy() {
		navigator.clipboard.writeText(pretty);
		toast('success', 'Copied to clipboard');
	}
</script>

{#if cell}
	<aside class="flex w-80 shrink-0 flex-col border-l border-border bg-surface">
		<div class="flex items-center gap-2 border-b border-border px-3 py-2">
			<div class="min-w-0 flex-1">
				<p class="truncate text-[13px] font-semibold">{cell.field.name}</p>
				<p class="font-mono text-[10px] text-muted-foreground">{cell.field.type} · row {cell.row + 1}</p>
			</div>
			<button class="btn btn-ghost btn-icon btn-sm" title="Copy value" onclick={copy}><Copy /></button>
			<button class="btn btn-ghost btn-icon btn-sm" title="Close" onclick={() => (cell = null)}><X /></button>
		</div>
		<pre class="min-h-0 flex-1 overflow-auto p-3 font-mono text-[12px] leading-relaxed break-all whitespace-pre-wrap {cell.value === null ? 'text-muted-foreground italic' : ''}">{pretty}</pre>
		<p class="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
			{pretty.length.toLocaleString()} chars · <span class="kbd">↑↓←→</span> move · <span class="kbd">⌘C</span> copy
		</p>
	</aside>
{/if}
