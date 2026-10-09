<script lang="ts">
	import { Bookmark, ChevronDown, Globe, Search, Users } from '@lucide/svelte';
	import { loadSaved, matches, saved } from '#lib/client/saved.svelte.ts';
	import type { SavedQuery } from '#lib/types.ts';

	let { connectionId, onopen }: { connectionId: string; onopen: (q: SavedQuery) => void } = $props();

	let open = $state(false);
	let term = $state('');
	let root = $state<HTMLElement>();
	let search = $state<HTMLInputElement>();

	const filtered = $derived(saved.list.filter((q) => matches(q, term)));
	const groups = $derived([
		{ title: 'Mine', items: filtered.filter((q) => q.mine) },
		{ title: 'Shared with me', items: filtered.filter((q) => !q.mine) }
	]);

	function toggle() {
		open = !open;
		if (open) {
			term = '';
			loadSaved(connectionId).catch(() => {});
			queueMicrotask(() => search?.focus());
		}
	}

	function pick(q: SavedQuery) {
		open = false;
		onopen(q);
	}
</script>

<svelte:window
	onclick={(e) => open && !root?.contains(e.target as Node) && (open = false)}
	onkeydown={(e) => open && e.key === 'Escape' && (open = false)}
/>

<div class="relative" bind:this={root}>
	<button class="btn btn-secondary btn-sm" onclick={toggle} aria-expanded={open} aria-haspopup="menu" title="Open a saved query in a new tab">
		<Bookmark />Saved<ChevronDown class="-mr-0.5 opacity-60" />
	</button>
	{#if open}
		<div class="absolute top-full right-0 z-40 mt-1.5 flex max-h-[min(28rem,70vh)] w-96 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-surface-lg" role="menu">
			<div class="border-b border-border p-2">
				<div class="relative">
					<Search class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<input
						bind:this={search}
						class="input h-8 pl-8 text-xs"
						placeholder="Open a saved query…"
						bind:value={term}
						aria-label="Search saved queries"
						onkeydown={(e) => e.key === 'Enter' && filtered[0] && pick(filtered[0])}
					/>
				</div>
			</div>
			<div class="min-h-0 flex-1 overflow-y-auto p-1">
				{#each groups as g (g.title)}
					{#if g.items.length}
						<p class="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{g.title}</p>
						{#each g.items as q (q.id)}
							<button class="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left hover:bg-accent" role="menuitem" onclick={() => pick(q)}>
								<span class="min-w-0 flex-1">
									<span class="flex items-center gap-1.5">
										<span class="truncate text-[13px] font-medium">{q.name}</span>
										{#if q.mine && q.shared}<Users class="size-3 shrink-0 text-primary" aria-label="Shared" />{/if}
										{#if !q.connectionId}<Globe class="size-3 shrink-0 text-muted-foreground" aria-label="Any connection" />{/if}
									</span>
									<span class="block truncate font-mono text-[10.5px] text-muted-foreground">{q.description ?? q.sql.replace(/\s+/g, ' ')}</span>
								</span>
								{#if !q.mine}<span class="mt-0.5 max-w-32 shrink-0 truncate text-[10.5px] text-muted-foreground">{q.ownerEmail}</span>{/if}
							</button>
						{/each}
					{/if}
				{/each}
				{#if !filtered.length}
					<p class="px-3 py-6 text-center text-xs text-muted-foreground">
						{#if !saved.loaded}Loading…{:else if term}Nothing matches “{term}”.{:else}No saved queries yet — press <span class="kbd">⌘S</span> in a query tab.{/if}
					</p>
				{/if}
			</div>
		</div>
	{/if}
</div>
