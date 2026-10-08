<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { goto, invalidateAll } from '$app/navigation';
	import { KeyRound, LoaderCircle, Lock, Save, Sparkles, UserRound } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import Logo from '#lib/components/Logo.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const welcome = $derived(page.url.searchParams.has('welcome') || data.user.needsProfile);
	// Seed the form once; it shouldn't reset when page data refreshes.
	let name = $state(untrack(() => data.user.name ?? ''));
	let email = $state(untrack(() => (data.user.email.includes('@') ? data.user.email : '')));
	let currentPassword = $state('');
	let newPassword = $state('');
	let repeat = $state('');
	let busy = $state(false);
	let error = $state('');

	async function saveProfile(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		if (newPassword && newPassword !== repeat) {
			error = 'New passwords do not match';
			return;
		}
		busy = true;
		try {
			await api.put('/api/account', {
				name,
				email: data.user.sso ? undefined : email,
				currentPassword: currentPassword || undefined,
				newPassword: newPassword || undefined
			});
			currentPassword = newPassword = repeat = '';
			await invalidateAll();
			if (welcome) {
				toast('success', 'You’re all set', 'Next time, sign in with your email.');
				goto('/');
			} else {
				toast('success', 'Account updated');
			}
		} catch (err) {
			error = errorMessage(err);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>{welcome ? 'Finish setting up' : 'My account'} · pg·modern</title></svelte:head>

{#if welcome}
	<div class="relative grid min-h-dvh place-items-center overflow-y-auto px-4 py-10">
		<div class="dot-grid mask-fade pointer-events-none absolute inset-0 opacity-70"></div>
		<div class="glow-top pointer-events-none absolute inset-x-0 top-0 h-[420px]"></div>
		<form onsubmit={saveProfile} class="card relative w-full max-w-md p-7 shadow-surface-lg">
			<div class="mb-6 flex flex-col items-center text-center">
				<Logo size={44} />
				<h1 class="mt-4 text-lg font-semibold tracking-tight">Finish setting up your account</h1>
				<p class="mt-1.5 text-[13px] text-muted-foreground">
					pg·modern now has user accounts. Your existing password was kept on the account
					<code class="font-mono text-foreground">{data.user.email}</code> — add your name and email so you can sign in with them from now on.
				</p>
			</div>
			<label class="label" for="a-name">Your name</label>
			<!-- svelte-ignore a11y_autofocus -->
			<input id="a-name" class="input" autocomplete="name" autofocus bind:value={name} />
			<label class="label mt-3" for="a-email">Email</label>
			<input id="a-email" class="input" type="email" autocomplete="email" required bind:value={email} />
			<p class="mt-1.5 text-[11px] text-muted-foreground">Also used to match your account if you turn on single sign-on later.</p>
			<details class="mt-4">
				<summary class="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">Change your password too</summary>
				<div class="mt-3 space-y-3">
					<input class="input" type="password" placeholder="Current password" autocomplete="current-password" bind:value={currentPassword} />
					<input class="input" type="password" placeholder="New password (8+ characters)" autocomplete="new-password" bind:value={newPassword} />
					<input class="input" type="password" placeholder="Repeat new password" autocomplete="new-password" bind:value={repeat} />
				</div>
			</details>
			{#if error}<p class="mt-3 text-xs text-danger">{error}</p>{/if}
			<button class="btn btn-primary mt-5 h-9 w-full" disabled={busy}>
				{#if busy}<LoaderCircle class="animate-spin" />{:else}<Sparkles />{/if}Continue
			</button>
		</form>
	</div>
{:else}
	<div class="h-full overflow-y-auto">
		<PageHeader title="My account" description="Your profile and how you sign in." />
		<form class="max-w-2xl space-y-5 px-8 pb-10" onsubmit={saveProfile}>
			<section class="card p-5">
				<h2 class="flex items-center gap-2 text-[14px] font-semibold"><UserRound class="size-4 text-primary" />Profile</h2>
				<div class="mt-4 grid gap-3 sm:grid-cols-2">
					<div>
						<label class="label" for="p-name">Name</label>
						<input id="p-name" class="input" autocomplete="name" bind:value={name} />
					</div>
					<div>
						<label class="label" for="p-email">Email</label>
						<input id="p-email" class="input" type="email" autocomplete="email" disabled={data.user.sso} bind:value={email} />
						{#if data.user.sso}<p class="mt-1 text-[11px] text-muted-foreground">Managed by your identity provider.</p>{/if}
					</div>
				</div>
				<div class="mt-4 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
					Role <span class="badge capitalize">{data.user.role}</span>
					<span class="ml-2">Sign-in</span>
					{#if data.user.sso}<span class="badge badge-primary"><KeyRound />SSO</span>{/if}
					{#if data.user.hasPassword}<span class="badge"><Lock />Password</span>{/if}
				</div>
			</section>

			<section class="card p-5">
				<h2 class="flex items-center gap-2 text-[14px] font-semibold"><Lock class="size-4 text-primary" />{data.user.hasPassword ? 'Change password' : 'Set a password'}</h2>
				{#if !data.user.hasPassword}
					<p class="mt-1 text-xs text-muted-foreground">Optional — lets you sign in without single sign-on.</p>
				{/if}
				<div class="mt-4 grid gap-3 sm:grid-cols-3">
					{#if data.user.hasPassword}
						<input class="input" type="password" placeholder="Current password" autocomplete="current-password" bind:value={currentPassword} />
					{/if}
					<input class="input" type="password" placeholder="New password" autocomplete="new-password" bind:value={newPassword} />
					<input class="input" type="password" placeholder="Repeat new password" autocomplete="new-password" bind:value={repeat} />
				</div>
			</section>

			{#if error}<p class="text-xs text-danger">{error}</p>{/if}
			<div class="flex justify-end">
				<button class="btn btn-primary" disabled={busy}>{#if busy}<LoaderCircle class="animate-spin" />{:else}<Save />{/if}Save</button>
			</div>
		</form>
	</div>
{/if}
