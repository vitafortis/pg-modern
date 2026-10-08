<script lang="ts">
	import { LoaderCircle } from '@lucide/svelte';
	import Logo from './Logo.svelte';

	let {
		title,
		subtitle,
		cta,
		confirm = false,
		onsubmit
	}: {
		title: string;
		subtitle: string;
		cta: string;
		confirm?: boolean;
		onsubmit: (password: string) => Promise<string | void>;
	} = $props();

	let password = $state('');
	let repeat = $state('');
	let error = $state('');
	let busy = $state(false);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		if (confirm && password !== repeat) {
			error = 'Passwords do not match';
			return;
		}
		busy = true;
		error = (await onsubmit(password)) ?? '';
		busy = false;
	}
</script>

<div class="relative grid min-h-dvh place-items-center overflow-hidden px-4">
	<div class="dot-grid mask-fade pointer-events-none absolute inset-0 opacity-70"></div>
	<div class="glow-top pointer-events-none absolute inset-x-0 top-0 h-[480px]"></div>

	<form onsubmit={submit} class="card relative w-full max-w-sm p-7 shadow-surface-lg">
		<div class="mb-6 flex flex-col items-center text-center">
			<Logo size={44} />
			<h1 class="mt-4 text-lg font-semibold tracking-tight">{title}</h1>
			<p class="mt-1 text-[13px] text-muted-foreground">{subtitle}</p>
		</div>
		<label class="label" for="pw">Password</label>
		<!-- svelte-ignore a11y_autofocus -->
		<input id="pw" class="input" type="password" autocomplete={confirm ? 'new-password' : 'current-password'} autofocus bind:value={password} required />
		{#if confirm}
			<label class="label mt-3" for="pw2">Repeat password</label>
			<input id="pw2" class="input" type="password" autocomplete="new-password" bind:value={repeat} required />
		{/if}
		{#if error}<p class="mt-3 text-xs text-danger">{error}</p>{/if}
		<button class="btn btn-primary mt-5 h-9 w-full" disabled={busy}>
			{#if busy}<LoaderCircle class="animate-spin" />{/if}{cta}
		</button>
	</form>
</div>
