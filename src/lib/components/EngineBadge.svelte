<script lang="ts">
	import { engineLabel } from '#lib/engine.ts';
	import type { Engine, Flavor } from '#lib/types.ts';

	let {
		engine,
		flavor = null,
		version,
		variant = 'badge'
	}: {
		engine: Engine;
		flavor?: Flavor | null;
		/** Shown after the name, e.g. `17.2`. */
		version?: string;
		/** `badge`: labelled pill; `tag`: a tiny lower-case mono tag for dense lists. */
		variant?: 'badge' | 'tag';
	} = $props();

	const label = $derived(engineLabel(engine, flavor));
	const kind = $derived(engine === 'postgres' ? 'postgres' : flavor === 'mariadb' ? 'mariadb' : 'mysql');
	const short = { postgres: 'pg', mysql: 'my', mariadb: 'ma' };
</script>

{#if variant === 'tag'}
	<span class="engine-tag engine-{kind}" title={label}>{short[kind]}</span>
{:else}
	<span class="badge" title="{label}{version ? ` ${version}` : ''}">
		<span class="engine-dot engine-{kind}"></span>{label}{#if version}<span class="font-mono font-normal opacity-80">{version}</span>{/if}
	</span>
{/if}

<style>
	.engine-postgres {
		--engine: oklch(62% 0.13 250);
	}
	.engine-mysql {
		--engine: oklch(70% 0.15 60);
	}
	.engine-mariadb {
		--engine: oklch(64% 0.09 45);
	}
	.engine-dot {
		width: 6px;
		height: 6px;
		border-radius: 9999px;
		background: var(--engine);
		flex-shrink: 0;
	}
	.engine-tag {
		font-family: var(--font-mono);
		font-size: 9.5px;
		line-height: 1;
		padding: 2px 3px;
		border-radius: 4px;
		color: var(--engine);
		background: color-mix(in oklch, var(--engine) 12%, transparent);
		flex-shrink: 0;
	}
</style>
