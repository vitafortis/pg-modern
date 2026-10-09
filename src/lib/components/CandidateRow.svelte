<script lang="ts">
	import { CircleAlert, KeyRound, Check, RefreshCw, ArrowRight } from '@lucide/svelte';
	import Switch from './Switch.svelte';
	import type { Candidate } from '#lib/types.ts';

	export interface Choice {
		selected: boolean;
		name: string;
		address: number;
		readOnly: boolean;
		password: string;
	}

	let {
		candidate,
		choice = $bindable(),
		onrelink
	}: {
		candidate: Candidate;
		choice: Choice;
		/** Updates the matching saved connection to the selected address. */
		onrelink?: (address: { host: string; port: number }) => Promise<void>;
	} = $props();

	let relinking = $state(false);

	async function relink() {
		if (!onrelink) return;
		relinking = true;
		try {
			await onrelink(chosen);
		} finally {
			relinking = false;
		}
	}

	const addresses = $derived([
		{ host: candidate.host, port: candidate.port, label: candidate.reachable ? 'reachable' : 'primary' },
		...(candidate.alternates ?? [])
	]);
	const chosen = $derived(addresses[choice.address] ?? addresses[0]);
</script>

<div
	class="relative grid grid-cols-[auto_minmax(0,1.3fr)_minmax(0,1.2fr)_auto] items-start gap-3 px-4 py-3 transition-colors {choice.selected
		? 'bg-primary-soft/40'
		: candidate.saved && !candidate.saved.addressChanged
			? 'bg-success/[0.04]'
			: ''}"
>
	<input
		type="checkbox"
		class="mt-2.5 size-4 accent-[var(--primary)]"
		bind:checked={choice.selected}
		aria-label="Select {candidate.name}"
	/>

	<div class="min-w-0">
		<input class="input h-8 text-[13px] font-medium" bind:value={choice.name} />
		<p class="mt-1.5 truncate font-mono text-[11px] text-muted-foreground" title="{candidate.user}@…/{candidate.database}">
			{candidate.user} · {candidate.database}
		</p>
	</div>

	<div class="min-w-0">
		<select class="input h-8 font-mono text-xs" bind:value={choice.address}>
			{#each addresses as a, i (i)}
				<option value={i}>{a.host}:{a.port} — {a.label}</option>
			{/each}
		</select>
		<div class="mt-1.5 flex flex-wrap items-center gap-1.5">
			{#if candidate.reachable === true}
				<span class="badge badge-success"><span class="size-1.5 rounded-full bg-success"></span>reachable</span>
			{:else if candidate.reachable === false}
				<span class="badge"><span class="size-1.5 rounded-full bg-muted-foreground/50"></span>not reachable</span>
			{/if}
			{#if candidate.hasPassword}
				<span class="badge"><KeyRound />password found</span>
			{/if}
			{#if candidate.saved && !candidate.saved.addressChanged}
				<a class="badge badge-success" href="/c/{candidate.saved.id}" title="Open the saved connection"><Check />saved as {candidate.saved.name}</a>
			{/if}
		</div>
		{#if candidate.saved?.addressChanged}
			<div class="mt-2 rounded-lg border border-warning/30 bg-warning/5 px-2.5 py-2 text-[11px]">
				<p class="text-foreground">
					Saved as <a class="font-medium text-primary hover:underline" href="/c/{candidate.saved.id}">{candidate.saved.name}</a>
					on <span class="font-mono">{candidate.saved.host}:{candidate.saved.port}</span>{candidate.reachable ? ', but this scan reaches it elsewhere.' : '.'}
				</p>
				{#if onrelink}
					<button class="btn btn-secondary btn-sm mt-1.5" disabled={relinking} onclick={relink}>
						<RefreshCw class={relinking ? 'animate-spin' : ''} />Use <span class="font-mono">{chosen.host}:{chosen.port}</span><ArrowRight class="opacity-50" />saved connection
					</button>
				{/if}
			</div>
		{/if}
		{#if !candidate.hasPassword && choice.selected}
			<input class="input mt-2 h-8 font-mono text-xs" type="password" placeholder="Password (optional)" bind:value={choice.password} />
		{/if}
		{#each candidate.notes as note (note)}
			<p class="mt-1.5 flex items-start gap-1 text-[11px] text-warning"><CircleAlert class="mt-px size-3 shrink-0" />{note}</p>
		{/each}
	</div>

	<label class="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground" title="Import as read-only">
		<Switch bind:checked={choice.readOnly} label="Read-only" />
		RO
	</label>
</div>
