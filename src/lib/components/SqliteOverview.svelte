<script lang="ts">
	import { Database, FileStack, HardDrive, Layers, LoaderCircle, ShieldCheck, Table2, FileText } from '@lucide/svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { bytes, compact, int } from '#lib/client/format.ts';
	import type { SqliteSnapshot } from '#lib/types.ts';

	type Overview = {
		version: string;
		serverVersion: string;
		path: string;
		app: string | null;
		snapshot: SqliteSnapshot | null;
		fileBytes: number;
		walBytes: number;
		databaseBytes: number;
		pageSize: number;
		pageCount: number;
		freelistCount: number;
		journalMode: string;
		encoding: string;
		userVersion: number;
		applicationId: number;
		autoVacuum: string;
		counts: { tables: number; views: number; indexes: number; triggers: number };
		sizesKnown: boolean;
		rowsExact: boolean;
		largestTables: { schema: string; name: string; sizeBytes: number; estimatedRows: number }[];
	};

	let { connectionId, readOnly, onopen }: { connectionId: string; readOnly: boolean; onopen: (schema: string, table: string) => void } = $props();
	let data = $state<Overview | null>(null);
	let error = $state('');

	$effect(() => {
		data = null;
		error = '';
		api
			.get<Overview>(`/api/connections/${connectionId}/overview`)
			.then((d) => (data = d))
			.catch((e) => (error = errorMessage(e)));
	});

	const maxTable = $derived(Math.max(1, ...(data?.largestTables.map((t) => (data!.sizesKnown ? t.sizeBytes : t.estimatedRows)) ?? [1])));
</script>

<div class="h-full overflow-y-auto">
	{#if error}
		<div class="m-5 rounded-xl border border-danger/30 bg-danger/5 p-4">
			<p class="text-[13px] font-medium">Could not open the database</p>
			<p class="mt-1 font-mono text-xs text-muted-foreground">{error}</p>
		</div>
	{:else if !data}
		<div class="grid h-60 place-items-center"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
	{:else}
		<div class="space-y-5 p-5">
			<div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
				{#each [{ icon: Database, label: data.app ? `SQLite · ${data.app}` : 'SQLite', value: data.serverVersion, sub: `${data.journalMode.toUpperCase()} journal · ${data.encoding}` }, { icon: HardDrive, label: 'File size', value: bytes(data.fileBytes), sub: data.walBytes ? `+ ${bytes(data.walBytes)} in -wal` : `${int(data.pageCount)} pages of ${bytes(data.pageSize)}` }, { icon: Table2, label: 'Tables', value: int(data.counts.tables), sub: `${data.counts.views} views · ${data.counts.indexes} indexes · ${data.counts.triggers} triggers` }, { icon: Layers, label: 'Free pages', value: int(data.freelistCount), sub: data.freelistCount && data.pageCount ? `${bytes(data.freelistCount * data.pageSize)} reclaimable by VACUUM` : 'nothing to reclaim' }] as s (s.label)}
					<div class="card p-4">
						<div class="flex items-center gap-2 text-xs text-muted-foreground"><s.icon class="size-3.5 text-primary" />{s.label}</div>
						<p class="mt-2 text-xl font-semibold tracking-tight tabular-nums">{s.value}</p>
						<p class="mt-0.5 truncate text-[11px] text-muted-foreground">{s.sub}</p>
					</div>
				{/each}
			</div>

			<div class="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
				<section class="card p-4">
					<h3 class="mb-3 flex items-center gap-2 text-[13px] font-semibold">
						<Table2 class="size-4 text-primary" />Largest tables
						{#if !data.sizesKnown}<span class="font-normal text-muted-foreground">by rows{data.rowsExact ? '' : ' (estimates from sqlite_stat1)'}</span>{/if}
					</h3>
					<div class="space-y-1">
						{#each data.largestTables as t (t.name)}
							<button class="group relative block w-full overflow-hidden rounded-md px-2 py-1.5 text-left hover:bg-accent/50" onclick={() => onopen(t.schema, t.name)}>
								<div class="absolute inset-y-0 left-0 rounded-md bg-primary-soft" style="width:{((data.sizesKnown ? t.sizeBytes : t.estimatedRows) / maxTable) * 100}%"></div>
								<div class="relative flex items-center gap-3 text-[13px]">
									<span class="truncate font-mono text-xs">{t.name}</span>
									<span class="ml-auto text-[11px] text-muted-foreground tabular-nums">{compact(t.estimatedRows)} rows</span>
									{#if data.sizesKnown}<span class="w-16 text-right text-[11px] font-medium tabular-nums">{bytes(t.sizeBytes)}</span>{/if}
								</div>
							</button>
						{:else}
							<p class="text-xs text-muted-foreground">No tables yet.</p>
						{/each}
					</div>
				</section>

				<div class="space-y-5">
					<section class="card p-4">
						<h3 class="mb-3 flex items-center gap-2 text-[13px] font-semibold"><FileText class="size-4 text-primary" />File</h3>
						<dl class="space-y-2 text-[13px]">
							<div class="flex items-start justify-between gap-3"><dt class="shrink-0 text-muted-foreground">{data.snapshot ? 'In container' : 'Path'}</dt><dd class="min-w-0 font-mono text-xs break-all">{data.snapshot ? `${data.snapshot.container}:${data.snapshot.containerPath}` : data.path}</dd></div>
							<div class="flex items-center justify-between"><dt class="text-muted-foreground">Page size</dt><dd class="font-mono text-xs">{bytes(data.pageSize)}</dd></div>
							<div class="flex items-center justify-between"><dt class="text-muted-foreground">Journal mode</dt><dd class="font-mono text-xs">{data.journalMode}</dd></div>
							<div class="flex items-center justify-between"><dt class="text-muted-foreground">Auto-vacuum</dt><dd class="font-mono text-xs">{data.autoVacuum}</dd></div>
							<div class="flex items-center justify-between"><dt class="text-muted-foreground">user_version</dt><dd class="font-mono text-xs">{data.userVersion}</dd></div>
							{#if data.applicationId}<div class="flex items-center justify-between"><dt class="text-muted-foreground">application_id</dt><dd class="font-mono text-xs">{data.applicationId}</dd></div>{/if}
						</dl>
					</section>
					<section class="card p-4">
						<h3 class="mb-3 flex items-center gap-2 text-[13px] font-semibold"><ShieldCheck class="size-4 text-primary" />Access</h3>
						<dl class="space-y-2 text-[13px]">
							<div class="flex items-center justify-between"><dt class="text-muted-foreground">pg·modern mode</dt><dd>{#if readOnly}<span class="badge badge-primary">read-only</span>{:else}<span class="badge badge-warning">read/write</span>{/if}</dd></div>
						</dl>
						<p class="mt-3 rounded-lg bg-surface p-2.5 text-[11px] text-muted-foreground">
							{#if data.snapshot}
								<FileStack class="mr-1 inline size-3" />A snapshot copied out of the container; the app keeps writing to the original. Refresh the snapshot to see new data.
							{:else if readOnly}
								Opened with <code class="font-mono">mode=ro</code> and <code class="font-mono">query_only</code>; reads wait a few seconds for the app’s write locks.
							{:else}
								Writes go straight to the file the app uses. Prefer short statements, or stop the app for bulk changes.
							{/if}
						</p>
					</section>
				</div>
			</div>

			<p class="font-mono text-[11px] text-muted-foreground/70">{data.version}</p>
		</div>
	{/if}
</div>
