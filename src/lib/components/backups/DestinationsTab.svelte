<script lang="ts">
	import { CircleAlert, CircleCheck, Cloud, FlaskConical, FolderOpen, KeyRound, LoaderCircle, Pencil, Plus, Server, Trash2 } from '@lucide/svelte';
	import Dialog from '#lib/components/Dialog.svelte';
	import Switch from '#lib/components/Switch.svelte';
	import type { BackupsData } from './types.ts';
	import type { BackupDestination, DestinationKind } from '#lib/backups.ts';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';

	let { data, reload }: { data: BackupsData; reload: () => Promise<void> } = $props();

	const KINDS: { key: DestinationKind; label: string; icon: typeof Server; hint: string }[] = [
		{ key: 'local', label: 'Folder', icon: FolderOpen, hint: 'A path inside the container — mount an NFS or CIFS share there' },
		{ key: 'sftp', label: 'SFTP', icon: Server, hint: 'Synology, TrueNAS, Unraid or any SSH server' },
		{ key: 's3', label: 'S3', icon: Cloud, hint: 'MinIO, Garage, TrueNAS, Synology C2, Backblaze B2, AWS' }
	];
	const kindOf = (k: DestinationKind) => KINDS.find((x) => x.key === k)!;

	type Form = {
		id: string | null;
		name: string;
		kind: DestinationKind;
		path: string;
		host: string;
		port: number;
		user: string;
		remotePath: string;
		hostKey: string;
		auth: 'password' | 'key';
		password: string;
		privateKey: string;
		passphrase: string;
		endpoint: string;
		region: string;
		bucket: string;
		prefix: string;
		accessKeyId: string;
		secretAccessKey: string;
		pathStyle: boolean;
		has: { password: boolean; privateKey: boolean; passphrase: boolean; secretKey: boolean };
	};

	function blank(): Form {
		return {
			id: null,
			name: '',
			kind: 'local',
			path: '/backups',
			host: '',
			port: 22,
			user: '',
			remotePath: 'pg-modern',
			hostKey: '',
			auth: 'password',
			password: '',
			privateKey: '',
			passphrase: '',
			endpoint: '',
			region: 'us-east-1',
			bucket: '',
			prefix: 'pg-modern/',
			accessKeyId: '',
			secretAccessKey: '',
			pathStyle: true,
			has: { password: false, privateKey: false, passphrase: false, secretKey: false }
		};
	}

	let open = $state(false);
	let saving = $state(false);
	let testing = $state<string | null>(null);
	let result = $state<{ ok: boolean; error?: string; hostKey?: string; latencyMs?: number } | null>(null);
	let form = $state<Form>(blank());

	function edit(d: BackupDestination | null) {
		result = null;
		const f = blank();
		if (d) {
			f.id = d.id;
			f.name = d.name;
			f.kind = d.kind;
			f.has = { password: d.hasPassword, privateKey: d.hasPrivateKey, passphrase: d.hasPassphrase, secretKey: d.hasSecretKey };
			if (d.kind === 'local') f.path = d.config.path;
			if (d.kind === 'sftp') {
				Object.assign(f, { host: d.config.host, port: d.config.port, user: d.config.user, remotePath: d.config.path, hostKey: d.config.hostKey });
				f.auth = d.hasPrivateKey ? 'key' : 'password';
			}
			if (d.kind === 's3') Object.assign(f, d.config);
		}
		form = f;
		open = true;
	}

	/** Blank secret fields keep the stored value; switching SFTP auth clears the other method. */
	function payload(f: Form) {
		const config =
			f.kind === 'local'
				? { path: f.path }
				: f.kind === 'sftp'
					? { host: f.host, port: Number(f.port) || 22, user: f.user, path: f.remotePath, hostKey: f.hostKey }
					: { endpoint: f.endpoint, region: f.region, bucket: f.bucket, prefix: f.prefix, accessKeyId: f.accessKeyId, pathStyle: f.pathStyle };
		const secrets: Record<string, string> = {};
		if (f.kind === 'sftp') {
			if (f.auth === 'password') {
				if (f.password) secrets.password = f.password;
				if (f.has.privateKey) Object.assign(secrets, { privateKey: '', passphrase: '' });
			} else {
				if (f.privateKey) secrets.privateKey = f.privateKey;
				if (f.passphrase) secrets.passphrase = f.passphrase;
				if (f.has.password) secrets.password = '';
			}
		}
		if (f.kind === 's3' && f.secretAccessKey) secrets.secretAccessKey = f.secretAccessKey;
		return { id: f.id ?? undefined, name: f.name, kind: f.kind, config, secrets };
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		saving = true;
		try {
			if (form.id) await api.put(`/api/backups/destinations/${form.id}`, payload(form));
			else await api.post('/api/backups/destinations', payload(form));
			open = false;
			await reload();
		} catch (err) {
			toast('error', 'Could not save the destination', errorMessage(err));
		} finally {
			saving = false;
		}
	}

	async function testForm() {
		testing = 'form';
		result = null;
		try {
			result = await api.post('/api/backups/destinations/test', { ...payload(form), name: form.name || 'unsaved' });
		} catch (err) {
			result = { ok: false, error: errorMessage(err) };
		} finally {
			testing = null;
		}
	}

	async function testSaved(d: BackupsData['destinations'][number]) {
		testing = d.id;
		try {
			const r = await api.post<{ ok: boolean; error?: string; latencyMs?: number }>('/api/backups/destinations/test', {
				id: d.id,
				name: d.name,
				kind: d.kind,
				config: d.config
			});
			if (r.ok) toast('success', `${d.name} works`, `Wrote, read back and deleted a test file in ${r.latencyMs} ms.`);
			else toast('error', `${d.name} failed`, r.error);
		} catch (err) {
			toast('error', `${d.name} failed`, errorMessage(err));
		} finally {
			testing = null;
		}
	}

	async function remove(d: BackupDestination) {
		const ok = await confirmAction({
			title: `Remove “${d.name}”?`,
			body: 'Backup files already stored there are left in place, but pg·modern can no longer download or restore them.',
			confirmLabel: 'Remove',
			danger: true
		});
		if (!ok) return;
		try {
			await api.del(`/api/backups/destinations/${d.id}`);
			await reload();
		} catch (err) {
			toast('error', 'Could not remove the destination', errorMessage(err));
		}
	}

	const keep = (has: boolean) => (has && form.id ? 'Leave blank to keep the saved one' : '');
</script>

<div class="flex items-center justify-end">
	<button class="btn btn-primary" onclick={() => edit(null)}><Plus />New destination</button>
</div>

{#if !data.destinations.length}
	<div class="card px-6 py-12 text-center">
		<p class="text-sm font-medium">No destinations yet</p>
		<p class="mx-auto mt-1 max-w-lg text-[13px] text-muted-foreground">
			For a NAS, the simplest route is mounting an NFS or CIFS/SMB share as a Docker volume (see the README) and using it as a folder.
			SFTP and S3-compatible storage need no mount at all.
		</p>
	</div>
{:else}
	<div class="card divide-y divide-border">
		{#each data.destinations as d (d.id)}
			{@const k = kindOf(d.kind)}
			<div class="flex flex-wrap items-center gap-4 px-4 py-3">
				<div class="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-surface text-primary"><k.icon class="size-4" /></div>
				<div class="min-w-0 flex-1">
					<p class="truncate text-[13px] font-medium">{d.name} <span class="ml-1 badge">{k.label}</span></p>
					<p class="mt-0.5 truncate font-mono text-xs text-muted-foreground">{d.where}</p>
				</div>
				<div class="flex flex-wrap gap-1.5">
					{#if d.kind === 'sftp'}
						{#if d.hasPrivateKey}<span class="badge"><KeyRound />key</span>{:else if d.hasPassword}<span class="badge"><KeyRound />password</span>{:else}<span class="badge badge-warning">no credentials</span>{/if}
						{#if d.config.hostKey}<span class="badge badge-success">host key pinned</span>{/if}
					{/if}
					{#if d.kind === 's3' && !d.hasSecretKey}<span class="badge badge-warning">no secret key</span>{/if}
				</div>
				<div class="flex items-center">
					<button class="btn btn-secondary btn-sm" onclick={() => testSaved(d)} disabled={testing === d.id}>
						{#if testing === d.id}<LoaderCircle class="animate-spin" />{:else}<FlaskConical />{/if}Test
					</button>
					<button class="btn btn-ghost btn-icon btn-sm" title="Edit" onclick={() => edit(d)}><Pencil /></button>
					<button class="btn btn-ghost btn-icon btn-sm hover:text-danger" title="Remove" onclick={() => remove(d)}><Trash2 /></button>
				</div>
			</div>
		{/each}
	</div>
{/if}

<Dialog bind:open title={form.id ? 'Edit destination' : 'New destination'} width="max-w-xl">
	<form id="destination" class="space-y-3" onsubmit={save}>
		<div class="grid grid-cols-3 gap-2">
			{#each KINDS as k (k.key)}
				<button
					type="button"
					class="rounded-xl border p-3 text-left transition-colors {form.kind === k.key ? 'border-primary bg-primary-soft' : 'border-border hover:border-primary/40'}"
					onclick={() => ((form.kind = k.key), (result = null))}
				>
					<k.icon class="size-4 {form.kind === k.key ? 'text-primary' : 'text-muted-foreground'}" />
					<p class="mt-1.5 text-[13px] font-medium">{k.label}</p>
					<p class="mt-0.5 text-[11px] leading-snug text-muted-foreground">{k.hint}</p>
				</button>
			{/each}
		</div>
		<div>
			<label class="label" for="d-name">Name</label>
			<input id="d-name" class="input" required placeholder={form.kind === 'local' ? 'NAS (NFS)' : form.kind === 'sftp' ? 'Synology' : 'MinIO'} bind:value={form.name} />
		</div>

		{#if form.kind === 'local'}
			<div>
				<label class="label" for="d-path">Folder in the container</label>
				<input id="d-path" class="input font-mono" required bind:value={form.path} />
				<p class="mt-1.5 text-xs text-muted-foreground">
					Must be writable by the container's user (uid 1000). To use a NAS, declare an NFS or CIFS volume in compose with
					<code>driver_opts</code> and mount it here — no mount on the host needed.
				</p>
			</div>
		{:else if form.kind === 'sftp'}
			<div class="grid grid-cols-[1fr_6rem] gap-3">
				<div>
					<label class="label" for="d-host">Host</label>
					<input id="d-host" class="input" required placeholder="nas.lan" bind:value={form.host} />
				</div>
				<div>
					<label class="label" for="d-port">Port</label>
					<input id="d-port" class="input" type="number" min="1" max="65535" bind:value={form.port} />
				</div>
			</div>
			<div class="grid grid-cols-2 gap-3">
				<div>
					<label class="label" for="d-user">User</label>
					<input id="d-user" class="input" required autocomplete="off" bind:value={form.user} />
				</div>
				<div>
					<label class="label" for="d-rpath">Folder</label>
					<input id="d-rpath" class="input font-mono" placeholder="relative to the login's home" bind:value={form.remotePath} />
				</div>
			</div>
			<div>
				<span class="label">Sign in with</span>
				<div class="inline-flex rounded-lg border border-border bg-surface p-0.5 text-xs">
					<button type="button" class="rounded-md px-3 py-1 {form.auth === 'password' ? 'bg-card shadow-surface' : 'text-muted-foreground'}" onclick={() => (form.auth = 'password')}>Password</button>
					<button type="button" class="rounded-md px-3 py-1 {form.auth === 'key' ? 'bg-card shadow-surface' : 'text-muted-foreground'}" onclick={() => (form.auth = 'key')}>Private key</button>
				</div>
			</div>
			{#if form.auth === 'password'}
				<div>
					<label class="label" for="d-pass">Password</label>
					<input id="d-pass" class="input" type="password" autocomplete="new-password" placeholder={keep(form.has.password)} bind:value={form.password} />
				</div>
			{:else}
				<div>
					<label class="label" for="d-key">Private key (OpenSSH or PEM)</label>
					<textarea id="d-key" class="input h-24 py-2 font-mono text-[11px]" spellcheck="false" placeholder={keep(form.has.privateKey) || '-----BEGIN OPENSSH PRIVATE KEY-----'} bind:value={form.privateKey}></textarea>
				</div>
				<div>
					<label class="label" for="d-phrase">Key passphrase <span class="opacity-60">(optional)</span></label>
					<input id="d-phrase" class="input" type="password" autocomplete="new-password" placeholder={keep(form.has.passphrase)} bind:value={form.passphrase} />
				</div>
			{/if}
			<div>
				<label class="label" for="d-hostkey">Host key fingerprint <span class="opacity-60">(optional, recommended)</span></label>
				<input id="d-hostkey" class="input font-mono text-xs" placeholder="SHA256:… — Test shows the server's" bind:value={form.hostKey} />
			</div>
		{:else}
			<div class="grid grid-cols-[1fr_9rem] gap-3">
				<div>
					<label class="label" for="d-endpoint">Endpoint</label>
					<input id="d-endpoint" class="input" required placeholder="https://minio.lan:9000" bind:value={form.endpoint} />
				</div>
				<div>
					<label class="label" for="d-region">Region</label>
					<input id="d-region" class="input" bind:value={form.region} />
				</div>
			</div>
			<div class="grid grid-cols-2 gap-3">
				<div>
					<label class="label" for="d-bucket">Bucket</label>
					<input id="d-bucket" class="input" required bind:value={form.bucket} />
				</div>
				<div>
					<label class="label" for="d-prefix">Prefix</label>
					<input id="d-prefix" class="input font-mono" bind:value={form.prefix} />
				</div>
			</div>
			<div class="grid grid-cols-2 gap-3">
				<div>
					<label class="label" for="d-ak">Access key</label>
					<input id="d-ak" class="input" required autocomplete="off" bind:value={form.accessKeyId} />
				</div>
				<div>
					<label class="label" for="d-sk">Secret key</label>
					<input id="d-sk" class="input" type="password" autocomplete="new-password" required={!form.has.secretKey} placeholder={keep(form.has.secretKey)} bind:value={form.secretAccessKey} />
				</div>
			</div>
			<div class="flex items-center justify-between gap-3">
				<div>
					<p class="text-[13px]">Path-style URLs</p>
					<p class="text-xs text-muted-foreground">endpoint/bucket/key — MinIO, Garage and most NAS servers need this.</p>
				</div>
				<Switch bind:checked={form.pathStyle} label="Path-style URLs" />
			</div>
			<p class="text-xs text-muted-foreground">Dumps upload in 16 MiB parts (multipart), up to about 156 GiB each.</p>
		{/if}

		{#if result}
			<div class="rounded-lg border p-3 text-xs {result.ok ? 'border-success/30 bg-success/5' : 'border-danger/30 bg-danger/5 text-danger'}">
				<p class="flex items-center gap-1.5 font-medium">
					{#if result.ok}<CircleCheck class="size-3.5 text-success" />Wrote, read back and deleted a test file in {result.latencyMs} ms{:else}<CircleAlert class="size-3.5" />{result.error}{/if}
				</p>
				{#if result.hostKey && form.kind === 'sftp'}
					<div class="mt-2 flex items-center gap-2 text-foreground">
						<code class="min-w-0 flex-1 truncate">{result.hostKey}</code>
						{#if form.hostKey !== result.hostKey}
							<button type="button" class="btn btn-secondary btn-sm" onclick={() => (form.hostKey = result!.hostKey!)}>Pin this key</button>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
	</form>
	{#snippet footer()}
		<button class="btn btn-ghost mr-auto" onclick={testForm} disabled={testing === 'form'}>
			{#if testing === 'form'}<LoaderCircle class="animate-spin" />{:else}<FlaskConical />{/if}Test
		</button>
		<button class="btn btn-secondary" onclick={() => (open = false)}>Cancel</button>
		<button class="btn btn-primary" form="destination" disabled={saving}>{#if saving}<LoaderCircle class="animate-spin" />{/if}{form.id ? 'Save' : 'Add destination'}</button>
	{/snippet}
</Dialog>
