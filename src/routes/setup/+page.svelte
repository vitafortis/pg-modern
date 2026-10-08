<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import AuthCard from '#lib/components/AuthCard.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';

	async function setup(email: string, password: string) {
		try {
			await api.post('/api/auth/setup', { email, password });
			await invalidateAll();
			goto('/discover');
		} catch (err) {
			return errorMessage(err);
		}
	}
</script>

<svelte:head><title>Set up · pg·modern</title></svelte:head>

<AuthCard
	title="Set up pg·modern"
	subtitle="Create the first admin account. It guards every stored credential."
	cta="Create admin"
	confirm
	onsubmit={setup}
/>
