<script lang="ts">
	import { Blocks, Boxes, Container, FileCode2, Hand } from '@lucide/svelte';
	import type { ConnectionSource } from '#lib/types.ts';
	let { source }: { source: ConnectionSource } = $props();
</script>

<span class="badge" title={source.ref}>
	{#if source.kind === 'docker'}<Container />Docker{:else if source.kind === 'env'}<FileCode2 />.env{:else if source.kind === 'arcane'}<Boxes />Arcane{:else if source.kind === 'terraform'}<Blocks />Terraform{:else}<Hand />Manual{/if}
</span>
