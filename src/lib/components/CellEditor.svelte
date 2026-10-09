<script lang="ts" module>
	/** Saving this from a new row's cell puts the column back to its default. */
	export const DEFAULT_VALUE = Symbol('default');
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { Check, X } from '@lucide/svelte';
	import type { EditColumn } from '#lib/rows.ts';

	let {
		column,
		value,
		isNew = false,
		onsave,
		oncancel
	}: {
		column: EditColumn;
		value: unknown;
		/** Editing a row that isn't inserted yet (offers DEFAULT). */
		isNew?: boolean;
		onsave: (value: unknown) => void;
		oncancel: () => void;
	} = $props();

	const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
	const initialText = (v: unknown) => {
		if (v === null || v === undefined || typeof v === 'symbol') return '';
		if (column.kind === 'json') return JSON.stringify(v, null, 2);
		return typeof v === 'object' ? JSON.stringify(v) : String(v);
	};
	// Seed once from the value the cell had when editing started.
	// svelte-ignore state_referenced_locally
	let text = $state(initialText(value));
	let error = $state('');
	let root: HTMLDivElement;

	// svelte-ignore state_referenced_locally
	const multiline = column.kind === 'json' || (typeof value === 'string' && (value.includes('\n') || value.length > 80));

	onMount(() => {
		const el = root.querySelector<HTMLElement>('input, textarea, select, button[data-autofocus]');
		el?.focus();
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
	});

	function save() {
		error = '';
		if (column.kind === 'json') {
			try {
				onsave(JSON.parse(text));
			} catch {
				error = 'Not valid JSON';
			}
			return;
		}
		if (column.kind === 'number') {
			const t = text.trim();
			if (!NUMBER.test(t)) {
				error = 'Not a number';
				return;
			}
			// Keep numbers that came back as JS numbers as numbers (so unchanged values stay unchanged);
			// big or exact values stay text, so nothing loses precision.
			const n = Number(t);
			onsave(typeof value === 'number' && String(n) === t ? n : t);
			return;
		}
		onsave(text);
	}

	function onkeydown(e: KeyboardEvent) {
		// The grid handles arrows and Enter itself; keep them inside the editor.
		e.stopPropagation();
		if (e.key === 'Escape') {
			e.preventDefault();
			oncancel();
		} else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			save();
		}
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	bind:this={root}
	{onkeydown}
	onclick={(e) => e.stopPropagation()}
	ondblclick={(e) => e.stopPropagation()}
	class="absolute top-0 left-0 z-20 min-w-full rounded-md border border-primary bg-card p-1 font-sans text-[12px] text-foreground no-underline shadow-surface-lg {multiline ? 'w-96' : 'w-max'}"
>
	{#if column.kind === 'boolean'}
		<div class="flex items-center gap-1">
			<button class="btn btn-secondary btn-sm" data-autofocus onclick={() => onsave(true)}>true</button>
			<button class="btn btn-secondary btn-sm" onclick={() => onsave(false)}>false</button>
			{#if column.nullable}<button class="btn btn-ghost btn-sm italic" onclick={() => onsave(null)}>NULL</button>{/if}
			{#if isNew}<button class="btn btn-ghost btn-sm italic" onclick={() => onsave(DEFAULT_VALUE)}>DEFAULT</button>{/if}
			<button class="btn btn-ghost btn-icon btn-sm" aria-label="Cancel" onclick={oncancel}><X /></button>
		</div>
	{:else if column.kind === 'enum' && column.options}
		<div class="flex items-center gap-1">
			<select class="input h-7 w-48 py-0 font-mono text-xs" bind:value={text} onchange={save}>
				{#if !column.options.includes(text)}<option value={text}>{text || '—'}</option>{/if}
				{#each column.options as o (o)}<option value={o}>{o}</option>{/each}
			</select>
			{#if column.nullable}<button class="btn btn-ghost btn-sm italic" onclick={() => onsave(null)}>NULL</button>{/if}
			{#if isNew}<button class="btn btn-ghost btn-sm italic" onclick={() => onsave(DEFAULT_VALUE)}>DEFAULT</button>{/if}
			<button class="btn btn-ghost btn-icon btn-sm" aria-label="Cancel" onclick={oncancel}><X /></button>
		</div>
	{:else}
		{#if multiline}
			<textarea class="input h-40 w-full resize-y py-1.5 font-mono text-xs" spellcheck="false" bind:value={text}></textarea>
		{:else}
			<input
				class="input h-7 w-64 font-mono text-xs"
				spellcheck="false"
				inputmode={column.kind === 'number' ? 'decimal' : undefined}
				placeholder={column.kind === 'date' ? column.type : ''}
				bind:value={text}
			/>
		{/if}
		<div class="mt-1 flex items-center gap-1">
			{#if error}<span class="text-[11px] text-danger">{error}</span>{:else}<span class="font-mono text-[10px] text-muted-foreground">{column.type}</span>{/if}
			<span class="ml-auto"></span>
			{#if column.nullable}<button class="btn btn-ghost btn-sm italic" onclick={() => onsave(null)}>NULL</button>{/if}
			{#if isNew}<button class="btn btn-ghost btn-sm italic" onclick={() => onsave(DEFAULT_VALUE)}>DEFAULT</button>{/if}
			<button class="btn btn-ghost btn-icon btn-sm" aria-label="Cancel" title="Cancel (Esc)" onclick={oncancel}><X /></button>
			<button class="btn btn-primary btn-icon btn-sm" aria-label="Done" title={multiline ? 'Done (⌘↵)' : 'Done (↵)'} onclick={save}><Check /></button>
		</div>
	{/if}
</div>
