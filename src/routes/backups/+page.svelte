<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { CalendarClock, DatabaseBackup, HardDrive, LoaderCircle, RefreshCw, TriangleAlert } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import RunsTab from '#lib/components/backups/RunsTab.svelte';
	import SchedulesTab from '#lib/components/backups/SchedulesTab.svelte';
	import DestinationsTab from '#lib/components/backups/DestinationsTab.svelte';
	import type { BackupsData } from '#lib/components/backups/types.ts';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { connections, toast } from '#lib/client/state.svelte.ts';

	type Tab = 'runs' | 'schedules' | 'destinations';
	const TABS: { key: Tab; label: string; icon: typeof DatabaseBackup }[] = [
		{ key: 'runs', label: 'Runs', icon: DatabaseBackup },
		{ key: 'schedules', label: 'Schedules', icon: CalendarClock },
		{ key: 'destinations', label: 'Destinations', icon: HardDrive }
	];

	let tab = $state<Tab>('runs');
	let data = $state<BackupsData | null>(null);
	let loading = $state(false);

	onMount(() => {
		const t = new URLSearchParams(location.search).get('tab');
		if (t === 'schedules' || t === 'destinations') tab = t;
		load();
	});

	async function load(fresh = false) {
		loading = true;
		try {
			data = await api.get<BackupsData>(`/api/backups${fresh ? '?fresh' : ''}`);
		} catch (err) {
			toast('error', 'Could not load backups', errorMessage(err));
		} finally {
			loading = false;
		}
	}

	// Poll while something is running, so statuses and sizes update by themselves.
	let timer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		const running = data?.runs.some((r) => r.status === 'running');
		clearTimeout(timer);
		if (running) timer = setTimeout(() => load(), 2000);
	});
	onDestroy(() => clearTimeout(timer));

	function selectTab(t: Tab) {
		tab = t;
		history.replaceState(history.state, '', t === 'runs' ? '/backups' : `/backups?tab=${t}`);
	}

	const usesPg = $derived(connections.list.some((c) => c.engine === 'postgres'));
	const usesMysql = $derived(connections.list.some((c) => c.engine === 'mysql'));
	const missing = $derived.by(() => {
		if (!data) return [];
		const m: string[] = [];
		if (usesPg && !data.tools.pgDump) m.push('pg_dump');
		if (usesPg && !data.tools.pgRestore) m.push('pg_restore');
		if (usesMysql && !data.tools.mysqlDump) m.push('mariadb-dump / mysqldump');
		if (usesMysql && !data.tools.mysqlClient) m.push('mariadb / mysql');
		return m;
	});
</script>

<svelte:head><title>Backups · pg·modern</title></svelte:head>

<div class="h-full overflow-y-auto">
	<PageHeader title="Backups" description="Scheduled dumps of your databases to a folder, a NAS over SFTP, or S3-compatible storage.">
		{#snippet actions()}
			<button class="btn btn-secondary" onclick={() => load(true)} disabled={loading}>
				{#if loading}<LoaderCircle class="animate-spin" />{:else}<RefreshCw />{/if}Refresh
			</button>
		{/snippet}
	</PageHeader>

	<div class="space-y-4 px-8 pb-10">
		{#if missing.length}
			<div class="card flex gap-3 border-warning/40 bg-warning/5 p-4 text-[13px]">
				<TriangleAlert class="mt-0.5 size-4 shrink-0 text-warning" />
				<div>
					<p class="font-medium">Missing client tools: {missing.join(', ')}</p>
					<p class="mt-0.5 text-muted-foreground">
						The pg·modern Docker image includes them. When running from source, install the PostgreSQL client (≥ your newest server's
						major version) and the MariaDB client, and make sure they're on PATH. Backups of those engines fail until then.
					</p>
				</div>
			</div>
		{/if}

		<div class="flex flex-wrap items-center gap-2">
			<div class="inline-flex rounded-xl border border-border bg-surface p-1" role="tablist">
				{#each TABS as t (t.key)}
					<button
						role="tab"
						aria-selected={tab === t.key}
						class="flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] {tab === t.key ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground'}"
						onclick={() => selectTab(t.key)}
					>
						<t.icon class="size-3.5" />{t.label}
						{#if data && t.key === 'schedules' && data.schedules.length}<span class="badge h-4 px-1">{data.schedules.length}</span>{/if}
						{#if data && t.key === 'destinations' && data.destinations.length}<span class="badge h-4 px-1">{data.destinations.length}</span>{/if}
					</button>
				{/each}
			</div>
			{#if data}
				<span class="ml-auto text-xs text-muted-foreground" title="Set TZ on the container to change it">Server time zone: {data.timeZone}</span>
			{/if}
		</div>

		{#if !data}
			<div class="card grid h-40 place-items-center text-muted-foreground"><LoaderCircle class="size-5 animate-spin" /></div>
		{:else if tab === 'runs'}
			<RunsTab {data} reload={load} goto={selectTab} />
		{:else if tab === 'schedules'}
			<SchedulesTab {data} reload={load} goto={selectTab} />
		{:else}
			<DestinationsTab {data} reload={load} />
		{/if}
	</div>
</div>
