<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		Activity as ActivityIcon,
		ChevronRight,
		CircleStop,
		Clock,
		CornerDownRight,
		Database,
		Hourglass,
		Layers,
		LoaderCircle,
		Lock,
		OctagonX,
		Plug,
		RefreshCw,
		Search,
		Table2,
		TriangleAlert
	} from '@lucide/svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { ago, bytes, compact } from '#lib/client/format.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';
	import {
		LONG_TXN_SECONDS,
		arrangeSessions,
		deadIsHigh,
		deadRatio,
		formatAge,
		matchesSearch,
		sessionTone,
		summarize,
		type Activity,
		type ActivitySession,
		type SessionTone
	} from '#lib/activity.ts';

	let {
		connectionId,
		readOnly,
		active = true,
		onopen
	}: { connectionId: string; readOnly: boolean; active?: boolean; onopen?: (schema: string, table: string) => void } = $props();

	const PREFS_KEY = 'pgm-activity';
	type Prefs = { every: number; hideIdle: boolean; hideOwn: boolean; hideBackground: boolean };
	const prefs: Prefs = (() => {
		const d: Prefs = { every: 5, hideIdle: false, hideOwn: true, hideBackground: true };
		try {
			return { ...d, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
		} catch {
			return d;
		}
	})();

	let data = $state<Activity | null>(null);
	let error = $state('');
	let loading = $state(false);
	let fetchedAt = $state(0);
	let now = $state(Date.now());
	let visible = $state(typeof document === 'undefined' || document.visibilityState !== 'hidden');
	let every = $state(prefs.every);
	let hideIdle = $state(prefs.hideIdle);
	let hideOwn = $state(prefs.hideOwn);
	let hideBackground = $state(prefs.hideBackground);
	let search = $state('');
	let busyPid = $state<number | null>(null);
	const expanded = new SvelteSet<number>();
	let controller: AbortController | null = null;

	$effect(() => {
		const snapshot = JSON.stringify({ every, hideIdle, hideOwn, hideBackground });
		try {
			localStorage.setItem(PREFS_KEY, snapshot);
		} catch {}
	});

	async function load() {
		if (loading) return;
		controller = new AbortController();
		loading = true;
		try {
			const d = await api.get<Activity>(`/api/connections/${connectionId}/activity`, controller.signal);
			data = d;
			error = '';
			fetchedAt = now = Date.now();
		} catch (err) {
			if ((err as Error)?.name !== 'AbortError') error = errorMessage(err);
		} finally {
			loading = false;
		}
	}

	// A different connection starts from scratch.
	$effect(() => {
		void connectionId;
		untrack(() => {
			controller?.abort();
			loading = false;
			data = null;
			error = '';
			expanded.clear();
		});
		return () => controller?.abort();
	});

	const live = $derived(active && visible);

	// Catch up right away when the tab comes back into view.
	$effect(() => {
		if (!live) return;
		void connectionId;
		untrack(() => {
			if (!data || Date.now() - fetchedAt > 1500) load();
		});
	});

	$effect(() => {
		if (!live || !every) return;
		const t = setInterval(load, every * 1000);
		return () => clearInterval(t);
	});

	// Durations tick between refreshes.
	$effect(() => {
		if (!live) return;
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});

	const elapsed = $derived(fetchedAt ? Math.max(0, (now - fetchedAt) / 1000) : 0);
	const tick = (s: number | null) => (s == null ? null : s + elapsed);

	const server = $derived(data?.server.data ?? null);
	const sessions = $derived(data?.sessions.data ?? []);
	const summary = $derived(summarize(sessions));
	const byPid = $derived(new Map(sessions.map((s) => [s.pid, s])));
	// Anything in a lock chain stays visible whatever the filters say.
	const inChain = $derived(new Set(sessions.flatMap((s) => (s.blockedBy.length ? [s.pid, ...s.blockedBy] : []))));
	const filtered = $derived(
		sessions.filter((s) => {
			if (!matchesSearch(s, search)) return false;
			if (inChain.has(s.pid)) return true;
			const tone = sessionTone(s);
			if (hideIdle && tone === 'idle') return false;
			if (hideBackground && tone === 'background') return false;
			if (hideOwn && s.pgModern) return false;
			return true;
		})
	);
	const rows = $derived(arrangeSessions(filtered));
	const hiddenCount = $derived(sessions.length - filtered.length);
	const privilegeHidden = $derived(sessions.some((s) => s.query === '<insufficient privilege>'));
	const waitingLocks = $derived((data?.locks.data ?? []).filter((l) => !l.granted));
	const heldLocks = $derived((data?.locks.data ?? []).filter((l) => l.granted));
	const maxDb = $derived(Math.max(1, ...(data?.databases.data ?? []).map((d) => d.bytes ?? 0)));
	const maxTable = $derived(Math.max(1, ...(data?.tables.data ?? []).map((t) => t.totalBytes)));
	const usage = $derived(server ? summary.clients / server.maxConnections : 0);

	const TONE: Record<SessionTone, { label: (s: ActivitySession) => string; cls: string }> = {
		waiting: { label: () => 'waiting', cls: 'badge-danger' },
		active: { label: () => 'active', cls: 'badge-success' },
		'idle-txn': { label: (s) => (s.state?.includes('aborted') ? 'idle in txn (aborted)' : 'idle in txn'), cls: 'badge-warning' },
		idle: { label: () => 'idle', cls: '' },
		background: { label: (s) => s.backendType ?? 'background', cls: 'opacity-70' },
		other: { label: (s) => s.state ?? '—', cls: '' }
	};

	/** Main elapsed time per row: the running query, or how long it's been idle. */
	function mainSeconds(s: ActivitySession) {
		const tone = sessionTone(s);
		return tone === 'active' || tone === 'waiting' ? tick(s.querySeconds) : tick(s.stateSeconds);
	}

	function oneLine(q: string | null) {
		return q ? q.replace(/\s+/g, ' ').trim() : '';
	}

	function toggle(pid: number) {
		if (expanded.has(pid)) expanded.delete(pid);
		else expanded.add(pid);
	}

	async function signal(s: ActivitySession, terminate: boolean) {
		const ok = await confirmAction(
			terminate
				? {
						title: `Terminate session ${s.pid}?`,
						body: `Closes ${s.user ?? 'this'}${s.app ? ` (${s.app})` : ''} connection and rolls back any open transaction. This is recorded in the audit log.`,
						detail: s.query ?? undefined,
						confirmLabel: 'Terminate session',
						danger: true
					}
				: {
						title: `Cancel the query on pid ${s.pid}?`,
						body: 'Interrupts the running statement; the session stays connected. This is recorded in the audit log.',
						detail: s.query ?? undefined,
						confirmLabel: 'Cancel query'
					}
		);
		if (!ok) return;
		busyPid = s.pid;
		try {
			const res = await api.post<{ ok: boolean }>(`/api/connections/${connectionId}/activity/cancel`, { pid: s.pid, terminate });
			if (res.ok) toast('success', terminate ? `Terminated session ${s.pid}` : `Cancel sent to pid ${s.pid}`);
			else toast('info', `Pid ${s.pid} wasn’t signalled`, 'It may have already finished.');
			await new Promise((r) => setTimeout(r, 250));
			await load();
		} catch (err) {
			toast('error', terminate ? 'Could not terminate' : 'Could not cancel', errorMessage(err));
		} finally {
			busyPid = null;
		}
	}

	const lockedHint = 'Unlock writes to cancel or terminate';
</script>

<svelte:document onvisibilitychange={() => (visible = document.visibilityState !== 'hidden')} />

{#snippet sectionError(message: string)}
	<p class="flex items-start gap-2 rounded-lg bg-danger/5 p-2.5 font-mono text-[11px] text-danger"><TriangleAlert class="mt-px size-3.5 shrink-0" />{message}</p>
{/snippet}

{#snippet stat(Icon: typeof Clock, label: string, value: string, sub: string, tone: '' | 'success' | 'warning' | 'danger')}
	<div class="card p-3.5">
		<div class="flex items-center gap-2 text-xs text-muted-foreground">
			<Icon class="size-3.5 {tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : tone === 'danger' ? 'text-danger' : 'text-primary'}" />{label}
		</div>
		<p class="mt-1.5 text-xl font-semibold tracking-tight tabular-nums {tone === 'warning' ? 'text-warning' : tone === 'danger' ? 'text-danger' : ''}">{value}</p>
		<p class="mt-0.5 truncate text-[11px] text-muted-foreground">{sub}</p>
	</div>
{/snippet}

<div class="h-full overflow-y-auto">
	<div class="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-background/85 px-5 py-2 backdrop-blur">
		<h2 class="flex items-center gap-2 text-[13px] font-semibold"><ActivityIcon class="size-4 text-primary" />Activity</h2>
		{#if server}<span class="font-mono text-[11px] text-muted-foreground">{server.currentUser}{server.superuser ? ' · superuser' : ''}</span>{/if}
		<div class="ml-auto flex items-center gap-2">
			{#if error && data}
				<span class="badge badge-danger" title={error}><TriangleAlert />Refresh failed</span>
			{/if}
			<span class="text-[11px] text-muted-foreground tabular-nums">
				{#if !fetchedAt}Loading…{:else if !live}Paused · updated {formatAge(elapsed)} ago{:else}Updated {elapsed < 1 ? 'just now' : `${formatAge(elapsed)} ago`}{/if}
			</span>
			<div class="inline-flex rounded-lg border border-border bg-surface p-0.5" role="group" aria-label="Auto-refresh">
				{#each [0, 2, 5, 15] as s (s)}
					<button
						class="h-6 rounded-md px-2 text-[11px] {every === s ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground hover:text-foreground'}"
						aria-pressed={every === s}
						title={s ? `Refresh every ${s} seconds` : 'Don’t refresh automatically'}
						onclick={() => (every = s)}>{s ? `${s}s` : 'Off'}</button
					>
				{/each}
			</div>
			<button class="btn btn-ghost btn-icon btn-sm" title="Refresh now" aria-label="Refresh now" onclick={load} disabled={loading && !data}>
				<RefreshCw class={loading ? 'animate-spin' : ''} />
			</button>
		</div>
	</div>

	{#if !data && error}
		<div class="m-5 rounded-xl border border-danger/30 bg-danger/5 p-4">
			<p class="text-[13px] font-medium">Could not load activity</p>
			<p class="mt-1 font-mono text-xs text-muted-foreground">{error}</p>
			<button class="btn btn-secondary btn-sm mt-3" onclick={load}><RefreshCw />Try again</button>
		</div>
	{:else if !data}
		<div class="grid h-60 place-items-center"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
	{:else}
		<div class="space-y-5 p-5">
			<div class="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
				{@render stat(ActivityIcon, 'Active', `${summary.active}`, 'running a statement', summary.active ? 'success' : '')}
				{@render stat(Plug, 'Idle', `${summary.idle}`, 'connected, not running', '')}
				{@render stat(Hourglass, 'Idle in transaction', `${summary.idleInTransaction}`, 'holding a transaction open', summary.idleInTransaction ? 'warning' : '')}
				{@render stat(Lock, 'Waiting', `${summary.waiting}`, 'blocked on a lock', summary.waiting ? 'danger' : '')}
				{@render stat(
					Clock,
					'Oldest transaction',
					formatAge(tick(summary.oldestXactSeconds)),
					summary.oldestXactPid ? `pid ${summary.oldestXactPid}` : 'none open',
					(summary.oldestXactSeconds ?? 0) >= LONG_TXN_SECONDS ? 'warning' : ''
				)}
				<div class="card p-3.5">
					<div class="flex items-center gap-2 text-xs text-muted-foreground"><Layers class="size-3.5 text-primary" />Connections</div>
					<p class="mt-1.5 text-xl font-semibold tracking-tight tabular-nums">
						{summary.clients}<span class="text-sm font-normal text-muted-foreground"> / {server?.maxConnections ?? '—'}</span>
					</p>
					<div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
						<div class="h-full rounded-full {usage > 0.8 ? 'bg-danger' : usage > 0.6 ? 'bg-warning' : 'bg-primary'}" style="width:{Math.min(100, usage * 100)}%"></div>
					</div>
				</div>
			</div>

			{#if summary.longTransactions.length}
				<div class="flex flex-wrap items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3.5 py-2.5 text-[12px]">
					<TriangleAlert class="size-4 text-warning" />
					<span>
						{summary.longTransactions.length === 1 ? 'A transaction has' : `${summary.longTransactions.length} transactions have`} been open longer than {LONG_TXN_SECONDS / 60} minutes. Long transactions hold back vacuum and can block DDL.
					</span>
					{#each summary.longTransactions as pid (pid)}
						<button class="badge badge-warning font-mono hover:bg-warning/20" title="Show this session" onclick={() => (search = String(pid))}>{pid}</button>
					{/each}
				</div>
			{/if}

			<section class="card overflow-hidden">
				<div class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
					<h3 class="mr-1 text-[13px] font-semibold">Sessions</h3>
					<span class="text-[11px] text-muted-foreground tabular-nums">{filtered.length} shown{hiddenCount ? ` · ${hiddenCount} hidden` : ''}</span>
					<div class="ml-auto flex flex-wrap items-center gap-1.5">
						{#each [{ label: 'Idle', get: () => hideIdle, set: (v: boolean) => (hideIdle = v) }, { label: 'Background', get: () => hideBackground, set: (v: boolean) => (hideBackground = v) }, { label: 'pg·modern', get: () => hideOwn, set: (v: boolean) => (hideOwn = v) }] as f (f.label)}
							<button
								class="h-7 rounded-lg border px-2.5 text-[11px] transition-colors {f.get()
									? 'border-border text-muted-foreground line-through decoration-muted-foreground/50 hover:text-foreground'
									: 'border-primary/30 bg-primary-soft text-primary'}"
								aria-pressed={!f.get()}
								title={f.get() ? `Show ${f.label} sessions` : `Hide ${f.label} sessions`}
								onclick={() => f.set(!f.get())}>{f.label}</button
							>
						{/each}
						<label class="relative">
							<Search class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
							<input class="input h-7 w-52 pl-8 text-xs" placeholder="Filter pid, user, app, query…" bind:value={search} />
						</label>
					</div>
				</div>

				{#if data.sessions.error}
					<div class="p-4">{@render sectionError(data.sessions.error)}</div>
				{:else}
					{#if privilegeHidden}
						<p class="border-b border-border bg-surface/60 px-4 py-2 text-[11px] text-muted-foreground">
							Some queries show as <code class="font-mono">&lt;insufficient privilege&gt;</code>: this role can only see its own sessions’ details. Grant
							<code class="font-mono">pg_read_all_stats</code> to see everything.
						</p>
					{/if}
					<div class="overflow-x-auto">
						<table class="w-full min-w-[960px] text-left text-[12px]">
							<thead class="border-b border-border text-[11px] text-muted-foreground">
								<tr>
									<th class="w-28 px-4 py-2 font-medium">PID</th>
									<th class="w-36 px-2 py-2 font-medium">State</th>
									<th class="w-44 px-2 py-2 font-medium">User · app</th>
									<th class="w-32 px-2 py-2 font-medium">Client</th>
									<th class="w-28 px-2 py-2 text-right font-medium">Duration</th>
									<th class="px-3 py-2 font-medium">Query</th>
									<th class="w-20 px-4 py-2"><span class="sr-only">Actions</span></th>
								</tr>
							</thead>
							<tbody>
								{#each rows as { session: s, depth, blocks } (s.pid)}
									{@const tone = sessionTone(s)}
									{@const open = expanded.has(s.pid)}
									{@const secs = mainSeconds(s)}
									<tr
										class="border-b border-border/60 align-top last:border-0 {blocks.length
											? 'bg-danger/[0.06]'
											: s.blockedBy.length
												? 'bg-warning/[0.04]'
												: 'hover:bg-accent/40'}"
									>
										<td class="px-4 py-2">
											<div class="flex items-center gap-1 font-mono tabular-nums" style="padding-left:{depth * 14}px">
												{#if depth}<CornerDownRight class="size-3 shrink-0 text-danger/70" />{/if}
												{s.pid}
											</div>
											{#if s.self}
												<span class="mt-1 badge badge-primary" title="The session that fetched this list">this request</span>
											{:else if s.pgModern}
												<span class="mt-1 badge" title="One of pg·modern’s pooled sessions">pg·modern</span>
											{/if}
										</td>
										<td class="px-2 py-2">
											<span class="badge {TONE[tone].cls}">{TONE[tone].label(s)}</span>
											{#if s.waitEvent}
												<p class="mt-1 truncate font-mono text-[10.5px] text-muted-foreground" title="{s.waitEventType}: {s.waitEvent}">{s.waitEventType} · {s.waitEvent}</p>
											{/if}
										</td>
										<td class="max-w-44 px-2 py-2">
											<p class="truncate font-mono text-[11.5px]" title="{s.user ?? ''}@{s.database ?? ''}">
												{s.user ?? '—'}{#if s.database}<span class="text-muted-foreground">@{s.database}</span>{/if}
											</p>
											<p class="truncate text-[11px] text-muted-foreground" title={s.app ?? ''}>{s.app ?? (s.backendType !== 'client backend' ? (s.backendType ?? '') : '')}</p>
										</td>
										<td class="max-w-32 truncate px-2 py-2 font-mono text-[11px] text-muted-foreground" title={s.client ?? ''}>{s.client ?? '—'}</td>
										<td class="px-2 py-2 text-right tabular-nums">
											<span class={tone === 'idle' || tone === 'background' ? 'text-muted-foreground' : (secs ?? 0) >= LONG_TXN_SECONDS ? 'font-medium text-warning' : 'font-medium'}>{formatAge(secs)}</span>
											{#if s.xactSeconds != null && (secs ?? 0) + 1 < (tick(s.xactSeconds) ?? 0)}
												<p class="text-[10.5px] text-muted-foreground" title="Transaction open for">txn {formatAge(tick(s.xactSeconds))}</p>
											{/if}
										</td>
										<td class="max-w-0 px-3 py-2">
											{#if s.query}
												<button class="group flex w-full min-w-0 items-start gap-1 text-left" onclick={() => toggle(s.pid)} aria-expanded={open}>
													<ChevronRight class="mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform {open ? 'rotate-90' : ''}" />
													<code class="block min-w-0 truncate font-mono text-[11.5px] {tone === 'idle' ? 'text-muted-foreground' : ''} group-hover:text-foreground">{oneLine(s.query)}</code>
												</button>
											{:else}
												<span class="text-muted-foreground/60">—</span>
											{/if}
											{#if s.blockedBy.length || blocks.length}
												<div class="mt-1.5 flex flex-wrap gap-1 pl-4">
													{#each s.blockedBy as b (b)}
														<button class="badge badge-danger font-mono" title={byPid.get(b)?.query ?? ''} onclick={() => (search = String(b))}><Lock />blocked by {b}</button>
													{/each}
													{#if blocks.length}
														<span class="badge badge-danger"><TriangleAlert />blocking {blocks.length} {blocks.length === 1 ? 'session' : 'sessions'}</span>
													{/if}
												</div>
											{/if}
										</td>
										<td class="px-4 py-2">
											{#if !s.self && tone !== 'background'}
												<div class="flex justify-end gap-0.5">
													<span title={readOnly ? lockedHint : 'Cancel the running query'}>
														<button class="btn btn-ghost btn-icon btn-sm" aria-label="Cancel query on pid {s.pid}" disabled={readOnly || busyPid === s.pid} onclick={() => signal(s, false)}><CircleStop /></button>
													</span>
													<span title={readOnly ? lockedHint : 'Terminate the session'}>
														<button class="btn btn-ghost btn-icon btn-sm hover:bg-danger/10 hover:text-danger" aria-label="Terminate session {s.pid}" disabled={readOnly || busyPid === s.pid} onclick={() => signal(s, true)}><OctagonX /></button>
													</span>
												</div>
											{/if}
										</td>
									</tr>
									{#if open}
										<tr class="border-b border-border/60 bg-surface/50">
											<td></td>
											<td colspan="6" class="px-2 pt-1 pb-3">
												<pre class="max-h-72 overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">{s.query}{s.queryTruncated ? '\n…(truncated)' : ''}</pre>
												<dl class="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-muted-foreground">
													<div><dt class="inline">Backend</dt> <dd class="inline font-mono text-foreground">{s.backendType ?? '—'}</dd></div>
													<div><dt class="inline">Connected</dt> <dd class="inline text-foreground">{ago(s.backendStart)}</dd></div>
													{#if s.xactStart}<div><dt class="inline">Transaction</dt> <dd class="inline text-foreground">{formatAge(tick(s.xactSeconds))}</dd></div>{/if}
													{#if s.queryStart}<div><dt class="inline">Query started</dt> <dd class="inline text-foreground">{new Date(s.queryStart).toLocaleTimeString()}</dd></div>{/if}
													{#if s.xidAge != null}<div><dt class="inline">xid age</dt> <dd class="inline font-mono text-foreground">{compact(s.xidAge)}</dd></div>{/if}
													{#if s.xminAge != null}<div><dt class="inline">xmin age</dt> <dd class="inline font-mono text-foreground">{compact(s.xminAge)}</dd></div>{/if}
												</dl>
											</td>
										</tr>
									{/if}
								{:else}
									<tr><td colspan="7" class="px-4 py-8 text-center text-xs text-muted-foreground">{search ? 'No sessions match.' : 'No sessions to show.'}</td></tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</section>

			<div class="grid gap-5 xl:grid-cols-[1fr_1.5fr]">
				<div class="space-y-5">
					<section class="card p-4">
						<h3 class="mb-3 flex items-center gap-2 text-[13px] font-semibold">
							<Lock class="size-4 text-primary" />Locks
							{#if waitingLocks.length}<span class="badge badge-danger">{waitingLocks.length} waiting</span>{/if}
						</h3>
						{#if data.locks.error}
							{@render sectionError(data.locks.error)}
						{:else if !data.locks.data?.length}
							<p class="text-xs text-muted-foreground">Nothing waiting on a lock, and no strong locks held for over a minute.</p>
						{:else}
							<div class="space-y-1">
								{#each [...waitingLocks, ...heldLocks] as l, i (i)}
									<div class="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] {l.granted ? '' : 'bg-danger/5'}">
										<span class="badge {l.granted ? 'badge-warning' : 'badge-danger'}">{l.granted ? 'held' : 'waiting'}</span>
										<button class="font-mono text-[11px] tabular-nums hover:text-primary" title="Show this session" onclick={() => (search = String(l.pid))}>{l.pid}</button>
										<span class="truncate font-mono text-[11px]" title={l.relation ?? l.locktype}>{l.relation ?? (l.locktype === 'transactionid' ? 'transaction' : l.locktype)}</span>
										<span class="ml-auto shrink-0 text-[11px] text-muted-foreground">{l.mode.replace(/Lock$/, '')}</span>
										<span class="w-14 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">{formatAge(tick(l.seconds))}</span>
									</div>
								{/each}
							</div>
						{/if}
					</section>

					<section class="card p-4">
						<h3 class="mb-3 flex items-center gap-2 text-[13px] font-semibold"><Database class="size-4 text-primary" />Databases</h3>
						{#if data.databases.error}
							{@render sectionError(data.databases.error)}
						{:else}
							<div class="space-y-1">
								{#each data.databases.data ?? [] as d (d.name)}
									<div class="relative overflow-hidden rounded-md px-2 py-1.5">
										<div class="absolute inset-y-0 left-0 rounded-md {d.current ? 'bg-primary/20' : 'bg-primary-soft'}" style="width:{((d.bytes ?? 0) / maxDb) * 100}%"></div>
										<div class="relative flex items-center gap-2 text-[12px]">
											<span class="truncate font-mono text-xs {d.current ? 'font-medium' : ''}">{d.name}</span>
											{#if d.current}<span class="badge badge-primary">current</span>{/if}
											<span class="ml-auto text-[11px] text-muted-foreground tabular-nums">{d.sessions} {d.sessions === 1 ? 'session' : 'sessions'}</span>
											<span class="w-16 text-right text-[11px] font-medium tabular-nums">{d.bytes == null ? 'no access' : bytes(d.bytes)}</span>
										</div>
									</div>
								{/each}
							</div>
						{/if}
					</section>
				</div>

				<div class="space-y-5">
					<section class="card overflow-hidden">
						<h3 class="flex items-center gap-2 px-4 pt-4 pb-3 text-[13px] font-semibold"><Table2 class="size-4 text-primary" />Largest tables</h3>
						{#if data.tables.error}
							<div class="px-4 pb-4">{@render sectionError(data.tables.error)}</div>
						{:else if !data.tables.data?.length}
							<p class="px-4 pb-4 text-xs text-muted-foreground">No user tables in this database.</p>
						{:else}
							<div class="overflow-x-auto">
								<table class="w-full min-w-[560px] text-left text-[12px]">
									<thead class="border-y border-border text-[11px] text-muted-foreground">
										<tr>
											<th class="px-4 py-1.5 font-medium">Table</th>
											<th class="w-36 px-2 py-1.5 font-medium">Size</th>
											<th class="px-2 py-1.5 text-right font-medium">Rows</th>
											<th class="px-2 py-1.5 text-right font-medium">Dead</th>
											<th class="px-2 py-1.5 font-medium">Autovacuum</th>
											<th class="px-4 py-1.5 text-right font-medium" title="Sequential / index scans">Seq / idx</th>
										</tr>
									</thead>
									<tbody>
										{#each data.tables.data as t (t.schema + '.' + t.name)}
											{@const dead = deadRatio(t.liveTuples, t.deadTuples)}
											<tr class="border-b border-border/60 last:border-0 hover:bg-accent/40">
												<td class="max-w-48 px-4 py-1.5">
													<button class="block max-w-full truncate font-mono text-[11.5px] hover:text-primary" onclick={() => onopen?.(t.schema, t.name)}>
														<span class="text-muted-foreground">{t.schema}.</span>{t.name}
													</button>
												</td>
												<td class="px-2 py-1.5" title="table {bytes(t.tableBytes)} · indexes {bytes(t.indexBytes)}">
													<div class="flex items-center gap-2">
														<div class="flex h-1.5 w-16 overflow-hidden rounded-full bg-muted">
															<div class="h-full bg-primary" style="width:{(t.tableBytes / maxTable) * 100}%"></div>
															<div class="h-full bg-primary/40" style="width:{(t.indexBytes / maxTable) * 100}%"></div>
														</div>
														<span class="tabular-nums" title={t.sizeEstimated ? 'Exclusively locked right now: estimated from planner statistics' : undefined}>{t.sizeEstimated ? '~' : ''}{bytes(t.totalBytes)}</span>
														{#if t.sizeEstimated}<Lock class="size-3 text-warning" />{/if}
													</div>
												</td>
												<td class="px-2 py-1.5 text-right text-muted-foreground tabular-nums">{compact(t.liveTuples)}</td>
												<td class="px-2 py-1.5 text-right tabular-nums">
													{#if dead == null}
														<span class="text-muted-foreground">—</span>
													{:else if deadIsHigh(t.liveTuples, t.deadTuples)}
														<span class="badge badge-warning" title="{compact(t.deadTuples)} dead tuples">{dead.toFixed(0)}%</span>
													{:else}
														<span class="text-muted-foreground" title="{compact(t.deadTuples)} dead tuples">{dead < 1 && dead > 0 ? '<1' : dead.toFixed(0)}%</span>
													{/if}
												</td>
												<td class="px-2 py-1.5 text-[11px] whitespace-nowrap text-muted-foreground" title={t.lastVacuum ? `manual vacuum ${ago(t.lastVacuum)}` : ''}>{ago(t.lastAutovacuum)}</td>
												<td class="px-4 py-1.5 text-right font-mono text-[11px] whitespace-nowrap text-muted-foreground tabular-nums">{t.seqScans == null ? '—' : compact(t.seqScans)} / {t.idxScans == null ? '—' : compact(t.idxScans)}</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						{/if}
					</section>

					<section class="card p-4">
						<h3 class="mb-3 flex items-center gap-2 text-[13px] font-semibold"><Layers class="size-4 text-primary" />Largest indexes</h3>
						{#if data.indexes.error}
							{@render sectionError(data.indexes.error)}
						{:else if !data.indexes.data?.length}
							<p class="text-xs text-muted-foreground">No indexes on user tables.</p>
						{:else}
							<div class="space-y-0.5">
								{#each data.indexes.data as ix (ix.schema + '.' + ix.name)}
									<div class="flex items-center gap-2 rounded-md px-2 py-1 text-[12px] hover:bg-accent/40">
										<span class="truncate font-mono text-[11.5px]" title="{ix.schema}.{ix.table}">{ix.name}</span>
										<span class="truncate text-[11px] text-muted-foreground">on {ix.table}</span>
										{#if ix.scans === 0 && !ix.unique}<span class="badge badge-warning" title="Never used since statistics were last reset">unused</span>{/if}
										<span class="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">{ix.scans == null ? '—' : compact(ix.scans)} scans</span>
										<span class="w-16 shrink-0 text-right text-[11px] font-medium tabular-nums">{bytes(ix.bytes)}</span>
									</div>
								{/each}
							</div>
						{/if}
					</section>
				</div>
			</div>
			{#if data.server.error}
				{@render sectionError(`Server settings: ${data.server.error}`)}
			{/if}
		</div>
	{/if}
</div>
