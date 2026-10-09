<script lang="ts">
	import { Activity, Clock, Database, Gauge, HardDrive, LoaderCircle, Puzzle, ShieldCheck, Table2, User } from '@lucide/svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { ago, bytes, compact } from '#lib/client/format.ts';
	import { engineLabel } from '#lib/engine.ts';
	import type { Engine, Flavor } from '#lib/types.ts';

	type Overview = {
		engine: Engine;
		flavor: Flavor;
		version: string;
		serverVersion: string;
		databaseBytes: number;
		startedAt: string | null;
		currentUser: string;
		superuser: boolean;
		canCreate: boolean;
		maxConnections: number;
		cacheHitRatio: number | null;
		inRecovery: boolean;
		largestTables: { schema: string; name: string; sizeBytes: number; estimatedRows: number }[];
		extensions: { name: string; version: string }[];
		activity: { state: string; count: number }[];
		/** MySQL / MariaDB only. */
		database?: string | null;
		grants?: string[];
		canWrite?: boolean;
		serverReadOnly?: boolean;
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

	const sessions = $derived(data?.activity.reduce((n, a) => n + a.count, 0) ?? 0);
	const maxTable = $derived(Math.max(1, ...(data?.largestTables.map((t) => t.sizeBytes) ?? [1])));
	const mysql = $derived(data?.engine === 'mysql');
	const product = $derived(data ? (data.engine === 'postgres' ? 'PostgreSQL' : engineLabel(data.engine, data.flavor)) : '');
	const serverSub = $derived(
		!data ? '' : mysql ? (data.serverReadOnly ? 'read_only server' : data.database ? `database ${data.database}` : 'no default database') : data.inRecovery ? 'replica (in recovery)' : 'primary'
	);
	/** An account that can change data, browsing through a read-only connection. */
	const powerful = $derived(!!data && (data.superuser || (mysql && !!data.canWrite)));
</script>

<div class="h-full overflow-y-auto">
	{#if error}
		<div class="m-5 rounded-xl border border-danger/30 bg-danger/5 p-4">
			<p class="text-[13px] font-medium">Could not connect</p>
			<p class="mt-1 font-mono text-xs text-muted-foreground">{error}</p>
		</div>
	{:else if !data}
		<div class="grid h-60 place-items-center"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
	{:else}
		<div class="space-y-5 p-5">
			<div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
				{#each [{ icon: Database, label: product, value: data.serverVersion, sub: serverSub }, { icon: HardDrive, label: 'Database size', value: bytes(data.databaseBytes), sub: `${data.largestTables.length ? compact(data.largestTables.reduce((n, t) => n + t.estimatedRows, 0)) : 0} rows in top tables` }, { icon: Activity, label: mysql ? 'Connections' : 'Sessions', value: `${sessions}`, sub: `of ${data.maxConnections} max` }, { icon: Gauge, label: 'Cache hit', value: data.cacheHitRatio != null ? `${data.cacheHitRatio}%` : '—', sub: mysql ? 'InnoDB buffer pool' : 'buffer cache' }] as s (s.label)}
					<div class="card p-4">
						<div class="flex items-center gap-2 text-xs text-muted-foreground"><s.icon class="size-3.5 text-primary" />{s.label}</div>
						<p class="mt-2 text-xl font-semibold tracking-tight tabular-nums">{s.value}</p>
						<p class="mt-0.5 text-[11px] text-muted-foreground">{s.sub}</p>
					</div>
				{/each}
			</div>

			<div class="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
				<section class="card p-4">
					<h3 class="mb-3 flex items-center gap-2 text-[13px] font-semibold"><Table2 class="size-4 text-primary" />Largest tables</h3>
					<div class="space-y-1">
						{#each data.largestTables as t (t.schema + t.name)}
							<button class="group relative block w-full overflow-hidden rounded-md px-2 py-1.5 text-left hover:bg-accent/50" onclick={() => onopen(t.schema, t.name)}>
								<div class="absolute inset-y-0 left-0 rounded-md bg-primary-soft" style="width:{(t.sizeBytes / maxTable) * 100}%"></div>
								<div class="relative flex items-center gap-3 text-[13px]">
									<span class="truncate font-mono text-xs"><span class="text-muted-foreground">{t.schema}.</span>{t.name}</span>
									<span class="ml-auto text-[11px] text-muted-foreground tabular-nums">{compact(t.estimatedRows)} rows</span>
									<span class="w-16 text-right text-[11px] font-medium tabular-nums">{bytes(t.sizeBytes)}</span>
								</div>
							</button>
						{:else}
							<p class="text-xs text-muted-foreground">No tables yet.</p>
						{/each}
					</div>
				</section>

				<div class="space-y-5">
					<section class="card p-4">
						<h3 class="mb-3 flex items-center gap-2 text-[13px] font-semibold"><ShieldCheck class="size-4 text-primary" />Access</h3>
						<dl class="space-y-2 text-[13px]">
							<div class="flex items-center justify-between"><dt class="flex items-center gap-2 text-muted-foreground"><User class="size-3.5" />{mysql ? 'Account' : 'Role'}</dt><dd class="font-mono text-xs">{data.currentUser}</dd></div>
							<div class="flex items-center justify-between"><dt class="text-muted-foreground">{mysql ? 'Global admin (ALL / SUPER)' : 'Superuser'}</dt><dd>{#if data.superuser}<span class="badge badge-warning">yes</span>{:else}<span class="badge">no</span>{/if}</dd></div>
							{#if mysql}
								<div class="flex items-center justify-between"><dt class="text-muted-foreground">Account can change data</dt><dd>{#if data.canWrite}<span class="badge badge-warning">yes</span>{:else}<span class="badge badge-success">no — SELECT only</span>{/if}</dd></div>
							{/if}
							<div class="flex items-center justify-between"><dt class="text-muted-foreground">pg·modern mode</dt><dd>{#if readOnly}<span class="badge badge-primary">read-only</span>{:else}<span class="badge badge-warning">read/write</span>{/if}</dd></div>
							<div class="flex items-center justify-between"><dt class="flex items-center gap-2 text-muted-foreground"><Clock class="size-3.5" />Server up since</dt><dd class="text-xs">{ago(data.startedAt)}</dd></div>
						</dl>
						{#if mysql && data.grants?.length}
							<details class="mt-3 text-[11px]">
								<summary class="cursor-pointer text-muted-foreground select-none hover:text-foreground">Grants ({data.grants.length})</summary>
								<ul class="mt-1.5 space-y-1">
									{#each data.grants as g, i (i)}
										<li class="rounded-md bg-surface px-2 py-1 font-mono break-all text-muted-foreground">{g}</li>
									{/each}
								</ul>
							</details>
						{/if}
						{#if powerful && readOnly && mysql}
							<p class="mt-3 rounded-lg bg-surface p-2.5 text-[11px] text-muted-foreground">
								Tip: this account {data.superuser ? 'is a global admin' : 'can change data'}. pg·modern only lets reads through on read-only connections, but
								an account with just <code class="font-mono">SELECT, SHOW VIEW</code> on the databases you browse is the strongest guarantee.
							</p>
						{:else if data.superuser && readOnly}
							<p class="mt-3 rounded-lg bg-surface p-2.5 text-[11px] text-muted-foreground">
								Tip: this role is a superuser. pg·modern enforces read-only transactions, but a dedicated role with only
								<code class="font-mono">pg_read_all_data</code> is the strongest guarantee.
							</p>
						{/if}
					</section>

					<section class="card p-4">
						<h3 class="mb-3 flex items-center gap-2 text-[13px] font-semibold"><Puzzle class="size-4 text-primary" />{mysql ? 'Storage engines' : 'Extensions'}</h3>
						<div class="flex flex-wrap gap-1.5">
							{#each data.extensions as e (e.name)}
								<span class="badge font-mono {mysql && e.version === 'default' ? 'badge-primary' : ''}">{e.name} <span class="opacity-60">{e.version}</span></span>
							{/each}
						</div>
					</section>
				</div>
			</div>

			<p class="font-mono text-[11px] text-muted-foreground/70">{data.version}</p>
		</div>
	{/if}
</div>
