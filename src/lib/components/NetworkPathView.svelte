<script lang="ts">
	import { Network, Globe, Unplug, Copy, Check } from '@lucide/svelte';
	import { joinNetworksSnippet } from '#lib/client/format.ts';
	import type { NetworkPath } from '#lib/types.ts';

	let { path, reachable }: { path: NetworkPath; reachable?: boolean } = $props();

	let open = $state(false);
	let copied = $state(false);
	const snippet = $derived(path.join ? joinNetworksSnippet([path.join]) : '');

	async function copy() {
		await navigator.clipboard.writeText(snippet);
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}
</script>

<div class="mt-1.5 flex flex-wrap items-center gap-1 text-[11px]">
	{#if path.via === 'shared-network'}
		<span class="inline-flex items-center gap-1 text-success" title="pg·modern is attached to this network too, so it reaches the container by name">
			<Network class="size-3" />via
		</span>
	{:else if path.via === 'published-port'}
		<span class="inline-flex items-center gap-1 text-muted-foreground" title="Reached through a port published on the Docker host">
			<Globe class="size-3" />via
		</span>
		{#each path.published as p (`${p.host}:${p.port}`)}
			<span class="rounded-md border border-border bg-surface px-1.5 py-px font-mono">{p.host}:{p.port}</span>
		{/each}
		{#if path.networks.length}<span class="text-muted-foreground">· on</span>{/if}
	{:else if path.via === 'host-network'}
		<span class="inline-flex items-center gap-1 text-muted-foreground"><Globe class="size-3" />host networking</span>
	{:else}
		<span class="inline-flex items-center gap-1 text-warning" title="Not on a network pg·modern is attached to, and no port is published">
			<Unplug class="size-3" />no route · on
		</span>
	{/if}
	{#each path.networks.filter((n) => n !== 'host') as n (n)}
		<span
			class="rounded-md border px-1.5 py-px font-mono {path.shared.includes(n)
				? 'border-success/30 bg-success/10 text-success'
				: 'border-border text-muted-foreground'}"
			title={path.shared.includes(n) ? 'pg·modern is on this network' : 'pg·modern isn’t on this network'}>{n}</span
		>
	{/each}
	{#if path.via === 'none' && reachable !== true}
		<button class="ml-0.5 text-primary hover:underline" onclick={() => (open = !open)}>{open ? 'hide fix' : 'how to fix'}</button>
	{/if}
</div>
{#if open}
	<div class="mt-2 rounded-lg border border-border bg-surface p-2.5 text-[11px] text-muted-foreground">
		{#if path.join}
			<p>Attach pg·modern to <span class="font-mono text-foreground">{path.join}</span> in its compose file, then <span class="font-mono">docker compose up -d</span>:</p>
			<div class="relative mt-1.5">
				<pre class="overflow-x-auto rounded-md border border-border bg-background p-2 font-mono text-[11px] text-foreground">{snippet}</pre>
				<button class="btn btn-ghost btn-icon btn-sm absolute top-1 right-1" title="Copy" onclick={copy}>
					{#if copied}<Check />{:else}<Copy />{/if}
				</button>
			</div>
			<p class="mt-1.5">Or publish port <span class="font-mono">{path.publish}</span> on the database container (e.g. <span class="font-mono">"5433:{path.publish}"</span>).</p>
		{:else}
			<p>
				pg·modern doesn’t run on this Docker host, so it can only use published ports. Publish port
				<span class="font-mono text-foreground">{path.publish}</span> on the database container, e.g.
				<span class="font-mono text-foreground">ports: ["5433:{path.publish}"]</span>.
			</p>
		{/if}
	</div>
{/if}
