<script lang="ts">
	import { untrack } from 'svelte';
	import { Database, Globe, Users } from '@lucide/svelte';
	import Dialog from './Dialog.svelte';
	import Switch from './Switch.svelte';
	import { errorMessage } from '#lib/client/api.ts';
	import { createSaved, updateSaved } from '#lib/client/saved.svelte.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import type { SavedQuery } from '#lib/types.ts';

	let {
		open = $bindable(false),
		connectionId,
		connectionName,
		sql,
		existing = null,
		mode = 'save',
		onsaved
	}: {
		open: boolean;
		connectionId: string;
		connectionName: string;
		/** The SQL to save (ignored when editing details from the saved list). */
		sql: string;
		/** The saved query this tab came from, or the one being edited. */
		existing?: SavedQuery | null;
		/** `save`: save the editor's SQL; `edit`: change a saved query's details only. */
		mode?: 'save' | 'edit';
		onsaved?: (q: SavedQuery) => void;
	} = $props();

	let name = $state('');
	let description = $state('');
	let scope = $state<'connection' | 'any'>('connection');
	let shared = $state(false);
	let busy = $state(false);
	let nameInput = $state<HTMLInputElement>();

	const canUpdate = $derived(!!existing?.canEdit);

	// Fill the form each time the dialog opens.
	$effect(() => {
		if (!open) return;
		untrack(() => {
			name = existing?.name ?? '';
			description = existing?.description ?? '';
			scope = existing && !existing.connectionId ? 'any' : 'connection';
			shared = existing?.shared ?? false;
		});
		queueMicrotask(() => nameInput?.select());
	});

	async function submit(asNew: boolean) {
		if (!name.trim() || busy) return;
		busy = true;
		const input = {
			name: name.trim(),
			description: description.trim() || null,
			sql: mode === 'edit' && existing ? existing.sql : sql,
			connectionId: scope === 'connection' ? connectionId : null,
			shared
		};
		try {
			const q = !asNew && existing && canUpdate ? await updateSaved(existing.id, input) : await createSaved(input);
			toast('success', !asNew && existing && canUpdate ? 'Saved query updated' : 'Query saved', q.name);
			onsaved?.(q);
			open = false;
		} catch (err) {
			toast('error', 'Could not save the query', errorMessage(err));
		} finally {
			busy = false;
		}
	}
</script>

<Dialog
	bind:open
	title={mode === 'edit' ? 'Edit saved query' : existing && canUpdate ? 'Save query' : 'Save as a new query'}
	description={mode === 'edit' ? undefined : 'Saved queries are just text — they run with your usual access.'}
	width="max-w-md"
>
	<form
		id="save-query-form"
		class="space-y-4"
		onsubmit={(e) => {
			e.preventDefault();
			submit(false);
		}}
	>
		{#if existing && !canUpdate}
			<p class="rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted-foreground">
				This is <span class="text-foreground">{existing.ownerEmail}</span>’s shared query. Saving makes your own copy.
			</p>
		{/if}
		<div>
			<label class="label" for="sq-name">Name</label>
			<input id="sq-name" class="input" bind:this={nameInput} bind:value={name} placeholder="e.g. Biggest tables" maxlength="120" required />
		</div>
		<div>
			<label class="label" for="sq-desc">Description <span class="font-normal opacity-70">(optional)</span></label>
			<textarea id="sq-desc" class="input h-auto min-h-16 py-2" rows="2" bind:value={description} placeholder="What it's for, when to run it"></textarea>
		</div>
		<fieldset>
			<legend class="label">Use it on</legend>
			<div class="grid grid-cols-2 gap-2">
				{#each [{ value: 'connection', icon: Database, title: 'This connection', body: connectionName }, { value: 'any', icon: Globe, title: 'Any connection', body: 'Shows up everywhere' }] as const as o (o.value)}
					<label
						class="flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 transition-colors {scope === o.value
							? 'border-primary bg-primary-soft'
							: 'border-border hover:border-primary/30'}"
					>
						<input type="radio" class="sr-only" name="sq-scope" value={o.value} bind:group={scope} />
						<o.icon class="mt-0.5 size-4 shrink-0 {scope === o.value ? 'text-primary' : 'text-muted-foreground'}" />
						<span class="min-w-0">
							<span class="block text-[13px] font-medium">{o.title}</span>
							<span class="block truncate text-[11px] text-muted-foreground">{o.body}</span>
						</span>
					</label>
				{/each}
			</div>
		</fieldset>
		<div class="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
			<div class="flex gap-2.5">
				<Users class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
				<div>
					<p class="text-[13px] font-medium">Share with others</p>
					<p class="mt-0.5 text-[11px] text-muted-foreground">
						Everyone who can see {scope === 'connection' ? connectionName : 'a connection'} can find and run it. Only you and admins can change it.
					</p>
				</div>
			</div>
			<Switch bind:checked={shared} label="Share with others" />
		</div>
	</form>
	{#snippet footer()}
		<button class="btn btn-ghost" type="button" onclick={() => (open = false)}>Cancel</button>
		{#if mode === 'save' && existing && canUpdate}
			<button class="btn btn-secondary" type="button" disabled={busy || !name.trim()} onclick={() => submit(true)}>Save as new</button>
		{/if}
		<button class="btn btn-primary" type="submit" form="save-query-form" disabled={busy || !name.trim()}>
			{mode === 'edit' || (existing && canUpdate) ? 'Save' : 'Save query'}
		</button>
	{/snippet}
</Dialog>
