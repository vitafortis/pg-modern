<script lang="ts">
	import { CircleAlert, KeyRound, Check } from '@lucide/svelte';
	import Switch from './Switch.svelte';
	import type { Candidate } from '#lib/types.ts';

	export interface Choice {
		selected: boolean;
		name: string;
		address: number;
		readOnly: boolean;
		password: string;
	}

	let { candidate, choice = $bindable() }: { candidate: Candidate; choice: Choice } = $props();

	const addresses = $derived([
		{ host: candidate.host, port: candidate.port, label: candidate.reachable ? 'reachable' : 'primary' },
		...(candidate.alternates ?? [])
	]);
</script>

<div
	class="grid grid-cols-[auto_minmax(0,1.3fr)_minmax(0,1.2fr)_auto] items-start gap-3 px-4 py-3 transition-colors {choice.selected
		? 'bg-primary-soft/40'
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
			{#if candidate.existingId}
				<a class="badge badge-primary" href="/c/{candidate.existingId}"><Check />already saved</a>
			{/if}
		</div>
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
