<script lang="ts">
	import { Lock, PencilLine } from '@lucide/svelte';
	let { readOnly }: { readOnly: boolean } = $props();
</script>

{#if readOnly}
	<span class="badge" title="Queries run in a READ ONLY transaction that is always rolled back"><Lock />Read-only</span>
{:else}
	<span class="badge badge-warning" title="Statements run with full write access"><PencilLine />Read/write</span>
{/if}
