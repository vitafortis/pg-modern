<script lang="ts">
	import { onMount } from 'svelte';
	import { FolderSearch, KeyRound, Container, Plus, Save, ShieldCheck, X, LoaderCircle, Copy, LogIn, Boxes, Zap, Trash2, CircleCheck, CircleAlert } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import type { Manager, Settings } from '#lib/types.ts';

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
		localLoginDisabled: boolean;
		oidc: {
			issuer: string;
			name: string;
			clientId: string;
			scopes: string;
			redirectUri: string;
			autoCreate: string[];
			adminEmails: string[];
			defaultRole: string;
		} | null;
	};

	let settings = $state<Settings>({ scanPaths: [], dockerHosts: [] });
	let env = $state<Env | null>(null);
	let newPath = $state('');
	let newHost = $state('');
	let saving = $state(false);

	let managers = $state<Manager[]>([]);
	let mForm = $state({ name: 'Arcane', url: '', apiKey: '' });
	let mTest = $state<{ ok: true; environments: number } | { ok: false; error: string } | null>(null);
	let mBusy = $state(false);

	async function loadManagers() {
		managers = await api.get<Manager[]>('/api/managers');
	}

	async function testManager(m?: Manager) {
		mBusy = true;
		mTest = null;
		try {
			mTest = await api.post('/api/managers/test', m ? { url: m.url, id: m.id } : { url: mForm.url, apiKey: mForm.apiKey });
			if (m) toast(mTest!.ok ? 'success' : 'error', mTest!.ok ? `${m.name}: ${(mTest as { environments: number }).environments} environment(s)` : `${m.name} failed`, mTest!.ok ? undefined : (mTest as { error: string }).error);
		} finally {
			mBusy = false;
		}
	}

	async function addManager(e: SubmitEvent) {
		e.preventDefault();
		mBusy = true;
		try {
			await api.post('/api/managers', mForm);
			toast('success', `${mForm.name} connected`, 'Its projects now show up under Discover → Arcane.');
			mForm = { name: 'Arcane', url: '', apiKey: '' };
			mTest = null;
			await loadManagers();
		} catch (err) {
			toast('error', 'Could not add', errorMessage(err));
		} finally {
			mBusy = false;
		}
	}

	async function removeManager(m: Manager) {
		await api.del(`/api/managers/${m.id}`);
		await loadManagers();
	}

	onMount(async () => {
		loadManagers();
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

		<section id="managers" class="card scroll-mt-6 p-5 lg:col-span-2">
			<h2 class="flex items-center gap-2 text-[14px] font-semibold"><Boxes class="size-4 text-primary" />Docker managers</h2>
			<p class="mt-1 text-xs text-muted-foreground">
				Read stacks through Arcane's API instead of mounting folders: every project's compose file and .env, across all of its
				environments. Create a key in Arcane under <b class="font-medium text-foreground">Settings → API Keys</b> with only
				<code class="font-mono">environments:list</code>, <code class="font-mono">projects:list</code> and <code class="font-mono">projects:read</code>.
			</p>
			{#if managers.length}
				<div class="mt-4 space-y-1.5">
					{#each managers as m (m.id)}
						<div class="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-xs">
							<Boxes class="size-3.5 text-primary" />
							<span class="font-medium">{m.name}</span>
							<span class="min-w-0 flex-1 truncate font-mono text-muted-foreground">{m.url}</span>
							{#if m.fromEnv}<span class="badge">PGM_ARCANE_URL</span>{/if}
							{#if !m.hasKey}<span class="badge badge-warning">no API key</span>{/if}
							<button class="btn btn-ghost btn-sm" disabled={mBusy} onclick={() => testManager(m)}><Zap />Test</button>
							{#if !m.fromEnv}
								<button class="btn btn-ghost btn-icon btn-sm hover:text-danger" title="Remove" onclick={() => removeManager(m)}><Trash2 /></button>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
			<form class="mt-4 grid gap-2 md:grid-cols-[10rem_1fr_1fr_auto_auto]" onsubmit={addManager}>
				<input class="input h-8 text-xs" placeholder="Name" bind:value={mForm.name} />
				<input class="input h-8 font-mono text-xs" placeholder="https://arcane.home.arpa" required bind:value={mForm.url} />
				<input class="input h-8 font-mono text-xs" type="password" placeholder="API key" autocomplete="off" required bind:value={mForm.apiKey} />
				<button type="button" class="btn btn-secondary" disabled={mBusy || !mForm.url || !mForm.apiKey} onclick={() => testManager()}>
					{#if mBusy}<LoaderCircle class="animate-spin" />{:else}<Zap />{/if}Test
				</button>
				<button class="btn btn-primary" disabled={mBusy}><Plus />Connect</button>
			</form>
			{#if mTest}
				<p class="mt-2 flex items-center gap-1.5 text-xs {mTest.ok ? 'text-success' : 'text-danger'}">
					{#if mTest.ok}<CircleCheck class="size-3.5" />Connected — {mTest.environments} environment{mTest.environments === 1 ? '' : 's'} visible.{:else}<CircleAlert class="size-3.5" />{mTest.error}{/if}
				</p>
			{/if}
		</section>

		<section class="card p-5 lg:col-span-2">
			<h2 class="flex items-center gap-2 text-[14px] font-semibold"><LogIn class="size-4 text-primary" />Single sign-on (OIDC)</h2>
			{#if env?.oidc}
				{@const o = env.oidc}
				<div class="mt-4 grid gap-x-8 gap-y-3 text-[13px] md:grid-cols-2">
					<div class="flex items-center justify-between gap-4"><span class="text-muted-foreground">Provider</span><span class="truncate font-mono text-xs">{o.issuer}</span></div>
					<div class="flex items-center justify-between gap-4"><span class="text-muted-foreground">Client ID</span><span class="truncate font-mono text-xs">{o.clientId}</span></div>
					<div class="flex items-center justify-between gap-4 md:col-span-2">
						<span class="shrink-0 text-muted-foreground">Redirect URI <span class="text-[11px]">(register this with your provider)</span></span>
						<span class="flex min-w-0 items-center gap-1">
							<code class="truncate font-mono text-xs">{o.redirectUri}</code>
							<button class="btn btn-ghost btn-icon btn-sm" title="Copy" onclick={() => (navigator.clipboard.writeText(o.redirectUri), toast('success', 'Copied'))}><Copy /></button>
						</span>
					</div>
					<div class="flex items-center justify-between gap-4"><span class="text-muted-foreground">Auto-create accounts for</span><span class="truncate font-mono text-xs">{o.autoCreate.join(', ') || 'nobody (invite only)'}</span></div>
					<div class="flex items-center justify-between gap-4"><span class="text-muted-foreground">Auto-created role</span><span class="font-mono text-xs">{o.defaultRole}{#if o.adminEmails.length} · admin for {o.adminEmails.join(', ')}{/if}</span></div>
					<div class="flex items-center justify-between gap-4"><span class="text-muted-foreground">Password sign-in</span>{#if env.localLoginDisabled}<span class="badge">disabled</span>{:else}<span class="badge badge-success">enabled</span>{/if}</div>
				</div>
			{:else if env}
				<p class="mt-1 text-xs text-muted-foreground">Sign in through Authentik, Authelia, Keycloak, Pocket ID, Google and other OIDC providers. Set these variables and restart:</p>
				<pre class="mt-3 overflow-x-auto rounded-lg border border-border bg-surface p-3 font-mono text-[11px] leading-relaxed">PGM_OIDC_ISSUER=https://auth.example.com/application/o/pg-modern/
PGM_OIDC_CLIENT_ID=pg-modern
PGM_OIDC_CLIENT_SECRET=…
PGM_OIDC_NAME=Authentik                # login button label
PGM_OIDC_AUTO_CREATE=*@example.com     # optional: who gets an account on first login
PGM_OIDC_ADMIN_EMAILS=you@example.com  # optional: who is created as admin</pre>
				<p class="mt-2 text-[11px] text-muted-foreground">Redirect URI to register: <code class="font-mono">{location.origin}/auth/oidc/callback</code></p>
			{/if}
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
