<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { Boxes, CircleAlert, Container, FileCode2, FolderSearch, LoaderCircle, Plus, Radar, RefreshCw, Server, X, Download, Power, Wifi, EyeOff, Network, Unplug, Copy } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import CandidateRow, { type Choice } from '#lib/components/CandidateRow.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { refreshConnections, toast } from '#lib/client/state.svelte.ts';
	import type { Candidate, Connection, DockerCandidateGroup, EnvScanResult, Manager, ManagerScan, SelfNetworks, Settings } from '#lib/types.ts';
	import { joinNetworksSnippet } from '#lib/client/format.ts';

	let tab = $state<'docker' | 'files' | 'managers'>('docker');
	let docker = $state<DockerCandidateGroup[] | null>(null);
	let files = $state<EnvScanResult | null>(null);
	let loadingDocker = $state(false);
	let loadingFiles = $state(false);
	let managerScans = $state<ManagerScan[] | null>(null);
	let managerCount = $state(0);
	let loadingManagers = $state(false);
	let importing = $state(false);
	let settings = $state<Settings>({ scanPaths: [], dockerHosts: [] });
	let envRoots = $state<string[]>([]);
	let newPath = $state('');
	let choices = $state<Record<string, Choice>>({});

	// Top-level filters, remembered per browser.
	const FILTER_KEY = 'pgm-discover-filters';
	let filters = $state({ running: false, reachable: false, unsaved: false });
	$effect.pre(() => {
		try {
			Object.assign(filters, JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}'));
		} catch {}
	});
	$effect(() => {
		const snapshot = JSON.stringify(filters);
		try {
			localStorage.setItem(FILTER_KEY, snapshot);
		} catch {}
	});

	const keep = (c: Candidate) =>
		(!filters.reachable || c.reachable === true) && (!filters.unsaved || !c.saved || c.saved.addressChanged);

	/** Points the saved connection at the address chosen for this candidate. */
	async function relink(c: Candidate, address: { host: string; port: number }) {
		try {
			await api.post('/api/discover/relink', { key: c.key, connectionId: c.saved!.id, host: address.host, port: address.port });
			c.saved = { ...c.saved!, host: address.host, port: address.port, addressChanged: false };
			await refreshConnections();
			toast('success', 'Connection updated', `${c.saved.name} now uses ${address.host}:${address.port}`);
		} catch (err) {
			toast('error', 'Could not update connection', errorMessage(err));
		}
	}

	const visibleDocker = $derived(
		(docker ?? []).map((g) => ({
			...g,
			containers: g.containers
				.filter((c) => !filters.running || c.state === 'running')
				.map((c) => ({ ...c, candidates: c.candidates.filter(keep) }))
				.filter((c) => c.candidates.length)
		}))
	);
	const OTHER_DB = /mongo|redis|valkey|keydb|influx|clickhouse|elastic|opensearch|couch|neo4j|cassandra|mssql|sqlserver|dragonfly|memcached|etcd/i;
	const otherEngine = (image: string) => OTHER_DB.exec(image)?.[0].toLowerCase();

	const runningStatus = (s: string) => /running|up/i.test(s) && !/^stopped/i.test(s);
	const visibleManagers = $derived(
		(managerScans ?? []).map((m) => ({
			...m,
			environments: m.environments.map((e) => ({
				...e,
				projects: e.projects
					.filter((p) => !filters.running || runningStatus(p.status))
					.map((p) => ({ ...p, candidates: p.candidates.filter(keep) }))
					.filter((p) => p.candidates.length)
			}))
		}))
	);
	const visibleFiles = $derived(
		(files?.files ?? []).map((f) => ({ ...f, candidates: f.candidates.filter(keep) })).filter((f) => f.candidates.length)
	);

	function track(candidates: Candidate[]) {
		for (const c of candidates) {
			if (c.key && !choices[c.key]) {
				choices[c.key] = { selected: false, name: c.name, address: 0, readOnly: true, password: '' };
			}
		}
	}

	async function scanDocker() {
		loadingDocker = true;
		try {
			docker = await api.get<DockerCandidateGroup[]>('/api/discover/docker');
			track(docker.flatMap((g) => g.containers.flatMap((c) => c.candidates)));
		} catch (err) {
			toast('error', 'Docker scan failed', errorMessage(err));
		} finally {
			loadingDocker = false;
		}
	}

	async function scanFiles() {
		loadingFiles = true;
		try {
			files = await api.post<EnvScanResult>('/api/discover/files');
			track(files.files.flatMap((f) => f.candidates));
		} catch (err) {
			toast('error', 'File scan failed', errorMessage(err));
		} finally {
			loadingFiles = false;
		}
	}

	async function scanManagers() {
		loadingManagers = true;
		try {
			managerScans = await api.get<ManagerScan[]>('/api/discover/managers');
			track(managerScans.flatMap((m) => m.environments.flatMap((e) => e.projects.flatMap((p) => p.candidates))));
		} catch (err) {
			toast('error', 'Arcane scan failed', errorMessage(err));
		} finally {
			loadingManagers = false;
		}
	}

	async function saveRoots(scanPaths: string[]) {
		settings = await api.put<Settings>('/api/settings', { ...settings, scanPaths });
	}

	async function addRoot(e: SubmitEvent) {
		e.preventDefault();
		if (!newPath.trim()) return;
		await saveRoots([...settings.scanPaths, newPath.trim()]);
		newPath = '';
		scanFiles();
	}

	onMount(async () => {
		const s = await api.get<{ settings: Settings; env: { scanPaths: string[] } }>('/api/settings');
		settings = s.settings;
		envRoots = s.env.scanPaths;
		scanDocker();
		if (settings.scanPaths.length || envRoots.length) scanFiles();
		managerCount = (await api.get<Manager[]>('/api/managers')).length;
		if (managerCount) scanManagers();
	});

	// Only what's visible can be imported, so filters never import hidden rows by surprise.
	const all = $derived([
		...visibleDocker.flatMap((g) => g.containers.flatMap((c) => c.candidates)),
		...visibleFiles.flatMap((f) => f.candidates),
		...visibleManagers.flatMap((m) => m.environments.flatMap((e) => e.projects.flatMap((p) => p.candidates)))
	]);
	const selected = $derived(all.filter((c) => c.key && choices[c.key]?.selected));
	const dockerTotal = $derived((docker ?? []).reduce((n, g) => n + g.containers.reduce((m, c) => m + c.candidates.length, 0), 0));
	const fileTotal = $derived((files?.files ?? []).reduce((n, f) => n + f.candidates.length, 0));
	const dockerCount = $derived(visibleDocker.reduce((n, g) => n + g.containers.reduce((m, c) => m + c.candidates.length, 0), 0));
	const fileCount = $derived(visibleFiles.reduce((n, f) => n + f.candidates.length, 0));
	const countManagers = (scans: ManagerScan[]) =>
		scans.reduce((n, m) => n + m.environments.reduce((a, e) => a + e.projects.reduce((b, p) => b + p.candidates.length, 0), 0), 0);
	const managersTotal = $derived(countManagers(managerScans ?? []));
	const managersVisible = $derived(countManagers(visibleManagers));
	const hidden = $derived(
		tab === 'docker' ? dockerTotal - dockerCount : tab === 'files' ? fileTotal - fileCount : managersTotal - managersVisible
	);

	// Where pg·modern itself sits, as seen by the scan behind the current tab.
	const selfInfo = $derived.by((): SelfNetworks | undefined => {
		const all =
			tab === 'docker'
				? (docker ?? []).map((g) => g.self)
				: tab === 'files'
					? [files?.self]
					: (managerScans ?? []).flatMap((m) => m.environments.map((e) => e.self));
		const known = all.filter((x): x is SelfNetworks => !!x);
		return known.find((x) => x.container) ?? known[0];
	});
	const tabCandidates = $derived(
		tab === 'docker'
			? (docker ?? []).flatMap((g) => g.containers.flatMap((c) => c.candidates))
			: tab === 'files'
				? (files?.files ?? []).flatMap((f) => f.candidates)
				: (managerScans ?? []).flatMap((m) => m.environments.flatMap((e) => e.projects.flatMap((p) => p.candidates)))
	);
	// Networks that would give pg·modern a route to databases it can't reach today.
	const joinable = $derived.by(() => {
		const byNet = new Map<string, Set<string>>();
		for (const c of tabCandidates) {
			if (c.reachable || c.network?.via !== 'none' || !c.network.join) continue;
			const set = byNet.get(c.network.join) ?? new Set();
			set.add(c.name);
			byNet.set(c.network.join, set);
		}
		return [...byNet].map(([network, names]) => ({ network, names: [...names] })).sort((a, b) => b.names.length - a.names.length);
	});
	const stranded = $derived(joinable.reduce((n, j) => n + j.names.length, 0));
	let showJoin = $state(false);

	/** Path relative to the scan folder it was found in (the full path is in the tooltip). */
	function relativePath(path: string) {
		const root = files?.roots.find((r) => path.startsWith(`${r}/`));
		return root ? path.slice(root.length + 1) : path;
	}

	async function importSelected() {
		importing = true;
		try {
			const items = selected.map((c) => {
				const ch = choices[c.key!];
				const addr = ch.address === 0 ? null : c.alternates?.[ch.address - 1];
				return {
					key: c.key,
					name: ch.name,
					host: addr?.host,
					port: addr?.port,
					readOnly: ch.readOnly,
					password: ch.password || undefined
				};
			});
			const res = await api.post<{ created: Connection[]; missing: string[] }>('/api/discover/import', { items });
			await refreshConnections();
			if (res.missing.length) toast('error', `${res.missing.length} item(s) expired`, 'Rescan and try again.');
			if (res.created.length) {
				toast('success', `Imported ${res.created.length} connection${res.created.length === 1 ? '' : 's'}`);
				goto(res.created.length === 1 ? `/c/${res.created[0].id}` : '/');
			}
		} catch (err) {
			toast('error', 'Import failed', errorMessage(err));
		} finally {
			importing = false;
		}
	}
</script>

<svelte:head><title>Discover · pg·modern</title></svelte:head>

<div class="flex h-full flex-col">
	<div class="min-h-0 flex-1 overflow-y-auto">
		<PageHeader title="Discover" description="Find Postgres, MySQL and MariaDB servers in containers, .env, compose and Terraform files, and Arcane projects.">
			{#snippet actions()}
				<button
					class="btn btn-secondary"
					disabled={loadingDocker || loadingFiles || loadingManagers}
					onclick={() => (tab === 'docker' ? scanDocker() : tab === 'files' ? scanFiles() : scanManagers())}
				>
					{#if loadingDocker || loadingFiles || loadingManagers}<LoaderCircle class="animate-spin" />{:else}<RefreshCw />{/if}Rescan
				</button>
			{/snippet}
		</PageHeader>

		<div class="px-8 pb-28">
			<div class="mb-5 flex flex-wrap items-center gap-3">
			<div class="inline-flex rounded-lg border border-border bg-surface p-0.5">
				{#each [{ id: 'docker', label: 'Containers', icon: Container, count: dockerCount }, { id: 'files', label: 'Files', icon: FileCode2, count: fileCount }, { id: 'managers', label: 'Arcane', icon: Boxes, count: managersVisible }] as t (t.id)}
					<button
						class="flex h-7 items-center gap-2 rounded-md px-3 text-[13px] font-medium transition {tab === t.id
							? 'bg-card text-foreground shadow-surface'
							: 'text-muted-foreground hover:text-foreground'}"
						onclick={() => (tab = t.id as typeof tab)}
					>
						<t.icon class="size-3.5" />{t.label}
						{#if t.count}<span class="rounded bg-primary-soft px-1.5 text-[11px] text-primary tabular-nums">{t.count}</span>{/if}
					</button>
				{/each}
			</div>

			<div class="flex items-center gap-1.5">
				{#if tab !== 'files'}
					<button
						class="btn btn-sm {filters.running ? 'btn-secondary text-primary' : 'btn-ghost'}"
						aria-pressed={filters.running}
						title="Hide stopped and exited containers"
						onclick={() => (filters.running = !filters.running)}
					>
						<Power />Running only
					</button>
				{/if}
				<button
					class="btn btn-sm {filters.reachable ? 'btn-secondary text-primary' : 'btn-ghost'}"
					aria-pressed={filters.reachable}
					title="Hide servers pg·modern can't open a TCP connection to"
					onclick={() => (filters.reachable = !filters.reachable)}
				>
					<Wifi />Reachable only
				</button>
				<button
					class="btn btn-sm {filters.unsaved ? 'btn-secondary text-primary' : 'btn-ghost'}"
					aria-pressed={filters.unsaved}
					title="Hide databases that are already saved (ones whose address changed stay visible)"
					onclick={() => (filters.unsaved = !filters.unsaved)}
				>
					<EyeOff />Hide saved
				</button>
				{#if hidden > 0}
					<span class="text-[11px] text-muted-foreground">
						{hidden} hidden ·
						<button class="text-primary hover:underline" onclick={() => ((filters.running = false), (filters.reachable = false), (filters.unsaved = false))}>show all</button>
					</span>
				{/if}
			</div>
			</div>

			{#if selfInfo}
				<div class="mb-3 flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
					<Network class="size-3.5" />
					{#if selfInfo.container}
						pg·modern runs as <span class="font-mono text-foreground">{selfInfo.container}</span> on
						{#each selfInfo.networks as n (n)}<span class="rounded-md border border-success/30 bg-success/10 px-1.5 py-px font-mono text-[11px] text-success">{n}</span>{/each}
						<span>— databases on these networks are reachable by name.</span>
					{:else if selfInfo.inContainer}
						pg·modern isn’t one of this host’s containers, so only published ports are reachable from it.
					{:else}
						pg·modern isn’t running in a container; it reaches databases through published ports and container IPs.
					{/if}
				</div>
			{/if}
			{#if joinable.length}
				<div class="card mb-4 border-warning/30 p-3.5 text-[12px]">
					<div class="flex flex-wrap items-center gap-2">
						<Unplug class="size-4 text-warning" />
						<span class="text-foreground">
							{stranded === 1 ? '1 database has' : `${stranded} databases have`} no route from pg·modern.
							Attaching it to {joinable.length === 1 ? 'one network' : `${joinable.length} networks`} would fix that.
						</span>
						<button class="btn btn-secondary btn-sm ml-auto" onclick={() => (showJoin = !showJoin)}>{showJoin ? 'Hide' : 'Show'} compose change</button>
					</div>
					{#if showJoin}
						<ul class="mt-3 space-y-1 text-muted-foreground">
							{#each joinable as j (j.network)}
								<li><span class="font-mono text-foreground">{j.network}</span> — {j.names.join(', ')}</li>
							{/each}
						</ul>
						<div class="relative mt-2">
							<pre class="overflow-x-auto rounded-lg border border-border bg-surface p-3 font-mono text-[11px] text-foreground">{joinNetworksSnippet(joinable.map((j) => j.network))}</pre>
							<button
								class="btn btn-ghost btn-icon btn-sm absolute top-1.5 right-1.5"
								title="Copy"
								onclick={() => navigator.clipboard.writeText(joinNetworksSnippet(joinable.map((j) => j.network))).then(() => toast('success', 'Copied'))}
							>
								<Copy />
							</button>
						</div>
						<p class="mt-2 text-muted-foreground">Add this to pg·modern’s compose file and run <span class="font-mono">docker compose up -d</span>, then rescan.</p>
					{/if}
				</div>
			{/if}

			{#if tab === 'docker'}
				{#if loadingDocker && !docker}
					<div class="card flex items-center gap-3 p-6 text-sm text-muted-foreground"><LoaderCircle class="size-4 animate-spin" />Inspecting containers…</div>
				{:else if docker && docker.length === 0}
					<div class="card p-8 text-center text-sm text-muted-foreground">
						<Server class="mx-auto mb-3 size-6 opacity-60" />
						No Docker endpoint configured. Mount <code class="font-mono">/var/run/docker.sock</code> or add a
						<code class="font-mono">tcp://</code> host in <a href="/integrations#docker" class="text-primary">Integrations</a>.
					</div>
				{:else if docker}
					<div class="space-y-5">
						{#each visibleDocker as group (group.endpoint)}
							<section>
								<div class="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
									<Server class="size-3.5" /><span class="font-mono">{group.endpoint}</span>
									{#if group.inspected !== undefined}
										<span>· inspected {group.inspected} container{group.inspected === 1 ? '' : 's'}, {group.inspected - (group.skipped?.length ?? 0)} with a database or database credentials</span>
									{/if}
								</div>
								{#if group.error}
									<div class="mb-3 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 p-3 text-xs">
										<CircleAlert class="mt-px size-4 shrink-0 text-danger" /><span>{group.error}</span>
									</div>
								{/if}
								{#if !group.error && group.containers.length === 0}
									<div class="card p-6 text-center text-sm text-muted-foreground">
										{hidden > 0 ? 'Nothing matches the current filters.' : 'No database containers or credentials found on this host.'}
									</div>
								{/if}
								<div class="space-y-3">
									{#each group.containers as c (c.id)}
										<div class="card overflow-hidden">
											<div class="flex items-center gap-3 border-b border-border bg-surface px-4 py-2.5">
												<span class="size-2 rounded-full {c.state === 'running' ? 'bg-success shadow-[0_0_6px_var(--success)]' : 'bg-muted-foreground/40'}"></span>
												<span class="text-[13px] font-medium">{c.name}</span>
												<span class="truncate font-mono text-[11px] text-muted-foreground">{c.image}</span>
												<span class="ml-auto text-[11px] text-muted-foreground">{c.status}</span>
											</div>
											<div class="divide-y divide-border">
												{#each c.candidates as cand, i (i)}
													{#if cand.key && choices[cand.key]}
														<CandidateRow candidate={cand} bind:choice={choices[cand.key]} onrelink={(a) => relink(cand, a)} />
													{/if}
												{/each}
											</div>
										</div>
									{/each}
								</div>
								{#if group.skipped?.length}
									<details class="card mt-3 overflow-hidden">
										<summary class="cursor-pointer px-4 py-2.5 text-xs text-muted-foreground select-none hover:text-foreground">
											{group.skipped.length} other container{group.skipped.length === 1 ? '' : 's'} without a database
											{#if group.skipped.some((c) => otherEngine(c.image))}
												<span class="ml-1">— includes {[...new Set(group.skipped.map((c) => otherEngine(c.image)).filter(Boolean))].join(', ')}, which pg·modern doesn't support</span>
											{/if}
										</summary>
										<div class="max-h-80 divide-y divide-border overflow-y-auto border-t border-border">
											{#each group.skipped as c (c.id)}
												<div class="flex items-center gap-3 px-4 py-1.5 text-xs">
													<span class="size-1.5 shrink-0 rounded-full {c.state === 'running' ? 'bg-success' : 'bg-muted-foreground/40'}"></span>
													<span class="w-56 shrink-0 truncate font-medium">{c.name}</span>
													<span class="min-w-0 flex-1 truncate font-mono text-muted-foreground">{c.image}</span>
													{#if otherEngine(c.image)}<span class="badge">{otherEngine(c.image)} · not supported</span>{/if}
												</div>
											{/each}
										</div>
									</details>
								{/if}
							</section>
						{/each}
						{#if docker.every((g) => g.endpoint.startsWith('unix://'))}
							<p class="text-[11px] text-muted-foreground">
								Only the Docker on the machine running pg·modern is scanned. Databases on other hosts? Connect
								<a class="text-primary" href="/integrations#arcane">Arcane</a> or add a <a class="text-primary" href="/integrations#docker">tcp:// endpoint</a>.
							</p>
						{/if}
					</div>
				{/if}
			{:else if tab === 'managers'}
				{#if !managerCount}
					<div class="card relative overflow-hidden px-6 py-12 text-center">
						<div class="dot-grid mask-fade pointer-events-none absolute inset-0"></div>
						<div class="relative mx-auto max-w-md">
							<div class="mx-auto grid size-11 place-items-center rounded-xl bg-primary-soft text-primary"><Boxes class="size-5" /></div>
							<h2 class="mt-4 font-semibold tracking-tight">Read stacks straight from Arcane</h2>
							<p class="mt-1.5 text-sm text-muted-foreground">
								Connect an Arcane instance with an API key and pg·modern finds Postgres, MySQL and MariaDB in every container and project across all of its
								environments — no folder mounts or file permissions needed.
							</p>
							<a class="btn btn-primary mt-5" href="/integrations#arcane"><Plus />Connect Arcane</a>
						</div>
					</div>
				{:else if loadingManagers && !managerScans}
					<div class="card flex items-center gap-3 p-6 text-sm text-muted-foreground"><LoaderCircle class="size-4 animate-spin" />Reading projects from Arcane…</div>
				{:else if managerScans}
					<div class="space-y-6">
						{#each visibleManagers as m (m.manager.id)}
							<section class="space-y-4">
								<div class="flex items-center gap-2 text-xs text-muted-foreground">
									<Boxes class="size-3.5" /><span class="font-medium text-foreground">{m.manager.name}</span><span class="font-mono">{m.manager.url}</span>
									{#if m.error}<span class="badge badge-danger">{m.error}</span>{/if}
								</div>
								{#each m.environments as env (env.id)}
									<div>
										<div class="mb-2 flex items-center gap-2 pl-1 text-xs text-muted-foreground">
											<Server class="size-3.5" />{env.name}<span class="font-mono opacity-70">{env.host}</span>
											{#if env.error}<span class="badge badge-danger">{env.error}</span>{/if}
										</div>
										{#if env.projectsRead !== undefined || env.containersInspected !== undefined}
											<p class="mb-2 pl-1 text-[11px] text-muted-foreground">
												Read {env.projectsRead ?? 0} project{env.projectsRead === 1 ? '' : 's'}{#if env.containersInspected !== undefined}{' '}and inspected {env.containersInspected} container{env.containersInspected === 1 ? '' : 's'}{/if}.
											</p>
										{/if}
										{#if env.warning}
											<p class="mb-2 flex items-center gap-1.5 pl-1 text-[11px] text-warning"><CircleAlert class="size-3.5 shrink-0" />{env.warning}</p>
										{/if}
										{#each env.parseErrors ?? [] as pe (pe.project)}
											<p class="mb-2 flex items-center gap-1.5 pl-1 text-[11px] text-warning">
												<CircleAlert class="size-3.5 shrink-0" />{pe.project}: compose file didn't parse cleanly ({pe.message}); results may be incomplete.
											</p>
										{/each}
										{#if !env.error && !env.projects.length}
											<div class="card p-4 text-center text-xs text-muted-foreground">
												{hidden > 0 ? 'Nothing matches the current filters.' : 'No databases found in this environment’s projects.'}
											</div>
										{/if}
										<div class="space-y-3">
											{#each env.projects as p (p.id)}
												<div class="card overflow-hidden">
													<div class="flex items-center gap-3 border-b border-border bg-surface px-4 py-2.5">
														<span class="size-2 rounded-full {runningStatus(p.status) ? 'bg-success shadow-[0_0_6px_var(--success)]' : 'bg-muted-foreground/40'}"></span>
														<span class="text-[13px] font-medium">{p.name}</span>
														<span class="ml-auto text-[11px] text-muted-foreground capitalize">{p.status}</span>
													</div>
													<div class="divide-y divide-border">
														{#each p.candidates as cand, i (i)}
															{#if cand.key && choices[cand.key]}
																<CandidateRow candidate={cand} bind:choice={choices[cand.key]} onrelink={(a) => relink(cand, a)} />
															{/if}
														{/each}
													</div>
												</div>
											{/each}
										</div>
										{#if env.skipped?.length}
											<details class="card mt-3 overflow-hidden">
												<summary class="cursor-pointer px-4 py-2.5 text-xs text-muted-foreground select-none hover:text-foreground">
													{env.skipped.length} other container{env.skipped.length === 1 ? '' : 's'} without a database
												</summary>
												<div class="max-h-80 divide-y divide-border overflow-y-auto border-t border-border">
													{#each env.skipped as c, i (i)}
														<div class="flex items-center gap-3 px-4 py-1.5 text-xs">
															<span class="size-1.5 shrink-0 rounded-full {c.state === 'running' ? 'bg-success' : 'bg-muted-foreground/40'}"></span>
															<span class="w-56 shrink-0 truncate font-medium">{c.name}</span>
															<span class="min-w-0 flex-1 truncate font-mono text-muted-foreground">{c.image}</span>
															{#if otherEngine(c.image)}<span class="badge">{otherEngine(c.image)} · not supported</span>{/if}
														</div>
													{/each}
												</div>
											</details>
										{/if}
									</div>
								{/each}
							</section>
						{/each}
					</div>
				{/if}
			{:else}
				<div class="card mb-5 p-4">
					<div class="mb-3 flex items-center gap-2 text-[13px] font-medium"><FolderSearch class="size-4 text-primary" />Scan folders</div>
					<div class="flex flex-wrap gap-1.5">
						{#each envRoots as root (root)}
							<span class="badge h-6 font-mono" title="Set via PGM_SCAN_PATHS">{root}</span>
						{/each}
						{#each settings.scanPaths as root (root)}
							<span class="badge h-6 pr-0.5 font-mono">
								{root}
								<button class="rounded p-0.5 hover:bg-accent" aria-label="Remove" onclick={() => saveRoots(settings.scanPaths.filter((p) => p !== root))}><X /></button>
							</span>
						{/each}
						{#if !envRoots.length && !settings.scanPaths.length}
							<span class="text-xs text-muted-foreground">No folders yet — add the directories holding your stacks (e.g. <code class="font-mono">/opt/stacks</code>).</span>
						{/if}
					</div>
					<form class="mt-3 flex gap-2" onsubmit={addRoot}>
						<input class="input h-8 font-mono text-xs" placeholder="/opt/stacks or ~/docker" bind:value={newPath} />
						<button class="btn btn-secondary" disabled={!newPath.trim()}><Plus />Add</button>
						<button type="button" class="btn btn-primary" disabled={loadingFiles} onclick={scanFiles}>
							{#if loadingFiles}<LoaderCircle class="animate-spin" />{:else}<Radar />{/if}Scan
						</button>
					</form>
					{#if files}
						<p class="mt-3 text-[11px] text-muted-foreground">
							Checked {files.filesScanned} .env / compose / Terraform file{files.filesScanned === 1 ? '' : 's'} in {files.durationMs} ms.
							{#if files.errors.length}<span class="text-warning">{files.errors.length} folder(s) unreadable: {files.errors.slice(0, 3).join(', ')}</span>{/if}
						</p>
					{/if}
				</div>

				{#if files}
					{#if visibleFiles.length === 0}
						<div class="card p-8 text-center text-sm text-muted-foreground">
							{hidden > 0 ? 'Nothing matches the current filters.' : 'No database credentials found in the scanned folders.'}
						</div>
					{/if}
					<div class="space-y-3">
						{#each visibleFiles as f (f.path)}
							<div class="card overflow-hidden">
								<div class="flex items-center gap-2 border-b border-border bg-surface px-4 py-2.5">
									<FileCode2 class="size-3.5 text-muted-foreground" />
									<span class="truncate font-mono text-xs" title={f.path}>{relativePath(f.path)}</span>
								</div>
								<div class="divide-y divide-border">
									{#each f.candidates as cand, i (i)}
										{#if cand.key && choices[cand.key]}
											<CandidateRow candidate={cand} bind:choice={choices[cand.key]} onrelink={(a) => relink(cand, a)} />
										{/if}
									{/each}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			{/if}
		</div>
	</div>

	{#if selected.length}
		<div class="pointer-events-none absolute inset-x-0 bottom-5 flex justify-center">
			<div class="card pointer-events-auto flex items-center gap-4 py-2 pr-2 pl-4 shadow-surface-lg backdrop-blur">
				<span class="text-[13px]"><span class="font-semibold tabular-nums">{selected.length}</span> selected</span>
				<button class="btn btn-ghost btn-sm" onclick={() => selected.forEach((c) => (choices[c.key!].selected = false))}>Clear</button>
				<button class="btn btn-primary" disabled={importing} onclick={importSelected}>
					{#if importing}<LoaderCircle class="animate-spin" />{:else}<Download />{/if}Import {selected.length}
				</button>
			</div>
		</div>
	{/if}
</div>
