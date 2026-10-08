<script lang="ts">
	import { ChevronRight, Eye, Folder, FolderOpen, Layers, RefreshCw, Search, Table2, Globe, Split, LoaderCircle } from '@lucide/svelte';
	import { compact } from '#lib/client/format.ts';
	import type { RelationSummary, SchemaTree } from '#lib/types.ts';

	let {
		tree,
		loading,
		active,
		showSystem = $bindable(false),
		onopen,
		onrefresh
	}: {
		tree: SchemaTree | null;
		loading: boolean;
		active: string | null;
		showSystem: boolean;
		onopen: (schema: string, rel: RelationSummary) => void;
		onrefresh: () => void;
	} = $props();

	let filter = $state('');
	let expanded = $state<Record<string, boolean>>({ public: true });

	const icons = { table: Table2, view: Eye, matview: Layers, foreign: Globe, partitioned: Split };

	const schemas = $derived(
		(tree?.schemas ?? [])
			.map((s) => ({
				...s,
				relations: filter ? s.relations.filter((r) => r.name.toLowerCase().includes(filter.toLowerCase())) : s.relations
			}))
			.filter((s) => !filter || s.relations.length)
	);
</script>

<div class="flex h-full flex-col">
	<div class="flex items-center gap-1.5 border-b border-border p-2">
		<div class="relative flex-1">
			<Search class="absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
			<input class="input h-7 pl-7 text-xs" placeholder="Filter tables…" bind:value={filter} />
		</div>
		<button class="btn btn-ghost btn-icon btn-sm" title="Refresh schema" onclick={onrefresh}>
			{#if loading}<LoaderCircle class="animate-spin" />{:else}<RefreshCw />{/if}
		</button>
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto py-1.5 text-[13px]">
		{#each schemas as s (s.name)}
			{@const open = filter ? true : (expanded[s.name] ?? false)}
			<button
				class="flex h-7 w-full items-center gap-1.5 px-2 text-left text-muted-foreground hover:text-foreground"
				onclick={() => (expanded[s.name] = !open)}
			>
				<ChevronRight class="size-3.5 shrink-0 transition-transform {open ? 'rotate-90' : ''}" />
				{#if open}<FolderOpen class="size-3.5 shrink-0 text-primary" />{:else}<Folder class="size-3.5 shrink-0" />{/if}
				<span class="truncate font-medium">{s.name}</span>
				<span class="ml-auto pr-1 text-[10px] tabular-nums opacity-60">{s.relations.length}</span>
			</button>
			{#if open}
				{#each s.relations as r (r.name)}
					{@const key = `${s.name}.${r.name}`}
					{@const Icon = icons[r.kind]}
					<button
						class="group flex h-7 w-full items-center gap-2 pr-2 pl-8 text-left transition-colors {active === key
							? 'bg-primary-soft text-foreground'
							: 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'}"
						title="{key} · {r.kind}"
						onclick={() => onopen(s.name, r)}
					>
						<Icon class="size-3.5 shrink-0 {active === key ? 'text-primary' : 'opacity-70'}" />
						<span class="truncate">{r.name}</span>
						{#if r.kind !== 'view'}
							<span class="ml-auto font-mono text-[10px] tabular-nums opacity-50">{compact(r.estimatedRows)}</span>
						{/if}
					</button>
				{:else}
					<p class="py-1 pl-9 text-[11px] text-muted-foreground/60 italic">empty</p>
				{/each}
			{/if}
		{/each}
		{#if tree && !schemas.length}
			<p class="px-3 py-4 text-center text-xs text-muted-foreground">No matches</p>
		{/if}
	</div>

	<label class="flex items-center gap-2 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
		<input type="checkbox" class="accent-[var(--primary)]" bind:checked={showSystem} />
		Show system schemas
	</label>
</div>
