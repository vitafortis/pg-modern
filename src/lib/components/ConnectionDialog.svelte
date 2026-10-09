<script lang="ts">
	import { removeConnection } from '#lib/client/connections.ts';
	import { goto } from '$app/navigation';
	import { CircleCheck, CircleAlert, LoaderCircle, Lock, PencilLine, Trash2, Zap } from '@lucide/svelte';
	import Dialog from './Dialog.svelte';
	import Switch from './Switch.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { COLORS } from '#lib/client/format.ts';
	import { editor, refreshConnections, toast } from '#lib/client/state.svelte.ts';
	import { DEFAULT_PORT, engineLabel } from '#lib/engine.ts';
	import type { Connection, Engine, Flavor, QueryError, SslMode } from '#lib/types.ts';

	type Form = {
		engine: Engine;
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
		engine: 'postgres',
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
	let test = $state<{ ok: true; version: string; latencyMs: number; engine: Engine; flavor: Flavor } | { ok: false; error: QueryError } | null>(null);
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
			form = {
				engine: t.engine,
				name: t.name,
				host: t.host,
				port: t.port,
				database: t.database,
				user: t.user,
				password: '',
				sslMode: t.sslMode,
				readOnly: t.readOnly,
				color: t.color
			};
			changePassword = !t.hasPassword;
		}
	});

	/** Switching engines swaps the defaults that belong to the other one. */
	function setEngine(engine: Engine) {
		if (engine === form.engine) return;
		const other = form.engine;
		if (form.port === DEFAULT_PORT[other] || !form.port) form.port = DEFAULT_PORT[engine];
		if (engine === 'sqlite') {
			if (!form.database.startsWith('/')) form.database = '';
		} else if (other === 'sqlite') {
			form.database = engine === 'postgres' ? 'postgres' : '';
			form.user = engine === 'postgres' ? 'postgres' : 'root';
		} else if (engine === 'mysql') {
			if (form.database === 'postgres') form.database = '';
			if (form.user === 'postgres') form.user = 'root';
		} else {
			if (!form.database) form.database = 'postgres';
			if (form.user === 'root') form.user = 'postgres';
		}
		form.engine = engine;
		test = null;
	}

	/** Paste a postgres://, mysql:// or mariadb:// URL to fill the form. */
	function applyUrl() {
		try {
			const raw = url.trim().replace(/^jdbc:/i, '');
			if (/^sqlite:/i.test(raw)) {
				// sqlite:///abs/path.db or sqlite:/abs/path.db
				setEngine('sqlite');
				form.database = decodeURIComponent(raw.replace(/^sqlite:(\/\/)?/i, '').replace(/[?#].*$/, ''));
				if (!form.name) form.name = form.database.split('/').pop() ?? '';
				url = '';
				return;
			}
			const engine: Engine = /^(mysql|mariadb)/i.test(raw) ? 'mysql' : 'postgres';
			setEngine(engine);
			const u = new URL(raw.replace(/^[a-z][\w+]*:/i, 'http:'));
			form.host = u.hostname;
			form.port = Number(u.port) || DEFAULT_PORT[engine];
			form.user = decodeURIComponent(u.username) || form.user;
			form.password = decodeURIComponent(u.password);
			form.database = decodeURIComponent(u.pathname.slice(1)) || form.database;
			const ssl = (u.searchParams.get('sslmode') ?? u.searchParams.get('ssl-mode') ?? '').toLowerCase();
			if (ssl === 'disable' || ssl === 'disabled') form.sslMode = 'disable';
			else if (ssl === 'require' || ssl === 'required') form.sslMode = 'require';
			else if (ssl === 'verify-full' || ssl === 'verify_identity') form.sslMode = 'verify-full';
			if (!form.name) form.name = `${form.database || form.user} @ ${form.host}`;
			changePassword = true;
			url = '';
		} catch {
			toast('error', 'Not a valid database URL', 'Use postgres://, mysql://, mariadb:// or sqlite:///path');
		}
	}

	const sqlite = $derived(form.engine === 'sqlite');
	/** A SQLite snapshot copied out of a container: path and mode are fixed. */
	const snapshot = $derived(editing?.snapshot ?? null);

	function payload() {
		if (sqlite) {
			return { engine: 'sqlite', name: form.name.trim() || form.database.split('/').pop(), path: form.database.trim(), readOnly: form.readOnly, color: form.color };
		}
		return {
			...form,
			name: form.name.trim() || `${form.database || form.user} @ ${form.host}`,
			password: changePassword ? form.password : undefined
		};
	}

	async function runTest() {
		testing = true;
		test = null;
		try {
			test = snapshot && editing ? await api.post(`/api/connections/${editing.id}/test`) : await api.post('/api/connections/test', { ...payload(), id: editing?.id });
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
	description={sqlite ? 'A SQLite database file pg·modern can read.' : 'Credentials are encrypted at rest with AES-256-GCM.'}
	width="max-w-xl"
>
	<form id="conn-form" onsubmit={save} class="space-y-4">
		<div class="grid grid-cols-3 gap-1 rounded-xl border border-border bg-surface p-1" role="radiogroup" aria-label="Database engine">
			{#each [{ value: 'postgres', label: 'PostgreSQL', sub: 'Postgres and its forks' }, { value: 'mysql', label: 'MySQL · MariaDB', sub: 'MySQL, MariaDB, Percona' }, { value: 'sqlite', label: 'SQLite', sub: 'A database file' }] as e (e.value)}
				<button
					type="button"
					role="radio"
					aria-checked={form.engine === e.value}
					disabled={!!snapshot && e.value !== 'sqlite'}
					class="flex flex-col items-start rounded-lg px-3 py-1.5 text-left transition-colors {form.engine === e.value
						? 'bg-card text-foreground shadow-surface'
						: 'text-muted-foreground hover:text-foreground'}"
					onclick={() => setEngine(e.value as Engine)}
				>
					<span class="text-[13px] font-medium">{e.label}</span>
					<span class="text-[11px] opacity-70">{e.sub}</span>
				</button>
			{/each}
		</div>

		{#if !editing}
			<div class="flex gap-2">
				<input
					class="input font-mono text-xs"
					placeholder={form.engine === 'mysql' ? 'Paste mysql://user:pass@host:3306/db' : sqlite ? 'Paste sqlite:///path/to/app.db' : 'Paste postgres://user:pass@host:5432/db'}
					bind:value={url}
				/>
				<button type="button" class="btn btn-secondary h-9" disabled={!url} onclick={applyUrl}>Fill</button>
			</div>
		{/if}

		<div class="grid grid-cols-[1fr_auto] gap-3">
			<div>
				<label class="label" for="c-name">Name</label>
				<input id="c-name" class="input" placeholder={sqlite ? 'sonarr' : 'media @ nas'} bind:value={form.name} />
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

		{#if sqlite}
			<div>
				<label class="label" for="c-path">Database file</label>
				{#if snapshot}
					<p class="input flex h-9 items-center truncate font-mono text-[13px] text-muted-foreground" title="Snapshot of {snapshot.container}:{snapshot.containerPath}">
						{snapshot.container}:{snapshot.containerPath}
					</p>
					<p class="mt-1 text-[11px] text-muted-foreground">A snapshot copied out of the container — refresh it from the connection’s page.</p>
				{:else}
					<input id="c-path" class="input font-mono text-[13px]" required placeholder="/appdata/sonarr/sonarr.db" bind:value={form.database} />
					<p class="mt-1 text-[11px] text-muted-foreground">
						The path as pg·modern sees it — inside its container, mount the app’s folder (e.g. <code class="font-mono">/opt/appdata:/appdata</code>).
					</p>
				{/if}
			</div>
		{:else}
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
				<label class="label" for="c-db">{form.engine === 'mysql' ? 'Default database' : 'Database'}</label>
				<input
					id="c-db"
					class="input font-mono text-[13px]"
					required={form.engine === 'postgres'}
					placeholder={form.engine === 'mysql' ? 'optional — all are listed' : ''}
					bind:value={form.database}
				/>
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
		{/if}

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
					{#if snapshot}
						A copy of a database taken out of a container. Writes would only change the copy, so it is always read-only.
					{:else if form.readOnly && sqlite}
						The file is opened read-only (<code class="font-mono">mode=ro</code>, <code class="font-mono">query_only</code>) and only reads run (SELECT,
						EXPLAIN, read-only PRAGMAs), inside a transaction that is rolled back. Locks from the app that owns it are waited out for a few seconds.
					{:else if sqlite}
						Statements change the file directly, while the app that owns it may be running. Destructive statements still ask for confirmation — stop the
						app or back up the file first for anything big.
					{:else if form.readOnly && form.engine === 'mysql'}
						Only reads run (SELECT, SHOW, DESCRIBE, EXPLAIN), on a read-only session inside a <code class="font-mono">READ ONLY</code> transaction that is rolled
						back afterwards. A user with only <code class="font-mono">SELECT</code> grants is still the strongest guarantee.
					{:else if form.readOnly}
						Every query runs inside a <code class="font-mono">READ ONLY</code> transaction that is rolled back afterwards. Transaction control is blocked.
					{:else}
						Statements run with the full privileges of <code class="font-mono">{form.user}</code>. Destructive statements still ask for confirmation.
					{/if}
				</p>
			</div>
			<Switch label="Read-only" bind:checked={form.readOnly} disabled={!!snapshot} />
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
						<p class="font-medium text-foreground">{test.engine === 'sqlite' ? 'Opened' : 'Connected to'} {engineLabel(test.engine, test.flavor)} in {test.latencyMs} ms</p>
						<p class="mt-0.5 font-mono text-muted-foreground">{test.version}</p>
					</div>
				{:else}
					<CircleAlert class="size-4 shrink-0 text-danger" />
					<div>
						<p class="font-medium text-foreground">Connection failed</p>
						<p class="mt-0.5 font-mono break-all text-muted-foreground">{test.error.message}</p>
						{#if test.error.hint}<p class="mt-1 text-muted-foreground">{test.error.hint}</p>{/if}
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
		<button class="btn btn-secondary" disabled={testing || (sqlite ? !form.database && !snapshot : !form.host)} onclick={runTest}>
			{#if testing}<LoaderCircle class="animate-spin" />{:else}<Zap />{/if}Test
		</button>
		<button class="btn btn-primary" form="conn-form" type="submit" disabled={saving}>
			{#if saving}<LoaderCircle class="animate-spin" />{/if}{editing ? 'Save changes' : 'Save connection'}
		</button>
	{/snippet}
</Dialog>
