<script lang="ts">
	import { Container, FileCode2, Hand } from '@lucide/svelte';
	import type { ConnectionSource } from '#lib/types.ts';
	let { source }: { source: ConnectionSource } = $props();
</script>

<span class="badge" title={source.ref}>
	{#if source.kind === 'docker'}<Container />Docker{:else if source.kind === 'env'}<FileCode2 />.env{:else}<Hand />Manual{/if}
</span>
