<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { CircleCheck, Copy, Eye, EyeOff, KeyRound, LoaderCircle, Play, RefreshCw, ShieldCheck, TriangleAlert, UserRoundCheck } from '@lucide/svelte';
	import Dialog from './Dialog.svelte';
	import Switch from './Switch.svelte';
	import { ApiError, api, errorMessage } from '#lib/client/api.ts';
	import { copyText } from '#lib/client/clipboard.ts';
	import { confirmAction, connections, refreshConnections, toast } from '#lib/client/state.svelte.ts';
	import { generatePassword } from '#lib/password.ts';
	import { engineLabel } from '#lib/engine.ts';
	import type { Connection, QueryError } from '#lib/types.ts';

	let { open = $bindable(false), conn }: { open: boolean; conn: Connection } = $props();

	type Context = {
		engine: 'postgres' | 'mysql';
		currentUser: string;
		elevated: boolean;
		database: string;
		schemas?: { name: string; owners: string[] }[];
		hasReadAllData?: boolean;
		serverVersionNum?: number;
		databases?: string[];
		noBackslashEscapes?: boolean;
	};
	type Preview = { script: string; redacted: string; exists: boolean | null };
	type ApplyOutcome = { ok: true; applied: number } | { ok: false; applied: number; error: QueryError & { statementIndex: number; sql: string } };

	let ctx = $state<Context | null>(null);
	let loadError = $state('');
	let name = $state('pgmodern_ro');
	let host = $state('%');
	let password = $state(generatePassword());
	let showPassword = $state(false);
	let showInScript = $state(false);
	let mode = $state<'schemas' | 'read_all_data'>('schemas');
	const picked = new SvelteSet<string>();
	let allDatabases = $state(false);
	let defaultPrivileges = $state(true);
	let monitor = $state(true);
	let readAllStats = $state(false);
	let prehash = $state(true);
	let perfSchema = $state(false);
	let preview = $state<Preview | null>(null);
	let previewError = $state('');
	let applying = $state(false);
	let applied = $state<ApplyOutcome | null>(null);
	let switching = $state(false);
	let switched = $state(false);

	const live = $derived(connections.list.find((c) => c.id === conn.id) ?? conn);
	const writable = $derived(!(live.access?.readOnly ?? true));
	const mysql = $derived(ctx?.engine === 'mysql');

	async function loadContext() {
		ctx = null;
		loadError = '';
		applied = null;
		switched = false;
		try {
			const c = await api.get<Context>(`/api/connections/${conn.id}/readonly-user`);
			picked.clear();
			for (const n of c.engine === 'mysql' ? (c.databases ?? []) : (c.schemas ?? []).map((s) => s.name)) picked.add(n);
			ctx = c;
		} catch (err) {
			loadError = errorMessage(err);
		}
	}

	$effect(() => {
		if (open) untrack(loadContext);
	});

	function options() {
		if (!ctx) return null;
		if (ctx.engine === 'mysql') {
			return {
				user: name,
				host,
				password,
				databases: allDatabases ? '*' : [...picked],
				process: monitor,
				performanceSchema: perfSchema
			};
		}
		return {
			role: name,
			password,
			mode,
			schemas: (ctx.schemas ?? []).filter((s) => picked.has(s.name)),
			defaultPrivileges,
			monitor,
			readAllStats,
			prehash
		};
	}

	// Regenerate the preview whenever an option changes (debounced).
	$effect(() => {
		const opts = options();
		void [picked.size, ...picked];
		if (!opts || !open) return;
		const t = setTimeout(async () => {
			try {
				preview = await api.post<Preview>(`/api/connections/${conn.id}/readonly-user`, { action: 'preview', options: opts });
				previewError = '';
			} catch (err) {
				preview = null;
				previewError = errorMessage(err);
			}
		}, 250);
		return () => clearTimeout(t);
	});

	function togglePick(n: string) {
		if (picked.has(n)) picked.delete(n);
		else picked.add(n);
	}

	async function apply() {
		const opts = options();
		if (!opts || !preview) return;
		const ok = await confirmAction({
			title: `Create ${name} on ${conn.name}?`,
			body: `These statements run now with ${live.user}’s privileges${mysql ? ' and are committed one by one' : ', in a single transaction'}. The password is masked here.`,
			detail: preview.redacted,
			confirmLabel: 'Create user',
			danger: true
		});
		if (!ok) return;
		applying = true;
		try {
			applied = await api.post<ApplyOutcome>(`/api/connections/${conn.id}/readonly-user`, { action: 'apply', options: opts, confirmed: true });
			if (applied.ok) toast('success', `Created ${name}`, 'Now switch this connection to it, or copy the credentials.');
		} catch (err) {
			if (err instanceof ApiError && err.status === 403) toast('error', 'Writes are locked', errorMessage(err));
			else toast('error', 'Could not create the user', errorMessage(err));
		} finally {
			applying = false;
		}
	}

	async function switchUser() {
		const ok = await confirmAction({
			title: `Switch ${conn.name} to ${name}?`,
			body: `pg·modern tests the new credentials first, then saves them (encrypted) in place of ${live.user}. Anything ${name} can’t read will no longer show up here.`,
			confirmLabel: 'Test and switch'
		});
		if (!ok) return;
		switching = true;
		try {
			await api.post(`/api/connections/${conn.id}/readonly-user/switch`, { user: name, password });
			await refreshConnections();
			switched = true;
			toast('success', `${conn.name} now connects as ${name}`);
		} catch (err) {
			toast('error', 'Could not switch', errorMessage(err));
		} finally {
			switching = false;
		}
	}

	const shownScript = $derived(preview ? (showInScript ? preview.script : preview.redacted) : '');
</script>

<Dialog bind:open title="Create a read-only user for pg·modern" description="Generates SQL for a dedicated login that can only read. Nothing runs until you choose to." width="max-w-3xl">
	{#if loadError}
		<div class="rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs">
			<p class="font-medium">Could not read the server’s schemas and roles</p>
			<p class="mt-1 font-mono text-muted-foreground">{loadError}</p>
			<button class="btn btn-secondary btn-sm mt-2" onclick={loadContext}><RefreshCw />Try again</button>
		</div>
	{:else if !ctx}
		<div class="grid h-40 place-items-center"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
	{:else}
		<div class="space-y-4">
			<p class="text-xs text-muted-foreground">
				{engineLabel(ctx.engine, live.flavor)} · connected as <span class="font-mono text-foreground">{ctx.currentUser}</span>{#if ctx.elevated}<span class="badge badge-warning ml-1.5">{mysql ? 'admin' : 'superuser'}</span>{/if}.
				pg·modern only needs to read; a dedicated user means a bug or a mistyped query can’t change anything, even with writes unlocked.
			</p>

			<div class="grid gap-3 {mysql ? 'grid-cols-[1fr_10rem]' : ''}">
				<div>
					<label class="label" for="ro-name">{mysql ? 'User name' : 'Role name'}</label>
					<input id="ro-name" class="input font-mono text-[13px]" bind:value={name} autocomplete="off" spellcheck="false" />
					{#if preview?.exists}<p class="mt-1 text-[11px] text-warning">{mysql ? 'That account' : 'A role with that name'} already exists — CREATE will fail. Pick another name.</p>{/if}
				</div>
				{#if mysql}
					<div>
						<label class="label" for="ro-host">Host pattern</label>
						<input id="ro-host" class="input font-mono text-[13px]" bind:value={host} placeholder="%" title="% allows any host; 10.0.0.% a subnet; a single address or name pins it" />
					</div>
				{/if}
			</div>

			<div>
				<label class="label" for="ro-pass">Password</label>
				<div class="flex gap-2">
					<input id="ro-pass" class="input font-mono text-[13px]" type={showPassword ? 'text' : 'password'} bind:value={password} autocomplete="new-password" spellcheck="false" />
					<button class="btn btn-secondary btn-icon" title={showPassword ? 'Hide' : 'Show'} aria-label={showPassword ? 'Hide password' : 'Show password'} onclick={() => (showPassword = !showPassword)}>
						{#if showPassword}<EyeOff />{:else}<Eye />{/if}
					</button>
					<button class="btn btn-secondary btn-icon" title="Copy password" aria-label="Copy password" onclick={() => copyText(password, 'Password copied')}><Copy /></button>
					<button class="btn btn-secondary btn-icon" title="Generate a new one" aria-label="Generate a new password" onclick={() => (password = generatePassword())}><RefreshCw /></button>
				</div>
				<p class="mt-1 text-[11px] text-muted-foreground">28 random letters and digits. “Switch this connection” below stores it encrypted; keep a copy if anything else will use this user.</p>
			</div>

			{#if !mysql}
				<div>
					<span class="label">What it can read</span>
					<div class="inline-flex rounded-lg border border-border bg-surface p-0.5">
						<button class="h-7 rounded-md px-2.5 text-xs {mode === 'schemas' ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground'}" onclick={() => (mode = 'schemas')}>Selected schemas</button>
						<button
							class="h-7 rounded-md px-2.5 text-xs {mode === 'read_all_data' ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground'} disabled:opacity-50"
							disabled={!ctx.hasReadAllData}
							title={ctx.hasReadAllData ? 'Every table in every schema, including ones created later' : 'Needs Postgres 14 or later'}
							onclick={() => (mode = 'read_all_data')}>Everything (pg_read_all_data)</button
						>
					</div>
					{#if mode === 'read_all_data'}
						<p class="mt-1.5 text-[11px] text-muted-foreground">The predefined role pg_read_all_data (Postgres 14+) reads every table, view and sequence in every schema — now and in the future — without per-schema grants or default privileges.</p>
					{:else}
						<div class="mt-2 flex flex-wrap gap-1.5">
							{#each ctx.schemas ?? [] as s (s.name)}
								<button
									class="h-7 rounded-lg border px-2.5 font-mono text-[11px] transition-colors {picked.has(s.name) ? 'border-primary/30 bg-primary-soft text-primary' : 'border-border text-muted-foreground line-through decoration-muted-foreground/50'}"
									aria-pressed={picked.has(s.name)}
									title={s.owners.length ? `Objects owned by ${s.owners.join(', ')}` : 'Empty schema'}
									onclick={() => togglePick(s.name)}>{s.name}</button
								>
							{/each}
						</div>
						<label class="mt-3 flex items-start gap-3">
							<Switch bind:checked={defaultPrivileges} label="Default privileges" />
							<span class="text-xs">
								<span class="font-medium">Also tables created later</span>
								<span class="block text-muted-foreground">
									GRANT … ON ALL TABLES only covers tables that exist today. ALTER DEFAULT PRIVILEGES covers future ones, but it’s set per creating role — the script does it for each role that owns objects in these schemas ({[...new Set((ctx.schemas ?? []).filter((s) => picked.has(s.name)).flatMap((s) => s.owners))].join(', ') || 'none yet'}). Tables created by other roles later still need a GRANT.
								</span>
							</span>
						</label>
					{/if}
				</div>
			{:else}
				<div>
					<span class="label">Databases</span>
					<div class="flex flex-wrap gap-1.5">
						<button
							class="h-7 rounded-lg border px-2.5 text-[11px] {allDatabases ? 'border-primary/30 bg-primary-soft text-primary' : 'border-border text-muted-foreground'}"
							aria-pressed={allDatabases}
							onclick={() => (allDatabases = !allDatabases)}>All databases (*.*)</button
						>
						{#if !allDatabases}
							{#each ctx.databases ?? [] as d (d)}
								<button
									class="h-7 rounded-lg border px-2.5 font-mono text-[11px] {picked.has(d) ? 'border-primary/30 bg-primary-soft text-primary' : 'border-border text-muted-foreground line-through decoration-muted-foreground/50'}"
									aria-pressed={picked.has(d)}
									onclick={() => togglePick(d)}>{d}</button
								>
							{/each}
						{/if}
					</div>
					<p class="mt-1.5 text-[11px] text-muted-foreground">Grants SELECT and SHOW VIEW. Per-database grants also cover tables created later; *.* includes databases created later.</p>
				</div>
			{/if}

			<div class="space-y-2.5 rounded-xl border border-border bg-surface p-3">
				<label class="flex items-start gap-3">
					<Switch bind:checked={monitor} label="Monitoring privileges" />
					<span class="text-xs">
						<span class="font-medium">Include monitoring privileges</span>
						<span class="block text-muted-foreground">
							{#if mysql}PROCESS: see every session and InnoDB transaction in Activity and Health.{:else}pg_monitor: see every session, query and statistic in Activity and Health (includes pg_read_all_stats).{/if}
						</span>
					</span>
				</label>
				{#if !mysql && !monitor}
					<label class="flex items-start gap-3">
						<Switch bind:checked={readAllStats} label="pg_read_all_stats" />
						<span class="text-xs"><span class="font-medium">Only pg_read_all_stats</span><span class="block text-muted-foreground">Read all pg_stat_* views, including other roles’ queries, without the rest of pg_monitor.</span></span>
					</label>
				{/if}
				{#if mysql}
					<label class="flex items-start gap-3">
						<Switch bind:checked={perfSchema} label="performance_schema" />
						<span class="text-xs"><span class="font-medium">Read performance_schema</span><span class="block text-muted-foreground">Index usage for the Health tab and lock waits in Activity.</span></span>
					</label>
				{:else}
					<label class="flex items-start gap-3">
						<Switch bind:checked={prehash} label="Send a SCRAM hash" />
						<span class="text-xs"><span class="font-medium">Send the password as a SCRAM-SHA-256 hash</span><span class="block text-muted-foreground">The plain password never reaches the server or its statement log.</span></span>
					</label>
				{/if}
			</div>

			<div class="overflow-hidden rounded-lg border border-border bg-background">
				<div class="flex items-center gap-1 border-b border-border px-2 py-1">
					<span class="mr-auto text-[11px] text-muted-foreground">Generated SQL — run it as an administrator</span>
					<button class="btn btn-ghost btn-sm" onclick={() => (showInScript = !showInScript)} disabled={!preview}>
						{#if showInScript}<EyeOff />Hide password{:else}<Eye />Show password{/if}
					</button>
					<button class="btn btn-ghost btn-sm" disabled={!preview} onclick={() => preview && copyText(preview.script, 'SQL copied (includes the password)')}><Copy />Copy</button>
				</div>
				{#if previewError}
					<p class="flex items-start gap-2 p-3 text-xs text-danger"><TriangleAlert class="mt-px size-3.5 shrink-0" />{previewError}</p>
				{:else if preview}
					<pre class="max-h-72 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre">{shownScript}</pre>
				{:else}
					<div class="grid h-24 place-items-center"><LoaderCircle class="size-4 animate-spin text-muted-foreground" /></div>
				{/if}
			</div>

			{#if applied && !applied.ok}
				<div class="rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs">
					<p class="font-medium">Statement {applied.error.statementIndex + 1} failed{mysql && applied.applied ? ` — the ${applied.applied} before it were applied` : ' — nothing was changed'}</p>
					<p class="mt-1 font-mono text-muted-foreground">{applied.error.message}</p>
					<p class="mt-1 font-mono text-[11px] text-muted-foreground">{applied.error.sql}</p>
				</div>
			{:else if applied?.ok}
				<p class="flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 p-3 text-xs">
					<CircleCheck class="size-4 text-success" />Created {name} ({applied.applied} statements). Switch this connection to it below.
				</p>
			{/if}
			{#if switched}
				<p class="flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 p-3 text-xs"><ShieldCheck class="size-4 text-success" />{conn.name} now connects as {name}.</p>
			{/if}
		</div>
	{/if}

	{#snippet footer()}
		{#if ctx}
			<span class="mr-auto text-[11px] text-muted-foreground">
				{#if writable}Apply runs it on this connection now.{:else}Unlock writes on this connection to apply it here, or run the script yourself.{/if}
			</span>
			<button class="btn btn-secondary" disabled={!preview || applying || !writable} title={writable ? 'Run the statements now' : 'This connection is read-only right now'} onclick={apply}>
				{#if applying}<LoaderCircle class="animate-spin" />{:else}<Play />{/if}Apply
			</button>
			<button class="btn btn-primary" disabled={!preview || switching || switched || !name.trim() || !password} title="Test the new user, then save it on this connection" onclick={switchUser}>
				{#if switching}<LoaderCircle class="animate-spin" />{:else if switched}<UserRoundCheck />{:else}<KeyRound />{/if}Switch this connection to {name || 'the new user'}
			</button>
		{/if}
	{/snippet}
</Dialog>
