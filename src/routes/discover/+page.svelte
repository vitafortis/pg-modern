<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { Container, FileCode2, FolderSearch, LoaderCircle, Plus, Radar, RefreshCw, Server, X, Download, Power, Wifi } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import CandidateRow, { type Choice } from '#lib/components/CandidateRow.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { refreshConnections, toast } from '#lib/client/state.svelte.ts';
	import type { Candidate, Connection, DockerCandidateGroup, EnvScanResult, Settings } from '#lib/types.ts';

	let tab = $state<'docker' | 'files'>('docker');
	let docker = $state<DockerCandidateGroup[] | null>(null);
	let files = $state<EnvScanResult | null>(null);
	let loadingDocker = $state(false);
	let loadingFiles = $state(false);
	let importing = $state(false);
	let settings = $state<Settings>({ scanPaths: [], dockerHosts: [] });
	let envRoots = $state<string[]>([]);
	let newPath = $state('');
	let choices = $state<Record<string, Choice>>({});

	// Top-level filters, remembered per browser.
	const FILTER_KEY = 'pgm-discover-filters';
	let filters = $state({ running: false, reachable: false });
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

	const keep = (c: Candidate) => !filters.reachable || c.reachable === true;

	const visibleDocker = $derived(
		(docker ?? []).map((g) => ({
			...g,
			containers: g.containers
				.filter((c) => !filters.running || c.state === 'running')
				.map((c) => ({ ...c, candidates: c.candidates.filter(keep) }))
				.filter((c) => c.candidates.length)
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
	});

	// Only what's visible can be imported, so filters never import hidden rows by surprise.
	const all = $derived([
		...visibleDocker.flatMap((g) => g.containers.flatMap((c) => c.candidates)),
		...visibleFiles.flatMap((f) => f.candidates)
	]);
	const selected = $derived(all.filter((c) => c.key && choices[c.key]?.selected));
	const dockerTotal = $derived((docker ?? []).reduce((n, g) => n + g.containers.reduce((m, c) => m + c.candidates.length, 0), 0));
	const fileTotal = $derived((files?.files ?? []).reduce((n, f) => n + f.candidates.length, 0));
	const dockerCount = $derived(visibleDocker.reduce((n, g) => n + g.containers.reduce((m, c) => m + c.candidates.length, 0), 0));
	const fileCount = $derived(visibleFiles.reduce((n, f) => n + f.candidates.length, 0));
	const hidden = $derived(tab === 'docker' ? dockerTotal - dockerCount : fileTotal - fileCount);

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
		<PageHeader title="Discover" description="Find Postgres servers in running containers and credentials in .env and compose files.">
			{#snippet actions()}
				<button class="btn btn-secondary" disabled={loadingDocker || loadingFiles} onclick={() => (tab === 'docker' ? scanDocker() : scanFiles())}>
					{#if loadingDocker || loadingFiles}<LoaderCircle class="animate-spin" />{:else}<RefreshCw />{/if}Rescan
				</button>
			{/snippet}
		</PageHeader>

		<div class="px-8 pb-28">
			<div class="mb-5 flex flex-wrap items-center gap-3">
			<div class="inline-flex rounded-lg border border-border bg-surface p-0.5">
				{#each [{ id: 'docker', label: 'Containers', icon: Container, count: dockerCount }, { id: 'files', label: 'Files', icon: FileCode2, count: fileCount }] as t (t.id)}
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
				{#if tab === 'docker'}
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
				{#if hidden > 0}
					<span class="text-[11px] text-muted-foreground">
						{hidden} hidden ·
						<button class="text-primary hover:underline" onclick={() => ((filters.running = false), (filters.reachable = false))}>show all</button>
					</span>
				{/if}
			</div>
			</div>

			{#if tab === 'docker'}
				{#if loadingDocker && !docker}
					<div class="card flex items-center gap-3 p-6 text-sm text-muted-foreground"><LoaderCircle class="size-4 animate-spin" />Inspecting containers…</div>
				{:else if docker && docker.length === 0}
					<div class="card p-8 text-center text-sm text-muted-foreground">
						<Server class="mx-auto mb-3 size-6 opacity-60" />
						No Docker endpoint configured. Mount <code class="font-mono">/var/run/docker.sock</code> or add a
						<code class="font-mono">tcp://</code> host in <a href="/settings" class="text-primary">Settings</a>.
					</div>
				{:else if docker}
					<div class="space-y-5">
						{#each visibleDocker as group (group.endpoint)}
							<section>
								<div class="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
									<Server class="size-3.5" /><span class="font-mono">{group.endpoint}</span>
									{#if group.error}<span class="badge badge-danger">{group.error}</span>{/if}
								</div>
								{#if !group.error && group.containers.length === 0}
									<div class="card p-6 text-center text-sm text-muted-foreground">
										{hidden > 0 ? 'Nothing matches the current filters.' : 'No Postgres containers or database credentials found on this host.'}
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
														<CandidateRow candidate={cand} bind:choice={choices[cand.key]} />
													{/if}
												{/each}
											</div>
										</div>
									{/each}
								</div>
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
							Checked {files.filesScanned} .env / compose file{files.filesScanned === 1 ? '' : 's'} in {files.durationMs} ms.
							{#if files.errors.length}<span class="text-warning">{files.errors.length} folder(s) unreadable: {files.errors.slice(0, 3).join(', ')}</span>{/if}
						</p>
					{/if}
				</div>

				{#if files}
					{#if visibleFiles.length === 0}
						<div class="card p-8 text-center text-sm text-muted-foreground">
							{hidden > 0 ? 'Nothing matches the current filters.' : 'No Postgres credentials found in the scanned folders.'}
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
											<CandidateRow candidate={cand} bind:choice={choices[cand.key]} />
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
