<script lang="ts">
	import { KeyRound, LoaderCircle, Link2 } from '@lucide/svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { bytes, int } from '#lib/client/format.ts';
	import type { ColumnInfo } from '#lib/types.ts';

	type Structure = {
		kind: string;
		estimatedRows: number;
		totalBytes: number | null;
		tableBytes: number | null;
		indexBytes: number | null;
		comment: string | null;
		owner: string;
		/** MySQL / MariaDB: InnoDB, MyISAM, … */
		storageEngine?: string | null;
		viewDefinition: string | null;
		columns: ColumnInfo[];
		indexes: { name: string; def: string; primary: boolean; unique: boolean; size: number | null }[];
		constraints: { name: string; type: string; def: string }[];
		referencedBy: { name: string; from_schema: string; from_table: string; def: string }[];
		triggers: { name: string; def: string; enabled: boolean }[];
	};

	let { connectionId, schema, table }: { connectionId: string; schema: string; table: string } = $props();
	let data = $state<Structure | null>(null);
	let error = $state('');

	$effect(() => {
		data = null;
		error = '';
		api
			.get<Structure>(`/api/connections/${connectionId}/structure?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`)
			.then((d) => (data = d))
			.catch((e) => (error = errorMessage(e)));
	});
</script>

<div class="h-full overflow-y-auto">
	{#if error}
		<div class="m-4 rounded-lg border border-danger/30 bg-danger/5 p-3 font-mono text-xs text-danger">{error}</div>
	{:else if !data}
		<div class="grid h-40 place-items-center"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
	{:else}
		<div class="space-y-6 p-5">
			<div class="grid grid-cols-2 gap-3 lg:grid-cols-5">
				{#each [['Kind', data.kind], ['Rows (est.)', int(data.estimatedRows)], ['Total size', bytes(data.totalBytes)], ['Indexes', bytes(data.indexBytes)], data.storageEngine !== undefined ? (data.kind === 'view' ? ['Definer', data.owner || '—'] : ['Engine', data.storageEngine ?? '—']) : ['Owner', data.owner]] as [k, v] (k)}
					<div class="card px-3 py-2.5">
						<p class="text-[11px] text-muted-foreground">{k}</p>
						<p class="mt-0.5 truncate text-sm font-medium">{v}</p>
					</div>
				{/each}
			</div>
			{#if data.comment}<p class="text-sm text-muted-foreground">{data.comment}</p>{/if}

			<section>
				<h3 class="mb-2 text-[13px] font-semibold">Columns <span class="font-normal text-muted-foreground">{data.columns.length}</span></h3>
				<div class="card overflow-hidden">
					<table class="w-full text-left text-[13px]">
						<thead class="border-b border-border bg-surface text-[11px] text-muted-foreground">
							<tr><th class="px-3 py-2 font-medium">Name</th><th class="px-3 py-2 font-medium">Type</th><th class="px-3 py-2 font-medium">Nullable</th><th class="px-3 py-2 font-medium">Default</th><th class="px-3 py-2 font-medium">Comment</th></tr>
						</thead>
						<tbody class="divide-y divide-border">
							{#each data.columns as c (c.name)}
								<tr class="hover:bg-accent/30">
									<td class="px-3 py-1.5 font-mono text-xs font-medium">
										<span class="inline-flex items-center gap-1.5">{#if c.isPrimaryKey}<KeyRound class="size-3 text-warning" />{/if}{c.name}</span>
									</td>
									<td class="px-3 py-1.5 font-mono text-xs text-[var(--syntax-type)]">{c.type}</td>
									<td class="px-3 py-1.5 text-xs">{#if c.nullable}<span class="text-muted-foreground">yes</span>{:else}<span class="badge">not null</span>{/if}</td>
									<td class="max-w-64 truncate px-3 py-1.5 font-mono text-xs text-muted-foreground" title={c.default ?? ''}>{c.default ?? ''}</td>
									<td class="px-3 py-1.5 text-xs text-muted-foreground">{c.comment ?? ''}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>

			{#if data.indexes.length}
				<section>
					<h3 class="mb-2 text-[13px] font-semibold">Indexes <span class="font-normal text-muted-foreground">{data.indexes.length}</span></h3>
					<div class="card divide-y divide-border">
						{#each data.indexes as ix (ix.name)}
							<div class="flex items-center gap-3 px-3 py-2">
								<span class="w-48 shrink-0 truncate font-mono text-xs font-medium">{ix.name}</span>
								{#if ix.primary}<span class="badge badge-warning">primary</span>{:else if ix.unique}<span class="badge badge-primary">unique</span>{/if}
								<code class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={ix.def}>{ix.def.replace(/^CREATE (UNIQUE )?INDEX \S+ ON /, '')}</code>
								<span class="text-[11px] text-muted-foreground tabular-nums">{bytes(ix.size)}</span>
							</div>
						{/each}
					</div>
				</section>
			{/if}

			{#if data.constraints.length}
				<section>
					<h3 class="mb-2 text-[13px] font-semibold">Constraints</h3>
					<div class="card divide-y divide-border">
						{#each data.constraints as c (c.name)}
							<div class="flex items-center gap-3 px-3 py-2">
								<span class="w-48 shrink-0 truncate font-mono text-xs font-medium">{c.name}</span>
								<span class="badge w-20 justify-center">{c.type}</span>
								<code class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={c.def}>{c.def}</code>
							</div>
						{/each}
					</div>
				</section>
			{/if}

			{#if data.referencedBy.length}
				<section>
					<h3 class="mb-2 text-[13px] font-semibold">Referenced by</h3>
					<div class="card divide-y divide-border">
						{#each data.referencedBy as r (r.name)}
							<div class="flex items-center gap-3 px-3 py-2">
								<Link2 class="size-3.5 text-muted-foreground" />
								<span class="font-mono text-xs font-medium">{r.from_schema}.{r.from_table}</span>
								<code class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{r.def}</code>
							</div>
						{/each}
					</div>
				</section>
			{/if}

			{#if data.triggers.length}
				<section>
					<h3 class="mb-2 text-[13px] font-semibold">Triggers</h3>
					<div class="card divide-y divide-border">
						{#each data.triggers as t (t.name)}
							<div class="flex items-center gap-3 px-3 py-2">
								<span class="w-48 shrink-0 truncate font-mono text-xs font-medium">{t.name}</span>
								{#if !t.enabled}<span class="badge">disabled</span>{/if}
								<code class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={t.def}>{t.def}</code>
							</div>
						{/each}
					</div>
				</section>
			{/if}

			{#if data.viewDefinition}
				<section>
					<h3 class="mb-2 text-[13px] font-semibold">Definition</h3>
					<pre class="card overflow-x-auto p-4 font-mono text-xs leading-relaxed">{data.viewDefinition}</pre>
				</section>
			{/if}
		</div>
	{/if}
</div>
