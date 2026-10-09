<script lang="ts">
	import { untrack } from 'svelte';
	import { CircleAlert, CircleCheck, LoaderCircle, PencilLine, Search, SquareTerminal, ScrollText } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { ago, duration } from '#lib/client/format.ts';
	import { connections, toast } from '#lib/client/state.svelte.ts';
	import type { AuditEvent, HistoryEntry, User } from '#lib/types.ts';

	let tab = $state<'queries' | 'events'>('queries');
	let users = $state<User[]>([]);
	let filter = $state({ user: '', connection: '', q: '', writes: false, errors: false });
	let queries = $state<HistoryEntry[]>([]);
	let events = $state<AuditEvent[]>([]);
	let loading = $state(false);
	let more = $state(true);
	let expanded = $state<number | null>(null);
	const PAGE = 100;

	api.get<User[]>('/api/users').then((u) => (users = u)).catch(() => {});

	async function load(append = false) {
		loading = true;
		try {
			const p = new URLSearchParams({ type: tab, limit: String(PAGE) });
			if (filter.user) p.set('user', filter.user);
			if (filter.connection) p.set('connection', filter.connection);
			if (filter.q.trim()) p.set('q', filter.q.trim());
			if (tab === 'queries') {
				if (filter.writes) p.set('writes', '1');
				if (filter.errors) p.set('errors', '1');
				if (append && queries.length) p.set('before', String(queries.at(-1)!.id));
				const rows = await api.get<HistoryEntry[]>(`/api/audit?${p}`);
				queries = append ? [...queries, ...rows] : rows;
				more = rows.length === PAGE;
			} else {
				if (append && events.length) p.set('before', String(events.at(-1)!.id));
				const rows = await api.get<AuditEvent[]>(`/api/audit?${p}`);
				events = append ? [...events, ...rows] : rows;
				more = rows.length === PAGE;
			}
		} catch (err) {
			toast('error', 'Could not load the audit log', errorMessage(err));
		} finally {
			loading = false;
		}
	}

	// Reload when the tab or filters change (search is debounced).
	let timer: ReturnType<typeof setTimeout>;
	$effect(() => {
		void [tab, filter.user, filter.connection, filter.writes, filter.errors, filter.q];
		clearTimeout(timer);
		timer = setTimeout(() => untrack(() => load()), 200);
	});

	const ACTIONS: Record<string, string> = {
		'auth.login': 'Signed in',
		'auth.login_failed': 'Sign-in failed',
		'connection.create': 'Added connection',
		'connection.import': 'Imported connection',
		'connection.update': 'Changed connection',
		'connection.delete': 'Removed connection',
		'write.unlock': 'Unlocked writes',
		'write.relock': 'Relocked writes',
		'history.clear': 'Cleared history',
		'user.create': 'Added user',
		'user.update': 'Changed user',
		'user.delete': 'Deleted user',
		'user.access': 'Changed connection access',
		'settings.sso': 'Changed SSO',
		'settings.integration': 'Changed integration',
		'settings.discovery': 'Changed discovery settings',
		'backup.export': 'Exported backup',
		'backup.restore': 'Restored backup',
		'session.cancel': 'Cancelled query',
		'session.terminate': 'Terminated session',
		'alerts.settings': 'Changed alert settings',
		'alerts.channel.create': 'Added alert channel',
		'alerts.channel.update': 'Changed alert channel',
		'alerts.channel.delete': 'Deleted alert channel',
		'alerts.channel.test': 'Tested alert channel',
		'alerts.rule.create': 'Added alert rule',
		'alerts.rule.update': 'Changed alert rule',
		'alerts.rule.delete': 'Deleted alert rule'
	};
	const tone = (a: string) =>
		/failed|delete/.test(a) ? 'text-danger' : /unlock|write|restore/.test(a) ? 'text-warning' : 'text-foreground';
</script>

<svelte:head><title>Audit · pg·modern</title></svelte:head>

<div class="h-full overflow-y-auto">
	<PageHeader title="Audit log" description="Every query, and who changed what." />

	<div class="space-y-4 px-8 pb-10">
		<div class="flex flex-wrap items-center gap-2">
			<div class="inline-flex rounded-xl border border-border bg-surface p-1">
				<button class="flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] {tab === 'queries' ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground'}" onclick={() => (tab = 'queries')}><SquareTerminal class="size-3.5" />Queries</button>
				<button class="flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] {tab === 'events' ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground'}" onclick={() => (tab = 'events')}><ScrollText class="size-3.5" />Events</button>
			</div>
			<select class="input h-9 w-48 text-xs" bind:value={filter.user}>
				<option value="">Everyone</option>
				{#each users as u (u.id)}<option value={u.id}>{u.name ?? u.email}</option>{/each}
			</select>
			<select class="input h-9 w-48 text-xs" bind:value={filter.connection}>
				<option value="">All connections</option>
				{#each connections.list as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
			</select>
			<div class="relative">
				<Search class="absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
				<input class="input h-9 w-56 pl-8 text-xs" placeholder={tab === 'queries' ? 'Search SQL…' : 'Search…'} bind:value={filter.q} />
			</div>
			{#if tab === 'queries'}
				<button class="btn btn-sm {filter.writes ? 'btn-secondary text-primary' : 'btn-ghost'}" aria-pressed={filter.writes} onclick={() => (filter.writes = !filter.writes)}><PencilLine />Writes only</button>
				<button class="btn btn-sm {filter.errors ? 'btn-secondary text-primary' : 'btn-ghost'}" aria-pressed={filter.errors} onclick={() => (filter.errors = !filter.errors)}><CircleAlert />Errors only</button>
			{/if}
			{#if loading}<LoaderCircle class="size-4 animate-spin text-muted-foreground" />{/if}
		</div>

		<div class="card overflow-hidden">
			{#if tab === 'queries'}
				<table class="w-full table-fixed text-left text-[13px]">
					<thead class="border-b border-border bg-surface text-[11px] text-muted-foreground">
						<tr>
							<th class="w-32 px-4 py-2 font-medium">When</th>
							<th class="w-48 px-4 py-2 font-medium">Who</th>
							<th class="w-40 px-4 py-2 font-medium">Connection</th>
							<th class="px-4 py-2 font-medium">Statement</th>
							<th class="w-28 px-4 py-2 text-right font-medium">Result</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-border">
						{#each queries as h (h.id)}
							<tr class="align-top hover:bg-accent/30">
								<td class="px-4 py-2.5 text-xs text-muted-foreground" title={new Date(h.createdAt).toLocaleString()}>{ago(h.createdAt)}</td>
								<td class="truncate px-4 py-2.5 text-xs">{h.userEmail ?? '—'}</td>
								<td class="truncate px-4 py-2.5 text-xs">
									{#if h.connectionName}<a class="hover:text-primary" href="/c/{h.connectionId}">{h.connectionName}</a>{:else}<span class="text-muted-foreground">removed</span>{/if}
								</td>
								<td class="min-w-0 px-4 py-2.5">
									<button class="block w-full text-left" onclick={() => (expanded = expanded === h.id ? null : h.id)}>
										<pre class="font-mono text-[11px] whitespace-pre-wrap {expanded === h.id ? '' : 'line-clamp-2'}">{h.sql}</pre>
									</button>
									{#if h.error && expanded === h.id}<p class="mt-1 font-mono text-[11px] text-danger">{h.error}</p>{/if}
								</td>
								<td class="px-4 py-2.5 text-right text-xs whitespace-nowrap">
									<div class="flex items-center justify-end gap-1.5">
										{#if !h.readOnly}<span class="badge badge-warning">write</span>{/if}
										{#if h.ok}<CircleCheck class="size-3.5 text-success" />{:else}<CircleAlert class="size-3.5 text-danger" />{/if}
									</div>
									<p class="mt-1 text-[11px] text-muted-foreground">{duration(h.durationMs)}{#if h.rowCount != null} · {h.rowCount} rows{/if}</p>
								</td>
							</tr>
						{:else}
							<tr><td colspan="5" class="px-4 py-10 text-center text-xs text-muted-foreground">{loading ? 'Loading…' : 'No queries match.'}</td></tr>
						{/each}
					</tbody>
				</table>
			{:else}
				<table class="w-full table-fixed text-left text-[13px]">
					<thead class="border-b border-border bg-surface text-[11px] text-muted-foreground">
						<tr>
							<th class="w-32 px-4 py-2 font-medium">When</th>
							<th class="w-48 px-4 py-2 font-medium">Who</th>
							<th class="w-52 px-4 py-2 font-medium">What</th>
							<th class="px-4 py-2 font-medium">Details</th>
							<th class="w-32 px-4 py-2 font-medium">From</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-border">
						{#each events as e (e.id)}
							<tr class="align-top hover:bg-accent/30">
								<td class="px-4 py-2.5 text-xs text-muted-foreground" title={new Date(e.at).toLocaleString()}>{ago(e.at)}</td>
								<td class="truncate px-4 py-2.5 text-xs">{e.userEmail ?? '—'}</td>
								<td class="px-4 py-2.5 text-xs">
									<span class={tone(e.action)}>{ACTIONS[e.action] ?? e.action}</span>
									{#if e.connectionName}
										<p class="truncate text-[11px] text-muted-foreground">
											{#if connections.list.some((c) => c.id === e.connectionId)}<a class="hover:text-primary" href="/c/{e.connectionId}">{e.connectionName}</a>{:else}{e.connectionName}{/if}
										</p>
									{/if}
								</td>
								<td class="px-4 py-2.5 text-xs break-words text-muted-foreground">{e.detail ?? ''}</td>
								<td class="truncate px-4 py-2.5 font-mono text-[11px] text-muted-foreground">{e.ip ?? ''}</td>
							</tr>
						{:else}
							<tr><td colspan="5" class="px-4 py-10 text-center text-xs text-muted-foreground">{loading ? 'Loading…' : 'Nothing recorded yet.'}</td></tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</div>
		{#if more && (tab === 'queries' ? queries.length : events.length)}
			<div class="text-center"><button class="btn btn-secondary btn-sm" disabled={loading} onclick={() => load(true)}>Load older</button></div>
		{/if}
	</div>
</div>
