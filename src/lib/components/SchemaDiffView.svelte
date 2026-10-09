<script lang="ts" module>
	export interface DiffSide {
		connectionName: string;
		label: string;
		at: string;
		bodiesOmitted: boolean;
		source: { kind: 'live' | 'snapshot' };
	}
</script>

<script lang="ts">
	import { ChevronRight, Copy, Download, FileCode2, CircleCheck, TriangleAlert } from '@lucide/svelte';
	import { OBJECT_LABELS, OBJECT_TYPES, type ObjectType } from '#lib/schema/model.ts';
	import type { DiffItem, SchemaDiff } from '#lib/schema/diff.ts';
	import { lineDiff } from '#lib/schema/text-diff.ts';
	import { download } from '#lib/client/format.ts';
	import { toast } from '#lib/client/state.svelte.ts';

	let { from, to, diff, migration }: { from: DiffSide; to: DiffSide; diff: SchemaDiff; migration: string | null } = $props();

	let schema = $state('');
	let typeFilter = $state<ObjectType | null>(null);
	let open = $state<Record<string, boolean>>({});
	let showSql = $state(false);

	const items = $derived(diff.items.filter((i) => (!schema || i.schema === schema || i.schema === null) && (!typeFilter || i.type === typeFilter)));
	const groups = $derived(OBJECT_TYPES.map((type) => ({ type, items: items.filter((i) => i.type === type) })).filter((g) => g.items.length));
	const changedTypes = $derived(OBJECT_TYPES.filter((t) => diff.summary[t].added + diff.summary[t].removed + diff.summary[t].changed));
	// Summary counts follow the schema filter, so "only changes in app" reads right.
	const counts = $derived.by(() => {
		const scoped = diff.items.filter((i) => !schema || i.schema === schema || i.schema === null);
		return Object.fromEntries(
			OBJECT_TYPES.map((t) => {
				const of = scoped.filter((i) => i.type === t);
				return [t, { added: of.filter((i) => i.change === 'added').length, removed: of.filter((i) => i.change === 'removed').length, changed: of.filter((i) => i.change === 'changed').length }];
			})
		) as SchemaDiff['summary'];
	});

	const CHANGE = {
		added: { label: 'Added', cls: 'badge-success', sign: '+' },
		removed: { label: 'Removed', cls: 'badge-danger', sign: '−' },
		changed: { label: 'Changed', cls: 'badge-warning', sign: '~' }
	} as const;

	const sideLabel = (s: DiffSide) => `${s.connectionName} · ${s.source.kind === 'live' ? 'live' : s.label}`;
	const hasText = (i: DiffItem) => i.type === 'view' || i.type === 'routine' || i.type === 'trigger' || i.type === 'type';
	const title = (i: DiffItem) => (i.type === 'trigger' ? `${i.schema}.${i.table} · ${i.name}` : i.schema && i.type !== 'schema' ? `${i.schema}.${i.name}` : i.name);
	const detailCount = (i: DiffItem) => i.details.length;

	function toggleAll(value: boolean) {
		open = value ? Object.fromEntries(items.map((i) => [`${i.type}:${i.key}`, true])) : {};
	}

	function copySql() {
		if (!migration) return;
		navigator.clipboard.writeText(migration);
		toast('success', 'Migration SQL copied');
	}
</script>

<div class="space-y-4">
	{#if diff.identical}
		<div class="flex items-center gap-3 rounded-xl border border-success/30 bg-success/5 px-4 py-3 text-[13px]">
			<CircleCheck class="size-4 text-success" />
			<span><b class="font-medium">No differences.</b> <span class="text-muted-foreground">{sideLabel(from)} and {sideLabel(to)} have the same schema.</span></span>
		</div>
	{:else}
		<!-- Summary: only object types that changed -->
		<div class="flex flex-wrap items-center gap-1.5">
			<button
				class="flex h-7 items-center gap-2 rounded-lg border px-2.5 text-xs {typeFilter === null ? 'border-primary/40 bg-primary-soft text-foreground' : 'border-border text-muted-foreground hover:text-foreground'}"
				onclick={() => (typeFilter = null)}
			>
				All
				<span class="font-mono text-[11px]">
					<span class="text-success">+{diff.total.added}</span> <span class="text-danger">−{diff.total.removed}</span> <span class="text-warning">~{diff.total.changed}</span>
				</span>
			</button>
			{#each changedTypes as t (t)}
				{@const c = counts[t]}
				<button
					class="flex h-7 items-center gap-2 rounded-lg border px-2.5 text-xs {typeFilter === t ? 'border-primary/40 bg-primary-soft text-foreground' : 'border-border text-muted-foreground hover:text-foreground'}"
					onclick={() => (typeFilter = typeFilter === t ? null : t)}
				>
					{OBJECT_LABELS[t]}
					<span class="font-mono text-[11px]">
						{#if c.added}<span class="text-success">+{c.added}</span>{/if}
						{#if c.removed}<span class="text-danger">−{c.removed}</span>{/if}
						{#if c.changed}<span class="text-warning">~{c.changed}</span>{/if}
						{#if !c.added && !c.removed && !c.changed}<span>0</span>{/if}
					</span>
				</button>
			{/each}
			<div class="ml-auto flex items-center gap-1.5">
				{#if diff.schemas.length > 1}
					<select class="input h-7 w-auto py-0 text-xs" bind:value={schema} aria-label="Filter by schema">
						<option value="">All schemas</option>
						{#each diff.schemas as s (s)}<option value={s}>{s}</option>{/each}
					</select>
				{/if}
				<button class="btn btn-ghost btn-sm" onclick={() => toggleAll(Object.keys(open).length === 0)}>{Object.keys(open).length ? 'Collapse all' : 'Expand all'}</button>
			</div>
		</div>

		{#if from.bodiesOmitted || to.bodiesOmitted}
			<p class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
				<TriangleAlert class="size-3.5 text-warning" />A snapshot was too large to keep function bodies; changed functions are detected by hash, without a text diff.
			</p>
		{/if}

		{#each groups as g (g.type)}
			<section>
				<h3 class="mb-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{OBJECT_LABELS[g.type]} <span class="font-normal normal-case">· {g.items.length}</span></h3>
				<div class="overflow-hidden rounded-xl border border-border bg-card">
					{#each g.items as item (item.key)}
						{@const k = `${item.type}:${item.key}`}
						{@const expandable = detailCount(item) > 0 || (hasText(item) && (item.before || item.after)) || item.bodyUnavailable}
						<div class="border-b border-border last:border-b-0">
							<button
								class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] hover:bg-accent/50 disabled:hover:bg-transparent"
								disabled={!expandable}
								onclick={() => (open[k] = !open[k])}
								aria-expanded={!!open[k]}
							>
								<ChevronRight class="size-3.5 shrink-0 text-muted-foreground transition-transform {open[k] ? 'rotate-90' : ''} {expandable ? '' : 'opacity-0'}" />
								<span class="badge {CHANGE[item.change].cls} w-16 justify-center">{CHANGE[item.change].label}</span>
								<span class="min-w-0 flex-1 truncate font-mono text-xs">{title(item)}</span>
								{#if item.type === 'table' && item.change === 'changed'}
									{@const cols = item.details.filter((d) => d.kind === 'column')}
									{@const other = item.details.length - cols.length}
									<span class="shrink-0 text-[11px] text-muted-foreground">
										{#if cols.length}{cols.length} column{cols.length === 1 ? '' : 's'}{/if}{#if cols.length && other}, {/if}{#if other}{other} other{/if}
									</span>
								{:else if item.type === 'extension' && item.change === 'changed'}
									<span class="shrink-0 font-mono text-[11px] text-muted-foreground">{item.before} → {item.after}</span>
								{/if}
							</button>
							{#if open[k] && expandable}
								<div class="space-y-3 border-t border-border bg-surface/50 px-3 py-3 pl-9">
									{#if item.details.length}
										<table class="w-full text-xs">
											<tbody>
												{#each item.details as d (`${d.kind}:${d.name}`)}
													<tr class="align-top">
														<td class="w-6 py-1 font-mono {d.change === 'added' ? 'text-success' : d.change === 'removed' ? 'text-danger' : 'text-warning'}">{CHANGE[d.change].sign}</td>
														<td class="w-24 py-1 text-muted-foreground">{d.kind}</td>
														<td class="w-48 py-1 pr-3 font-mono font-medium break-all">{d.name}</td>
														<td class="py-1 font-mono break-all">
															{#if d.fields?.length}
																{#each d.fields as f (f.field)}
																	<div><span class="text-muted-foreground">{f.field}:</span> <span class="text-danger line-through decoration-danger/50">{f.before ?? '∅'}</span> → <span class="text-success">{f.after ?? '∅'}</span></div>
																{/each}
															{:else if d.change === 'changed'}
																<div class="text-danger/90"><span class="select-none">− </span>{d.before ?? '∅'}</div>
																<div class="text-success"><span class="select-none">+ </span>{d.after ?? '∅'}</div>
															{:else}
																<span class={d.change === 'added' ? 'text-success' : 'text-danger/90'}>{d.after ?? d.before}</span>
															{/if}
														</td>
													</tr>
												{/each}
											</tbody>
										</table>
									{/if}
									{#if item.bodyUnavailable}
										<p class="text-[11px] text-muted-foreground">The definition changed (its hash differs), but one side didn't keep the text.</p>
									{:else if hasText(item) && (item.before || item.after)}
										<pre class="max-h-96 overflow-auto rounded-lg border border-border bg-background py-2 font-mono text-[11.5px] leading-[1.55]">{#each lineDiff(item.before, item.after) as l, i (i)}<div class="px-3 {l.op === 'add' ? 'bg-success/10 text-success' : l.op === 'del' ? 'bg-danger/10 text-danger' : 'text-muted-foreground'}"><span class="inline-block w-4 select-none opacity-70">{l.op === 'add' ? '+' : l.op === 'del' ? '−' : ' '}</span>{l.text || ' '}</div>{/each}</pre>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</section>
		{:else}
			<p class="py-6 text-center text-xs text-muted-foreground">No changes in this schema.</p>
		{/each}

		{#if migration}
			<section class="rounded-xl border border-border bg-card">
				<button class="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px]" onclick={() => (showSql = !showSql)} aria-expanded={showSql}>
					<ChevronRight class="size-3.5 text-muted-foreground transition-transform {showSql ? 'rotate-90' : ''}" />
					<FileCode2 class="size-4 text-primary" />
					<span class="font-medium">Draft migration SQL</span>
					<span class="badge badge-warning">best-effort</span>
					<span class="ml-auto text-[11px] text-muted-foreground">from {sideLabel(from)} to {sideLabel(to)}</span>
				</button>
				{#if showSql}
					<div class="border-t border-border p-3">
						<p class="mb-2 text-[11px] text-muted-foreground">
							Covers simple cases only (new tables, added/dropped columns, nullability, defaults, indexes). Drops are commented out; anything else is listed for you to
							handle by hand. Review it before running — nothing here runs automatically.
						</p>
						<pre class="max-h-96 overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-[11.5px] leading-[1.55]">{migration}</pre>
						<div class="mt-2 flex justify-end gap-1.5">
							<button class="btn btn-secondary btn-sm" onclick={() => download('migration.sql', migration!, 'application/sql')}><Download />Download</button>
							<button class="btn btn-secondary btn-sm" onclick={copySql}><Copy />Copy</button>
						</div>
					</div>
				{/if}
			</section>
		{/if}
	{/if}
</div>
