<script lang="ts">
	import { page } from '$app/state';
	import { goto, invalidateAll } from '$app/navigation';
	import AuthCard from '#lib/components/AuthCard.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';

	async function login(password: string) {
		try {
			await api.post('/api/auth/login', { password });
			const next = page.url.searchParams.get('next');
			await invalidateAll();
			goto(next?.startsWith('/') && !next.startsWith('//') ? next : '/');
		} catch (err) {
			return errorMessage(err);
		}
	}
</script>

<svelte:head><title>Sign in · pg·modern</title></svelte:head>

<AuthCard title="Welcome back" subtitle="Sign in to your database console." cta="Sign in" onsubmit={login} />
