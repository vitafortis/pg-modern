<script lang="ts">
	import { removeConnection } from '#lib/client/connections.ts';
	import { goto } from '$app/navigation';
	import { CircleCheck, CircleAlert, LoaderCircle, Lock, PencilLine, Trash2, Zap } from '@lucide/svelte';
	import Dialog from './Dialog.svelte';
	import Switch from './Switch.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { COLORS } from '#lib/client/format.ts';
	import { editor, refreshConnections, toast } from '#lib/client/state.svelte.ts';
	import type { Connection, QueryError, SslMode } from '#lib/types.ts';

	type Form = {
		name: string;
		host: string;
		port: number;
		database: string;
		user: string;
		password: string;
		sslMode: SslMode;
		readOnly: boolean;
		color: string;
	};

	const blank = (): Form => ({
		name: '',
		host: '',
		port: 5432,
		database: 'postgres',
		user: 'postgres',
		password: '',
		sslMode: 'prefer',
		readOnly: true,
		color: 'violet'
	});

	let form = $state<Form>(blank());
	let url = $state('');
	let changePassword = $state(false);
	let saving = $state(false);
	let testing = $state(false);
	let test = $state<{ ok: true; version: string; latencyMs: number } | { ok: false; error: QueryError } | null>(null);
	let confirmDelete = $state(false);

	const editing = $derived(editor.target && editor.target !== 'new' ? editor.target : null);
	let open = $derived(editor.target !== null);

	$effect(() => {
		const t = editor.target;
		test = null;
		confirmDelete = false;
		url = '';
		if (t === 'new') {
			form = blank();
			changePassword = true;
		} else if (t) {
			form = { ...t, password: '' };
			changePassword = !t.hasPassword;
		}
	});

	/** Paste a postgres:// URL to fill the form. */
	function applyUrl() {
		try {
			const u = new URL(url.trim().replace(/^postgres(ql)?:/i, 'http:'));
			form.host = u.hostname;
			form.port = Number(u.port) || 5432;
			form.user = decodeURIComponent(u.username) || form.user;
			form.password = decodeURIComponent(u.password);
			form.database = decodeURIComponent(u.pathname.slice(1)) || form.database;
			const ssl = u.searchParams.get('sslmode');
			if (ssl === 'disable' || ssl === 'require' || ssl === 'verify-full') form.sslMode = ssl;
			if (!form.name) form.name = `${form.database} @ ${form.host}`;
			changePassword = true;
			url = '';
		} catch {
			toast('error', 'Not a valid postgres:// URL');
		}
	}

	function payload() {
		return {
			...form,
			name: form.name.trim() || `${form.database} @ ${form.host}`,
			password: changePassword ? form.password : undefined
		};
	}

	async function runTest() {
		testing = true;
		test = null;
		try {
			test = await api.post('/api/connections/test', { ...payload(), id: editing?.id });
		} catch (err) {
			test = { ok: false, error: { message: errorMessage(err) } };
		} finally {
			testing = false;
		}
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		saving = true;
		try {
			const saved = editing
				? await api.put<Connection>(`/api/connections/${editing.id}`, payload())
				: await api.post<Connection>('/api/connections', payload());
			await refreshConnections();
			toast('success', editing ? 'Connection updated' : 'Connection saved', saved.name);
			editor.target = null;
			if (!editing) goto(`/c/${saved.id}`);
		} catch (err) {
			toast('error', 'Could not save', errorMessage(err));
		} finally {
			saving = false;
		}
	}

	async function remove() {
		if (editing) await removeConnection(editing);
	}
</script>

<Dialog
	bind:open={() => open, (v) => !v && (editor.target = null)}
	title={editing ? `Edit ${editing.name}` : 'New connection'}
	description="Credentials are encrypted at rest with AES-256-GCM."
	width="max-w-xl"
>
	<form id="conn-form" onsubmit={save} class="space-y-4">
		{#if !editing}
			<div class="flex gap-2">
				<input class="input font-mono text-xs" placeholder="Paste postgres://user:pass@host:5432/db" bind:value={url} />
				<button type="button" class="btn btn-secondary h-9" disabled={!url} onclick={applyUrl}>Fill</button>
			</div>
		{/if}

		<div class="grid grid-cols-[1fr_auto] gap-3">
			<div>
				<label class="label" for="c-name">Name</label>
				<input id="c-name" class="input" placeholder="media @ nas" bind:value={form.name} />
			</div>
			<div>
				<span class="label">Color</span>
				<div class="flex h-9 items-center gap-1.5">
					{#each Object.entries(COLORS) as [key, value] (key)}
						<button
							type="button"
							aria-label={key}
							onclick={() => (form.color = key)}
							class="size-4 rounded-full ring-offset-2 ring-offset-card transition {form.color === key ? 'ring-2 ring-foreground/60' : ''}"
							style="background:{value}"
						></button>
					{/each}
				</div>
			</div>
		</div>

		<div class="grid grid-cols-[1fr_7rem] gap-3">
			<div>
				<label class="label" for="c-host">Host</label>
				<input id="c-host" class="input font-mono text-[13px]" required placeholder="10.0.0.20 or db.lan" bind:value={form.host} />
			</div>
			<div>
				<label class="label" for="c-port">Port</label>
				<input id="c-port" class="input font-mono text-[13px]" type="number" min="1" max="65535" required bind:value={form.port} />
			</div>
		</div>

		<div class="grid grid-cols-2 gap-3">
			<div>
				<label class="label" for="c-db">Database</label>
				<input id="c-db" class="input font-mono text-[13px]" required bind:value={form.database} />
			</div>
			<div>
				<label class="label" for="c-user">User</label>
				<input id="c-user" class="input font-mono text-[13px]" required bind:value={form.user} />
			</div>
		</div>

		<div class="grid grid-cols-2 gap-3">
			<div>
				<label class="label" for="c-pass">Password</label>
				{#if changePassword}
					<input id="c-pass" class="input font-mono text-[13px]" type="password" autocomplete="new-password" bind:value={form.password} />
				{:else}
					<button type="button" class="btn btn-secondary h-9 w-full justify-start font-normal text-muted-foreground" onclick={() => (changePassword = true)}>
						<Lock />Stored securely — change
					</button>
				{/if}
			</div>
			<div>
				<label class="label" for="c-ssl">SSL</label>
				<select id="c-ssl" class="input" bind:value={form.sslMode}>
					<option value="disable">Disable</option>
					<option value="prefer">Prefer</option>
					<option value="require">Require (no verify)</option>
					<option value="verify-full">Verify full</option>
				</select>
			</div>
		</div>

		<div
			class="flex items-start gap-3 rounded-xl border p-3 transition-colors {form.readOnly
				? 'border-border bg-surface'
				: 'border-warning/40 bg-warning/5'}"
		>
			<div class="mt-0.5">
				{#if form.readOnly}<Lock class="size-4 text-primary" />{:else}<PencilLine class="size-4 text-warning" />{/if}
			</div>
			<div class="flex-1">
				<p class="text-[13px] font-medium">{form.readOnly ? 'Read-only' : 'Read/write'}</p>
				<p class="mt-0.5 text-xs text-muted-foreground">
					{#if form.readOnly}
						Every query runs inside a <code class="font-mono">READ ONLY</code> transaction that is rolled back afterwards. Transaction control is blocked.
					{:else}
						Statements run with the full privileges of <code class="font-mono">{form.user}</code>. Destructive statements still ask for confirmation.
					{/if}
				</p>
			</div>
			<Switch label="Read-only" bind:checked={form.readOnly} />
		</div>

		{#if test}
			<div
				class="flex items-start gap-2 rounded-lg border p-3 text-xs {test.ok
					? 'border-success/30 bg-success/5'
					: 'border-danger/30 bg-danger/5'}"
			>
				{#if test.ok}
					<CircleCheck class="size-4 shrink-0 text-success" />
					<div>
						<p class="font-medium text-foreground">Connected in {test.latencyMs} ms</p>
						<p class="mt-0.5 font-mono text-muted-foreground">{test.version}</p>
					</div>
				{:else}
					<CircleAlert class="size-4 shrink-0 text-danger" />
					<div>
						<p class="font-medium text-foreground">Connection failed</p>
						<p class="mt-0.5 font-mono break-all text-muted-foreground">{test.error.message}</p>
					</div>
				{/if}
			</div>
		{/if}
	</form>

	{#snippet footer()}
		{#if editing}
			{#if confirmDelete}
				<span class="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
					Delete for good?
					<button class="btn btn-danger btn-sm" onclick={remove}><Trash2 />Remove</button>
					<button class="btn btn-ghost btn-sm" onclick={() => (confirmDelete = false)}>Keep</button>
				</span>
			{:else}
				<button class="btn btn-ghost mr-auto text-danger hover:text-danger" onclick={() => (confirmDelete = true)}><Trash2 />Delete</button>
			{/if}
		{/if}
		<button class="btn btn-secondary" disabled={testing || !form.host} onclick={runTest}>
			{#if testing}<LoaderCircle class="animate-spin" />{:else}<Zap />{/if}Test
		</button>
		<button class="btn btn-primary" form="conn-form" type="submit" disabled={saving}>
			{#if saving}<LoaderCircle class="animate-spin" />{/if}{editing ? 'Save changes' : 'Save connection'}
		</button>
	{/snippet}
</Dialog>
