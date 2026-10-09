<script lang="ts">
	import { Lock, LockOpen, PencilLine } from '@lucide/svelte';
	let { readOnly, unlocked = false }: { readOnly: boolean; unlocked?: boolean } = $props();
</script>

{#if readOnly}
	<span class="badge" title="Queries run in a READ ONLY transaction that is always rolled back"><Lock />Read-only</span>
{:else if unlocked}
	<span class="badge badge-warning" title="Write access was unlocked temporarily"><LockOpen />Unlocked</span>
{:else}
	<span class="badge badge-warning" title="Statements run with full write access"><PencilLine />Read/write</span>
{/if}
