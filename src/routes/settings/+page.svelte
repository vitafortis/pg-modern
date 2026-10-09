<script lang="ts">
	import { onMount } from 'svelte';
	import { KeyRound, ShieldCheck, Plug, ArrowRight, Archive, Download, Upload, TriangleAlert, Eye, RotateCcw } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';

	type Env = {
		scanDepth: number;
		statementTimeoutMs: number;
		maxRows: number;
		dataDir: string;
		keySource: string;
		authDisabled: boolean;
		inContainer: boolean;
	};

	let env = $state<Env | null>(null);

	onMount(async () => {
		env = (await api.get<{ env: Env }>('/api/settings')).env;
	});

	// --- backup & restore ------------------------------------------------------

	const MIN_PASSPHRASE = 12;
	type Category = 'connections' | 'users' | 'settings';
	const CATEGORIES: { key: Category; label: string; hint: string }[] = [
		{ key: 'connections', label: 'Connections', hint: 'with their passwords, and saved queries' },
		{ key: 'users', label: 'Users', hint: 'password hashes, SSO links, connection access' },
		{ key: 'settings', label: 'Settings', hint: 'discovery, Arcane keys, single sign-on' }
	];

	let exp = $state({ passphrase: '', confirm: '', include: { connections: true, users: true, settings: true } as Record<Category, boolean> });
	let exporting = $state(false);
	const exportProblem = $derived(
		exp.passphrase.length < MIN_PASSPHRASE
			? `At least ${MIN_PASSPHRASE} characters`
			: exp.confirm !== exp.passphrase
				? 'Passphrases don’t match'
				: !Object.values(exp.include).some(Boolean)
					? 'Choose something to include'
					: null
	);

	async function exportBackup(e: SubmitEvent) {
		e.preventDefault();
		if (exportProblem) return;
		exporting = true;
		try {
			const res = await fetch('/api/backup', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ passphrase: exp.passphrase, include: exp.include })
			});
			if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? res.statusText);
			const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'pg-modern-backup.pgmbackup';
			const url = URL.createObjectURL(await res.blob());
			const a = Object.assign(document.createElement('a'), { href: url, download: name });
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
			exp.passphrase = exp.confirm = '';
			toast('success', 'Backup downloaded', `Keep ${name} and its passphrase somewhere safe.`);
		} catch (err) {
			toast('error', 'Backup failed', errorMessage(err));
		} finally {
			exporting = false;
		}
	}

	type Status = 'new' | 'update' | 'self' | 'same' | 'remove';
	type Preview = {
		createdAt: string;
		appVersion: string;
		contains: Record<Category, boolean>;
		connections: { id: string; name: string; target: string; hasPassword: boolean; status: 'new' | 'update' }[];
		users: { email: string; name: string | null; role: string; status: 'new' | 'update' | 'self' }[];
		grants: number;
		savedQueries: { total: number; new: number; update: number; supported: boolean } | null;
		settings: { label: string; detail: string; status: Status }[];
	};
	type Result = {
		connections: { added: number; updated: number };
		users: { added: number; updated: number; skipped: number };
		grants: number;
		savedQueries: { restored: number; skipped: number };
		settings: boolean;
	};

	let restoreFile = $state<File | null>(null);
	let restorePass = $state('');
	let preview = $state<Preview | null>(null);
	let choose = $state<Record<Category, boolean>>({ connections: true, users: true, settings: true });
	let restoring = $state(false);
	let fileInput = $state<HTMLInputElement>();

	const STATUS_LABEL: Record<Status, string> = { new: 'add', update: 'update', self: 'keep (you)', same: 'unchanged', remove: 'remove' };
	const STATUS_CLASS: Record<Status, string> = { new: 'badge-success', update: 'badge-warning', self: '', same: '', remove: 'badge-danger' };

	function count(items: { status: string }[], status: string) {
		return items.filter((i) => i.status === status).length;
	}

	async function sendRestore(mode: 'preview' | 'apply') {
		const form = new FormData();
		form.set('file', restoreFile!);
		form.set('passphrase', restorePass);
		form.set('mode', mode);
		for (const c of CATEGORIES) form.set(c.key, String(choose[c.key]));
		const res = await fetch('/api/backup/restore', { method: 'POST', body: form });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.message ?? res.statusText);
		return data;
	}

	async function previewRestore(e: SubmitEvent) {
		e.preventDefault();
		if (!restoreFile || !restorePass) return;
		restoring = true;
		try {
			preview = (await sendRestore('preview')) as Preview;
			choose = { ...preview.contains };
		} catch (err) {
			preview = null;
			toast('error', 'Can’t read that backup', errorMessage(err));
		} finally {
			restoring = false;
		}
	}

	async function applyRestore() {
		restoring = true;
		try {
			const r = (await sendRestore('apply')) as Result;
			const parts = [
				choose.connections && `${r.connections.added} connections added, ${r.connections.updated} updated`,
				choose.users && `${r.users.added} users added, ${r.users.updated} updated`,
				choose.settings && 'settings replaced'
			].filter(Boolean);
			toast('success', 'Backup restored', parts.join(' · '));
			preview = null;
			restoreFile = null;
			restorePass = '';
			if (fileInput) fileInput.value = '';
		} catch (err) {
			toast('error', 'Restore failed', errorMessage(err));
		} finally {
			restoring = false;
		}
	}
</script>

<svelte:head><title>Settings · pg·modern</title></svelte:head>

<div class="h-full overflow-y-auto">
	<PageHeader title="Settings" description="How pg·modern protects your credentials and runs queries." />

	<div class="max-w-5xl space-y-5 px-8 pb-10">
		<a href="/integrations" class="card flex items-center gap-3 p-4 transition-colors hover:bg-accent/40">
			<span class="grid size-9 place-items-center rounded-lg bg-primary-soft text-primary"><Plug class="size-4" /></span>
			<div class="flex-1">
				<p class="text-[13px] font-medium">Integrations</p>
				<p class="text-xs text-muted-foreground">Single sign-on, Arcane, Docker endpoints and scan folders.</p>
			</div>
			<ArrowRight class="size-4 text-muted-foreground" />
		</a>

		<section class="card p-5">
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
						<p><b class="font-medium text-foreground">Back up your key.</b> Credentials are sealed with <code class="font-mono">{env.dataDir}/secret.key</code>. Set <code class="font-mono">PGM_SECRET_KEY</code> to manage it yourself. A backup file (below) is the portable alternative: it carries your configuration under its own passphrase and restores on any install.</p>
					{:else}
						<p><b class="font-medium text-foreground">Keep <code class="font-mono">PGM_SECRET_KEY</code> safe.</b> Stored credentials can't be read without it. A backup file (below) is the portable alternative: it restores on any install under its own passphrase.</p>
					{/if}
				</div>
			{/if}
		</section>

		<section class="card p-5">
			<h2 class="flex items-center gap-2 text-[14px] font-semibold"><Archive class="size-4 text-primary" />Backup &amp; restore</h2>
			<p class="mt-1 text-xs text-muted-foreground">
				An encrypted file with pg·modern's own configuration, sealed with a passphrase you choose instead of the master key, so it also restores on a new install. Query history and the audit log aren't included.
			</p>

			<div class="mt-4 grid gap-5 lg:grid-cols-2">
				<form class="flex flex-col gap-3 rounded-xl border border-border p-4" onsubmit={exportBackup}>
					<h3 class="flex items-center gap-2 text-[13px] font-medium"><Download class="size-3.5 text-muted-foreground" />Export</h3>
					<fieldset class="space-y-1.5">
						<legend class="label">Include</legend>
						{#each CATEGORIES as c (c.key)}
							<label class="flex items-start gap-2.5 text-[13px]">
								<input type="checkbox" class="mt-0.5 size-4 accent-[var(--primary)]" bind:checked={exp.include[c.key]} />
								<span>{c.label} <span class="text-xs text-muted-foreground">· {c.hint}</span></span>
							</label>
						{/each}
					</fieldset>
					<div class="grid gap-3 sm:grid-cols-2">
						<div>
							<label class="label" for="bk-pass">Passphrase</label>
							<input id="bk-pass" class="input" type="password" autocomplete="new-password" placeholder="{MIN_PASSPHRASE}+ characters" bind:value={exp.passphrase} />
						</div>
						<div>
							<label class="label" for="bk-confirm">Confirm passphrase</label>
							<input id="bk-confirm" class="input" type="password" autocomplete="new-password" bind:value={exp.confirm} />
						</div>
					</div>
					<div class="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs">
						<TriangleAlert class="size-4 shrink-0 text-warning" />
						<p class="text-muted-foreground">
							<b class="font-medium text-foreground">The file contains your database passwords</b> and API keys, protected only by this passphrase. Store it as carefully as a password manager export, and keep the passphrase somewhere else: it can't be recovered.
						</p>
					</div>
					<div class="mt-auto flex items-center gap-3">
						<span class="mr-auto text-xs text-muted-foreground">{exp.passphrase || exp.confirm ? (exportProblem ?? '') : ''}</span>
						<button class="btn btn-primary" disabled={exporting || !!exportProblem}><Download />{exporting ? 'Encrypting…' : 'Download backup'}</button>
					</div>
				</form>

				<form class="flex flex-col gap-3 rounded-xl border border-border p-4" onsubmit={previewRestore}>
					<h3 class="flex items-center gap-2 text-[13px] font-medium"><Upload class="size-3.5 text-muted-foreground" />Restore</h3>
					<div>
						<label class="label" for="bk-file">Backup file</label>
						<input
							id="bk-file"
							bind:this={fileInput}
							class="input py-1.5 text-xs file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-2.5 file:py-0.5 file:text-xs file:font-medium file:text-foreground"
							type="file"
							accept=".pgmbackup,application/json"
							onchange={(e) => ((restoreFile = e.currentTarget.files?.[0] ?? null), (preview = null))}
						/>
					</div>
					<div>
						<label class="label" for="bk-restore-pass">Passphrase</label>
						<input id="bk-restore-pass" class="input" type="password" autocomplete="off" bind:value={restorePass} oninput={() => (preview = null)} />
					</div>
					<p class="text-xs text-muted-foreground">
						Connections are matched by id and users by email: matches are updated, the rest added. Nothing is deleted, and your own account is never changed.
					</p>
					<div class="mt-auto flex justify-end">
						<button class="btn btn-secondary" disabled={restoring || !restoreFile || !restorePass || !!preview}><Eye />{restoring && !preview ? 'Decrypting…' : 'Preview'}</button>
					</div>
				</form>
			</div>

			{#if preview}
				{@const p = preview}
				<div class="mt-5 overflow-x-auto rounded-xl border border-border">
					<div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-3">
						<p class="text-[13px] font-medium">Backup from {new Date(p.createdAt).toLocaleString()}</p>
						<span class="font-mono text-xs text-muted-foreground">pg·modern {p.appVersion}</span>
						<span class="ml-auto text-xs text-muted-foreground">Choose what to restore</span>
					</div>
					<table class="w-full text-[13px]">
						<thead class="text-left text-[11px] tracking-wide text-muted-foreground uppercase">
							<tr class="border-b border-border">
								<th class="w-10 px-4 py-2 font-medium"><span class="sr-only">Restore</span></th>
								<th class="px-2 py-2 font-medium">Category</th>
								<th class="px-2 py-2 font-medium">In backup</th>
								<th class="px-4 py-2 font-medium">Changes here</th>
							</tr>
						</thead>
						<tbody>
							{#each CATEGORIES as c (c.key)}
								<tr class="border-b border-border align-top last:border-0">
									<td class="px-4 py-3">
										<input type="checkbox" class="size-4 accent-[var(--primary)]" aria-label="Restore {c.label}" disabled={!p.contains[c.key]} bind:checked={choose[c.key]} />
									</td>
									<td class="px-2 py-3 font-medium whitespace-nowrap">{c.label}</td>
									{#if !p.contains[c.key]}
										<td class="px-2 py-3 text-muted-foreground" colspan="2">Not in this backup</td>
									{:else if c.key === 'connections'}
										<td class="px-2 py-3 whitespace-nowrap text-muted-foreground">
											{p.connections.length} connections{#if p.savedQueries}<br />{p.savedQueries.total} saved queries{/if}
										</td>
										<td class="px-4 py-3">
											<ul class="space-y-1 text-xs">
												{#each p.connections as conn (conn.id)}
													<li class="flex items-center gap-2">
														<span class="badge {STATUS_CLASS[conn.status]} w-16 justify-center">{STATUS_LABEL[conn.status]}</span>
														<span class="font-medium">{conn.name}</span>
														<span class="truncate font-mono text-muted-foreground">{conn.target}</span>
													</li>
												{:else}
													<li class="text-muted-foreground">No connections</li>
												{/each}
											</ul>
											{#if p.savedQueries && !p.savedQueries.supported}<p class="mt-2 text-xs text-warning">This install has no saved queries yet; they'll be skipped.</p>{/if}
										</td>
									{:else if c.key === 'users'}
										<td class="px-2 py-3 whitespace-nowrap text-muted-foreground">{p.users.length} users<br />{p.grants} grants</td>
										<td class="px-4 py-3">
											<ul class="space-y-1 text-xs">
												{#each p.users as u (u.email)}
													<li class="flex items-center gap-2">
														<span class="badge {STATUS_CLASS[u.status]} w-16 justify-center">{STATUS_LABEL[u.status]}</span>
														<span class="font-medium">{u.email}</span>
														<span class="text-muted-foreground">{u.role}</span>
													</li>
												{/each}
											</ul>
										</td>
									{:else}
										<td class="px-2 py-3 whitespace-nowrap text-muted-foreground">{p.settings.length} groups<br />replaced as a whole</td>
										<td class="px-4 py-3">
											<ul class="space-y-1 text-xs">
												{#each p.settings as item (item.label)}
													<li class="flex items-center gap-2">
														<span class="badge {STATUS_CLASS[item.status]} w-16 justify-center">{STATUS_LABEL[item.status]}</span>
														<span class="font-medium whitespace-nowrap">{item.label}</span>
														<span class="truncate text-muted-foreground">{item.detail}</span>
													</li>
												{/each}
											</ul>
										</td>
									{/if}
								</tr>
							{/each}
						</tbody>
					</table>
					<div class="flex items-center gap-2 border-t border-border px-4 py-3">
						<button type="button" class="btn btn-ghost mr-auto" onclick={() => (preview = null)}>Cancel</button>
						<button type="button" class="btn btn-primary" disabled={restoring || !Object.values(choose).some(Boolean)} onclick={applyRestore}>
							<RotateCcw />{restoring ? 'Restoring…' : 'Apply restore'}
						</button>
					</div>
				</div>
			{/if}
		</section>
	</div>
</div>
