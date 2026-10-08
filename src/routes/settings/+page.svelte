<script lang="ts">
	import { onMount } from 'svelte';
	import { FolderSearch, KeyRound, Container, Plus, Save, ShieldCheck, X, LoaderCircle } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import type { Settings } from '#lib/types.ts';

	type Env = {
		scanPaths: string[];
		dockerHosts: string[];
		scanDepth: number;
		statementTimeoutMs: number;
		maxRows: number;
		dataDir: string;
		keySource: string;
		authDisabled: boolean;
		inContainer: boolean;
	};

	let settings = $state<Settings>({ scanPaths: [], dockerHosts: [] });
	let env = $state<Env | null>(null);
	let newPath = $state('');
	let newHost = $state('');
	let saving = $state(false);

	onMount(async () => {
		const res = await api.get<{ settings: Settings; env: Env }>('/api/settings');
		settings = res.settings;
		env = res.env;
	});

	async function save() {
		saving = true;
		try {
			settings = await api.put<Settings>('/api/settings', settings);
			toast('success', 'Settings saved');
		} catch (err) {
			toast('error', 'Could not save', errorMessage(err));
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head><title>Settings · pg·modern</title></svelte:head>

<div class="h-full overflow-y-auto">
	<PageHeader title="Settings" description="Discovery sources and how pg·modern protects your credentials.">
		{#snippet actions()}
			<button class="btn btn-primary" disabled={saving} onclick={save}>
				{#if saving}<LoaderCircle class="animate-spin" />{:else}<Save />{/if}Save
			</button>
		{/snippet}
	</PageHeader>

	<div class="grid max-w-5xl gap-5 px-8 pb-10 lg:grid-cols-2">
		<section class="card p-5">
			<h2 class="flex items-center gap-2 text-[14px] font-semibold"><FolderSearch class="size-4 text-primary" />Scan folders</h2>
			<p class="mt-1 text-xs text-muted-foreground">
				Searched for <code class="font-mono">.env*</code> and <code class="font-mono">compose.yaml</code> files up to {env?.scanDepth ?? 6} levels deep.
				<code class="font-mono">node_modules</code>, <code class="font-mono">.git</code> and <code class="font-mono">*.example</code> files are skipped.
			</p>
			<div class="mt-4 space-y-1.5">
				{#each env?.scanPaths ?? [] as p (p)}
					<div class="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 font-mono text-xs">
						<span class="flex-1 truncate">{p}</span><span class="badge">PGM_SCAN_PATHS</span>
					</div>
				{/each}
				{#each settings.scanPaths as p, i (p)}
					<div class="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 font-mono text-xs">
						<span class="flex-1 truncate">{p}</span>
						<button class="btn btn-ghost btn-icon btn-sm -mr-1.5" aria-label="Remove" onclick={() => settings.scanPaths.splice(i, 1)}><X /></button>
					</div>
				{/each}
			</div>
			<form class="mt-3 flex gap-2" onsubmit={(e) => (e.preventDefault(), newPath.trim() && (settings.scanPaths.push(newPath.trim()), (newPath = '')))}>
				<input class="input h-8 font-mono text-xs" placeholder="/opt/stacks" bind:value={newPath} />
				<button class="btn btn-secondary" disabled={!newPath.trim()}><Plus />Add</button>
			</form>
		</section>

		<section class="card p-5">
			<h2 class="flex items-center gap-2 text-[14px] font-semibold"><Container class="size-4 text-primary" />Docker endpoints</h2>
			<p class="mt-1 text-xs text-muted-foreground">
				Unix sockets or remote Docker APIs (<code class="font-mono">tcp://host:2375</code>, ideally behind a read-only socket proxy).
			</p>
			<div class="mt-4 space-y-1.5">
				{#each env?.dockerHosts ?? [] as h (h)}
					<div class="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 font-mono text-xs">
						<span class="flex-1 truncate">{h}</span><span class="badge">auto / env</span>
					</div>
				{/each}
				{#each settings.dockerHosts as h, i (h)}
					<div class="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 font-mono text-xs">
						<span class="flex-1 truncate">{h}</span>
						<button class="btn btn-ghost btn-icon btn-sm -mr-1.5" aria-label="Remove" onclick={() => settings.dockerHosts.splice(i, 1)}><X /></button>
					</div>
				{/each}
			</div>
			<form class="mt-3 flex gap-2" onsubmit={(e) => (e.preventDefault(), newHost.trim() && (settings.dockerHosts.push(newHost.trim()), (newHost = '')))}>
				<input class="input h-8 font-mono text-xs" placeholder="tcp://10.0.0.5:2375" bind:value={newHost} />
				<button class="btn btn-secondary" disabled={!newHost.trim()}><Plus />Add</button>
			</form>
		</section>

		<section class="card p-5 lg:col-span-2">
			<h2 class="flex items-center gap-2 text-[14px] font-semibold"><ShieldCheck class="size-4 text-primary" />Security</h2>
			{#if env}
				<div class="mt-4 grid gap-x-8 gap-y-3 text-[13px] md:grid-cols-2">
					<div class="flex items-center justify-between gap-4"><span class="text-muted-foreground">Credential encryption</span><span class="font-mono text-xs">AES-256-GCM</span></div>
					<div class="flex items-center justify-between gap-4"><span class="flex items-center gap-1.5 text-muted-foreground"><KeyRound class="size-3.5" />Master key</span><span class="font-mono text-xs">{env.keySource}</span></div>
					<div class="flex items-center justify-between gap-4"><span class="text-muted-foreground">Data directory</span><span class="truncate font-mono text-xs">{env.dataDir}</span></div>
					<div class="flex items-center justify-between gap-4"><span class="text-muted-foreground">Login</span>{#if env.authDisabled}<span class="badge badge-warning">disabled (PGM_AUTH)</span>{:else}<span class="badge badge-success">required</span>{/if}</div>
					<div class="flex items-center justify-between gap-4"><span class="text-muted-foreground">Statement timeout</span><span class="font-mono text-xs">{env.statementTimeoutMs / 1000}s</span></div>
					<div class="flex items-center justify-between gap-4"><span class="text-muted-foreground">Max rows per result</span><span class="font-mono text-xs">{env.maxRows.toLocaleString()}</span></div>
				</div>
				<div class="mt-5 space-y-2 rounded-xl bg-surface p-4 text-xs text-muted-foreground">
					<p><b class="font-medium text-foreground">Read-only by default.</b> New and imported connections run every statement inside <code class="font-mono">BEGIN READ ONLY … ROLLBACK</code>, with <code class="font-mono">default_transaction_read_only</code> set on the session and transaction-control statements blocked.</p>
					<p><b class="font-medium text-foreground">Secrets stay server-side.</b> Discovered passwords are never sent to the browser; imports reference them by fingerprint and they go straight into the encrypted store.</p>
					{#if env.keySource === 'key file'}
						<p><b class="font-medium text-foreground">Back up your key.</b> Credentials are sealed with <code class="font-mono">{env.dataDir}/secret.key</code>. Set <code class="font-mono">PGM_SECRET_KEY</code> to manage it yourself.</p>
					{/if}
				</div>
			{/if}
		</section>
	</div>
</div>
