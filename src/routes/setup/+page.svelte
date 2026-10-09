<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { ArrowRight, Boxes, Check, CircleAlert, CircleCheck, Container, FolderSearch, LoaderCircle, Plus, Radar, UserRound, X, Zap } from '@lucide/svelte';
	import Logo from '#lib/components/Logo.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import type { Settings } from '#lib/types.ts';

	let step = $state<1 | 2 | 3>(1);
	let busy = $state(false);
	let error = $state('');

	// Step 1 — the first admin.
	let name = $state('');
	let email = $state('');
	let password = $state('');
	let repeat = $state('');

	async function createAdmin(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		if (password !== repeat) {
			error = 'Passwords do not match';
			return;
		}
		busy = true;
		try {
			await api.post('/api/auth/setup', { name, email, password });
			await loadSources();
			step = 2;
		} catch (err) {
			error = errorMessage(err);
		} finally {
			busy = false;
		}
	}

	// Step 2 — optional sources.
	let env = $state<{ dockerHosts: string[]; scanPaths: string[]; inContainer: boolean } | null>(null);
	let settings = $state<Settings>({ scanPaths: [], dockerHosts: [] });
	let arcane = $state({ url: '', apiKey: '' });
	let arcaneState = $state<'idle' | 'testing' | 'connected' | { error: string }>('idle');
	let arcaneEnvs = $state(0);
	let folder = $state('');

	async function loadSources() {
		const s = await api.get<{ settings: Settings; env: { dockerHosts: string[]; scanPaths: string[]; inContainer: boolean } }>('/api/settings');
		env = s.env;
		settings = s.settings;
	}

	async function connectArcane(e: SubmitEvent) {
		e.preventDefault();
		arcaneState = 'testing';
		const r = await api.post<{ ok: true; environments: number } | { ok: false; error: string }>('/api/managers/test', arcane);
		if (!r.ok) {
			arcaneState = { error: r.error };
			return;
		}
		await api.post('/api/managers', { name: 'Arcane', ...arcane });
		arcaneEnvs = r.environments;
		arcaneState = 'connected';
	}

	async function addFolder(e: SubmitEvent) {
		e.preventDefault();
		if (!folder.trim()) return;
		settings = await api.put<Settings>('/api/settings', { ...settings, scanPaths: [...settings.scanPaths, folder.trim()] });
		folder = '';
	}

	async function finish() {
		await invalidateAll();
		goto('/discover');
	}

	const steps = [
		{ n: 1, label: 'Admin account' },
		{ n: 2, label: 'Sources' },
		{ n: 3, label: 'Done' }
	];
</script>

<svelte:head><title>Set up · pg·modern</title></svelte:head>

<div class="relative grid min-h-dvh place-items-center overflow-hidden px-4 py-10">
	<div class="dot-grid mask-fade pointer-events-none absolute inset-0 opacity-70"></div>
	<div class="glow-top pointer-events-none absolute inset-x-0 top-0 h-[480px]"></div>

	<div class="relative w-full max-w-lg">
		<div class="mb-6 flex flex-col items-center text-center">
			<Logo size={44} />
			<h1 class="mt-4 text-lg font-semibold tracking-tight">Welcome to pg·modern</h1>
			<p class="mt-1 text-[13px] text-muted-foreground">A couple of minutes and you're browsing your databases.</p>
		</div>

		<ol class="mb-5 flex items-center justify-center gap-2 text-xs">
			{#each steps as s, i (s.n)}
				<li class="flex items-center gap-2 {step >= s.n ? 'text-foreground' : 'text-muted-foreground'}">
					<span
						class="grid size-5 place-items-center rounded-full text-[10px] font-semibold {step > s.n
							? 'bg-primary text-primary-foreground'
							: step === s.n
								? 'bg-primary-soft text-primary ring-1 ring-primary/50'
								: 'bg-muted'}"
					>
						{#if step > s.n}<Check class="size-3" />{:else}{s.n}{/if}
					</span>
					{s.label}
				</li>
				{#if i < steps.length - 1}<span class="h-px w-8 bg-border"></span>{/if}
			{/each}
		</ol>

		<div class="card p-7 shadow-surface-lg">
			{#if step === 1}
				<form onsubmit={createAdmin}>
					<h2 class="flex items-center gap-2 text-[15px] font-semibold"><UserRound class="size-4 text-primary" />Create the admin account</h2>
					<p class="mt-1 text-xs text-muted-foreground">This account manages connections, integrations and users. You can add more people later, or turn on single sign-on.</p>
					<div class="mt-5 grid gap-3">
						<div>
							<label class="label" for="s-name">Your name</label>
							<!-- svelte-ignore a11y_autofocus -->
							<input id="s-name" class="input" autocomplete="name" autofocus bind:value={name} />
						</div>
						<div>
							<label class="label" for="s-email">Email</label>
							<input id="s-email" class="input" type="email" autocomplete="email" required bind:value={email} />
						</div>
						<div class="grid grid-cols-2 gap-3">
							<div>
								<label class="label" for="s-pw">Password</label>
								<input id="s-pw" class="input" type="password" autocomplete="new-password" minlength="8" required bind:value={password} />
							</div>
							<div>
								<label class="label" for="s-pw2">Repeat password</label>
								<input id="s-pw2" class="input" type="password" autocomplete="new-password" minlength="8" required bind:value={repeat} />
							</div>
						</div>
					</div>
					{#if error}<p class="mt-3 text-xs text-danger">{error}</p>{/if}
					<button class="btn btn-primary mt-6 h-9 w-full" disabled={busy}>
						{#if busy}<LoaderCircle class="animate-spin" />{/if}Create account<ArrowRight />
					</button>
				</form>
			{:else if step === 2}
				<h2 class="flex items-center gap-2 text-[15px] font-semibold"><Radar class="size-4 text-primary" />Where do your databases live?</h2>
				<p class="mt-1 text-xs text-muted-foreground">All optional — you can change these any time under Integrations.</p>

				<div class="mt-5 space-y-3">
					<div class="rounded-xl border border-border p-4">
						<p class="flex items-center gap-2 text-[13px] font-medium"><Container class="size-4 text-primary" />Docker on this host</p>
						{#if env?.dockerHosts.length}
							<p class="mt-1.5 flex items-center gap-1.5 text-xs text-success"><CircleCheck class="size-3.5" />Found <code class="font-mono">{env.dockerHosts.join(', ')}</code></p>
						{:else}
							<p class="mt-1.5 text-xs text-muted-foreground">
								No Docker socket available{env?.inContainer ? ' inside this container' : ''}. Mount <code class="font-mono">/var/run/docker.sock</code> (ideally via a read-only proxy) to discover containers.
							</p>
						{/if}
					</div>

					<form class="rounded-xl border border-border p-4" onsubmit={connectArcane}>
						<p class="flex items-center gap-2 text-[13px] font-medium"><Boxes class="size-4 text-primary" />Arcane</p>
						{#if arcaneState === 'connected'}
							<p class="mt-1.5 flex items-center gap-1.5 text-xs text-success"><CircleCheck class="size-3.5" />Connected — {arcaneEnvs} environment{arcaneEnvs === 1 ? '' : 's'}.</p>
						{:else}
							<p class="mt-1 text-xs text-muted-foreground">
								Finds Postgres in every container and project across Arcane's hosts. Read-only key permissions:
								<code class="font-mono">environments:list</code>, <code class="font-mono">projects:list</code>, <code class="font-mono">projects:read</code>,
								<code class="font-mono">containers:list</code>, <code class="font-mono">containers:read</code>.
							</p>
							<div class="mt-3 grid grid-cols-[1fr_1fr_auto] gap-2">
								<input class="input h-8 font-mono text-xs" placeholder="http://arcane.lan:3552" aria-label="Arcane URL" bind:value={arcane.url} />
								<input class="input h-8 font-mono text-xs" type="password" placeholder="API key" aria-label="API key" autocomplete="off" bind:value={arcane.apiKey} />
								<button class="btn btn-secondary" disabled={!arcane.url || !arcane.apiKey || arcaneState === 'testing'}>
									{#if arcaneState === 'testing'}<LoaderCircle class="animate-spin" />{:else}<Zap />{/if}Connect
								</button>
							</div>
							{#if typeof arcaneState === 'object'}
								<p class="mt-2 flex items-center gap-1.5 text-xs text-danger"><CircleAlert class="size-3.5" />{arcaneState.error}</p>
							{/if}
						{/if}
					</form>

					<form class="rounded-xl border border-border p-4" onsubmit={addFolder}>
						<p class="flex items-center gap-2 text-[13px] font-medium"><FolderSearch class="size-4 text-primary" />Folders with .env / compose / Terraform files</p>
						<div class="mt-2 flex flex-wrap gap-1.5">
							{#each [...(env?.scanPaths ?? []), ...settings.scanPaths] as p (p)}
								<span class="badge h-6 font-mono">{p}</span>
							{/each}
						</div>
						<div class="mt-2 flex gap-2">
							<input class="input h-8 font-mono text-xs" placeholder="/opt/stacks" aria-label="Folder" bind:value={folder} />
							<button class="btn btn-secondary" disabled={!folder.trim()}><Plus />Add</button>
						</div>
					</form>
				</div>

				<div class="mt-6 flex justify-between">
					<button class="btn btn-ghost" onclick={() => (step = 3)}><X />Skip</button>
					<button class="btn btn-primary" onclick={() => (step = 3)}>Continue<ArrowRight /></button>
				</div>
			{:else}
				<div class="text-center">
					<div class="mx-auto grid size-12 place-items-center rounded-full bg-success/10 text-success"><Check class="size-6" /></div>
					<h2 class="mt-4 text-[15px] font-semibold">You're set up</h2>
					<p class="mt-1.5 text-xs text-muted-foreground">
						Next, pick the databases you want from Discover. Everything you import starts read-only.
					</p>
					<button class="btn btn-primary mt-6 h-9 w-full" onclick={finish}><Radar />Find my databases</button>
				</div>
			{/if}
		</div>
	</div>
</div>
