<script lang="ts">
	import { onMount } from 'svelte';
	import {
		ArrowUpRight,
		Container,
		Database,
		FileCode2,
		Lock,
		PencilLine,
		Plus,
		Radar,
		RefreshCw,
		Settings2,
		Trash2
	} from '@lucide/svelte';
	import { removeConnection } from '#lib/client/connections.ts';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import AccessBadge from '#lib/components/AccessBadge.svelte';
	import SourceBadge from '#lib/components/SourceBadge.svelte';
	import { api } from '#lib/client/api.ts';
	import { ago, COLORS } from '#lib/client/format.ts';
	import { connections, editor, isAdmin } from '#lib/client/state.svelte.ts';
	import type { QueryError } from '#lib/types.ts';

	type Status = { state: 'checking' } | { state: 'up'; latencyMs: number; version: string } | { state: 'down'; error: string; hint?: string };
	let status = $state<Record<string, Status>>({});

	async function check(id: string) {
		status[id] = { state: 'checking' };
		try {
			const r = await api.post<{ ok: true; version: string; latencyMs: number } | { ok: false; error: QueryError }>(
				`/api/connections/${id}/test`
			);
			status[id] = r.ok
				? { state: 'up', latencyMs: r.latencyMs, version: /PostgreSQL ([\d.]+)/.exec(r.version)?.[1] ?? '' }
				: { state: 'down', error: r.error.message, hint: r.error.hint };
		} catch (err) {
			status[id] = { state: 'down', error: String(err) };
		}
	}

	function checkAll() {
		const ids = connections.list.map((c) => c.id);
		let i = 0;
		const worker = async () => {
			while (i < ids.length) await check(ids[i++]);
		};
		for (let k = 0; k < 4; k++) worker();
	}

	onMount(checkAll);

	const stats = $derived([
		{ label: 'Connections', value: connections.list.length, icon: Database },
		{ label: 'Online', value: Object.values(status).filter((s) => s.state === 'up').length, icon: ArrowUpRight, tone: 'text-success' },
		{ label: 'Read-only', value: connections.list.filter((c) => c.readOnly).length, icon: Lock },
		{ label: 'Writable', value: connections.list.filter((c) => !c.readOnly).length, icon: PencilLine, tone: 'text-warning' }
	]);
</script>

<svelte:head><title>Overview · pg·modern</title></svelte:head>

<div class="h-full overflow-y-auto">
	<PageHeader title="Overview" description="Every Postgres in your homelab, in one place.">
		{#snippet actions()}
			<button class="btn btn-secondary" onclick={checkAll}><RefreshCw />Check all</button>
			{#if isAdmin()}
				<a class="btn btn-secondary" href="/discover"><Radar />Discover</a>
				<button class="btn btn-primary" onclick={() => (editor.target = 'new')}><Plus />New connection</button>
			{/if}
		{/snippet}
	</PageHeader>

	<div class="space-y-6 px-8 pb-10">
		<div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
			{#each stats as s (s.label)}
				<div class="card flex items-center justify-between p-4">
					<div>
						<p class="text-xs text-muted-foreground">{s.label}</p>
						<p class="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{s.value}</p>
					</div>
					<div class="grid size-9 place-items-center rounded-lg bg-primary-soft text-primary {s.tone ?? ''}">
						<s.icon class="size-4" />
					</div>
				</div>
			{/each}
		</div>

		{#if connections.list.length === 0}
			<div class="card relative overflow-hidden px-6 py-16 text-center">
				<div class="dot-grid mask-fade pointer-events-none absolute inset-0"></div>
				<div class="relative mx-auto max-w-md">
					<div class="mx-auto grid size-12 place-items-center rounded-xl bg-primary-soft text-primary"><Database class="size-6" /></div>
					<h2 class="mt-4 text-lg font-semibold tracking-tight">No connections yet</h2>
					<p class="mt-1.5 text-sm text-muted-foreground">
						Scan your Docker hosts and project folders for Postgres credentials, or add a connection by hand. New
						connections are read-only by default.
					</p>
					{#if isAdmin()}
						<div class="mt-6 flex justify-center gap-2">
							<a class="btn btn-primary" href="/discover"><Radar />Discover databases</a>
							<button class="btn btn-secondary" onclick={() => (editor.target = 'new')}><Plus />Add manually</button>
						</div>
					{:else}
						<p class="mt-4 text-xs text-muted-foreground">Ask an admin to add connections.</p>
					{/if}
				</div>
			</div>
		{:else}
			<div class="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
				{#each connections.list as c (c.id)}
					{@const s = status[c.id]}
					{@const color = COLORS[c.color] ?? COLORS.violet}
					<div class="card group relative overflow-hidden transition-shadow hover:shadow-surface-lg">
						<div class="pointer-events-none absolute -top-16 -right-16 size-40 rounded-full opacity-[0.12] blur-2xl" style="background:{color}"></div>
						<a href="/c/{c.id}" class="relative block p-4">
							<div class="flex items-start gap-3">
								<div class="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-surface" style="color:{color}">
									{#if c.source.kind === 'docker'}<Container class="size-4" />{:else if c.source.kind === 'env'}<FileCode2 class="size-4" />{:else}<Database class="size-4" />{/if}
								</div>
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-2">
										<h3 class="truncate text-[14px] font-semibold">{c.name}</h3>
										{#if s?.state === 'up'}
											<span class="size-1.5 rounded-full bg-success shadow-[0_0_6px_var(--success)]" title="Online"></span>
										{:else if s?.state === 'down'}
											<span class="size-1.5 rounded-full bg-danger" title={s.error}></span>
										{:else}
											<span class="size-1.5 animate-pulse rounded-full bg-muted-foreground/50"></span>
										{/if}
									</div>
									<p class="mt-0.5 truncate font-mono text-xs text-muted-foreground">
										{c.user}@{c.host}:{c.port}/{c.database}
									</p>
								</div>
							</div>
							<div class="mt-4 flex flex-wrap items-center gap-1.5">
								<AccessBadge readOnly={c.readOnly || !isAdmin()} />
								<SourceBadge source={c.source} />
								{#if s?.state === 'up'}
									<span class="badge font-mono">pg {s.version}</span>
									<span class="badge font-mono">{s.latencyMs} ms</span>
								{/if}
							</div>
							{#if s?.state === 'down'}
								<p class="mt-3 line-clamp-2 font-mono text-[11px] text-danger/90">{s.error}</p>
								{#if s.hint}<p class="mt-1 line-clamp-3 text-[11px] text-muted-foreground">{s.hint}</p>{/if}
							{/if}
						</a>
						<div class="relative flex items-center justify-between border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
							<span>Last used {ago(c.lastConnectedAt)}</span>
							{#if isAdmin()}
								<div class="-mr-2 flex items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
									<button class="btn btn-ghost btn-sm" onclick={() => (editor.target = c)}><Settings2 />Edit</button>
									<button class="btn btn-ghost btn-sm hover:text-danger" onclick={() => removeConnection(c)}><Trash2 />Remove</button>
								</div>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
