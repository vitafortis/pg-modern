<script lang="ts">
	import { Globe, Pencil, Play, Search, Trash2, Users } from '@lucide/svelte';
	import { errorMessage } from '#lib/client/api.ts';
	import { ago } from '#lib/client/format.ts';
	import { deleteSaved, matches, saved } from '#lib/client/saved.svelte.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';
	import type { SavedQuery } from '#lib/types.ts';

	let {
		activeId = null,
		onload,
		onrun,
		onedit
	}: {
		/** The saved query open in this tab, highlighted in the list. */
		activeId?: string | null;
		onload: (q: SavedQuery) => void;
		onrun: (q: SavedQuery) => void;
		onedit: (q: SavedQuery) => void;
	} = $props();

	let term = $state('');

	const filtered = $derived(saved.list.filter((q) => matches(q, term)));
	const groups = $derived([
		{ title: 'Mine', items: filtered.filter((q) => q.mine) },
		{ title: 'Shared with me', items: filtered.filter((q) => !q.mine) }
	]);

	async function remove(q: SavedQuery) {
		const ok = await confirmAction({
			title: `Delete “${q.name}”?`,
			body: q.shared ? 'It’s shared, so it disappears for everyone.' : undefined,
			detail: q.sql,
			confirmLabel: 'Delete',
			danger: true
		});
		if (!ok) return;
		try {
			await deleteSaved(q.id);
			toast('success', 'Saved query deleted', q.name);
		} catch (err) {
			toast('error', 'Could not delete', errorMessage(err));
		}
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="border-b border-border p-2">
		<div class="relative">
			<Search class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
			<input class="input h-8 pl-8 text-xs" placeholder="Search saved queries" bind:value={term} aria-label="Search saved queries" />
		</div>
	</div>
	<div class="min-h-0 flex-1 overflow-y-auto">
		{#each groups as g (g.title)}
			{#if g.items.length}
				<p class="sticky top-0 z-10 border-b border-border bg-surface/95 px-3 py-1.5 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase backdrop-blur">
					{g.title} <span class="font-normal opacity-70">{g.items.length}</span>
				</p>
				<div class="divide-y divide-border">
					{#each g.items as q (q.id)}
						<div class="group relative px-3 py-2 hover:bg-accent/50 {q.id === activeId ? 'bg-primary-soft' : ''}">
							{#if q.id === activeId}<span class="absolute inset-y-0 left-0 w-0.5 bg-primary"></span>{/if}
							<button class="block w-full text-left" onclick={() => onload(q)} title="Open in the editor">
								<span class="flex items-center gap-1.5 pr-16">
									<span class="truncate text-[12.5px] font-medium">{q.name}</span>
									{#if q.mine && q.shared}<Users class="size-3 shrink-0 text-primary" aria-label="Shared" />{/if}
									{#if !q.connectionId}<Globe class="size-3 shrink-0 text-muted-foreground" aria-label="Any connection" />{/if}
								</span>
								{#if q.description}<span class="mt-0.5 line-clamp-2 block text-[11px] text-muted-foreground">{q.description}</span>{/if}
								<pre class="mt-1 line-clamp-2 font-mono text-[10.5px] whitespace-pre-wrap text-muted-foreground/80">{q.sql}</pre>
								<span class="mt-1 block text-[10px] text-muted-foreground">
									{#if !q.mine}<span class="text-foreground/80">{q.ownerEmail}</span> · {/if}{ago(q.updatedAt)}
								</span>
							</button>
							<div class="absolute top-1.5 right-2 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
								<button class="btn btn-ghost btn-icon btn-sm size-6" title="Run" onclick={() => onrun(q)}><Play /></button>
								{#if q.canEdit}
									<button class="btn btn-ghost btn-icon btn-sm size-6" title="Edit details" onclick={() => onedit(q)}><Pencil /></button>
									<button class="btn btn-ghost btn-icon btn-sm size-6 hover:text-danger" title="Delete" onclick={() => remove(q)}><Trash2 /></button>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		{/each}
		{#if !filtered.length}
			<div class="p-6 text-center text-xs text-muted-foreground">
				{#if !saved.loaded}
					Loading…
				{:else if term}
					No saved query matches “{term}”.
				{:else}
					<p>No saved queries yet.</p>
					<p class="mt-2">Write a query and press <span class="kbd">⌘S</span> to keep it.</p>
				{/if}
			</div>
		{/if}
	</div>
</div>
