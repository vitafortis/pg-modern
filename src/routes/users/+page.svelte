<script lang="ts">
	import { onMount } from 'svelte';
	import { Ban, Database, KeyRound, LoaderCircle, Plus, ShieldCheck, Trash2, UserCheck, UserPlus } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import Dialog from '#lib/components/Dialog.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { ago } from '#lib/client/format.ts';
	import { connections, session, toast } from '#lib/client/state.svelte.ts';
	import { COLORS } from '#lib/client/format.ts';
	import type { Grant, Role, User } from '#lib/types.ts';

	type Oidc = { name: string; autoCreate: string[]; adminEmails: string[]; defaultRole: Role } | null;

	let users = $state<User[]>([]);
	let oidc = $state<Oidc>(null);
	let loading = $state(true);
	let adding = $state(false);
	let form = $state({ email: '', name: '', role: 'viewer' as Role, password: '' });
	let saving = $state(false);
	let confirmDelete = $state<User | null>(null);

	async function load() {
		[users, oidc] = await Promise.all([
			api.get<User[]>('/api/users'),
			api.get<{ config: Oidc }>('/api/integrations/sso').then((s) => s.config)
		]);
		loading = false;
	}

	onMount(load);

	async function patch(user: User, body: Record<string, unknown>, message: string) {
		try {
			await api.patch(`/api/users/${user.id}`, body);
			toast('success', message, user.email);
			await load();
		} catch (err) {
			toast('error', 'Could not update user', errorMessage(err));
		}
	}

	async function add(e: SubmitEvent) {
		e.preventDefault();
		saving = true;
		try {
			await api.post('/api/users', { ...form, password: form.password || undefined });
			toast('success', 'User added', form.email);
			adding = false;
			form = { email: '', name: '', role: 'viewer', password: '' };
			await load();
		} catch (err) {
			toast('error', 'Could not add user', errorMessage(err));
		} finally {
			saving = false;
		}
	}

	async function remove(user: User) {
		try {
			await api.del(`/api/users/${user.id}`);
			toast('success', 'User deleted', user.email);
			confirmDelete = null;
			await load();
		} catch (err) {
			toast('error', 'Could not delete user', errorMessage(err));
		}
	}

	const isSelf = (u: User) => u.email === session.viewer?.email;

	// Connection access editor (viewers only; admins see and can unlock everything).
	let accessFor = $state<User | null>(null);
	let accessMode = $state<User['connectionAccess']>('all');
	let grants = $state<Record<string, { read: boolean; write: boolean }>>({});
	let savingAccess = $state(false);

	async function editAccess(u: User) {
		const res = await api.get<{ connectionAccess: User['connectionAccess']; grants: Grant[] }>(`/api/users/${u.id}/access`);
		accessMode = res.connectionAccess;
		grants = Object.fromEntries(connections.list.map((c) => [c.id, { read: false, write: false }]));
		for (const g of res.grants) grants[g.connectionId] = { read: true, write: g.canWrite };
		accessFor = u;
	}

	async function saveAccess() {
		if (!accessFor) return;
		savingAccess = true;
		try {
			const list = Object.entries(grants)
				.filter(([, g]) => g.write || (accessMode === 'selected' && g.read))
				.map(([connectionId, g]) => ({ connectionId, canWrite: g.write }));
			await api.put(`/api/users/${accessFor.id}/access`, { connectionAccess: accessMode, grants: list });
			toast('success', 'Access updated', accessFor.email);
			accessFor = null;
			await load();
		} catch (err) {
			toast('error', 'Could not update access', errorMessage(err));
		} finally {
			savingAccess = false;
		}
	}
</script>

<svelte:head><title>Users · pg·modern</title></svelte:head>

<div class="h-full overflow-y-auto">
	<PageHeader title="Users" description="Who can sign in, and what they can do.">
		{#snippet actions()}
			<button class="btn btn-primary" onclick={() => (adding = true)}><UserPlus />Add user</button>
		{/snippet}
	</PageHeader>

	<div class="max-w-5xl space-y-5 px-8 pb-10">
		<div class="grid gap-3 md:grid-cols-2">
			<div class="card p-4 text-[13px]">
				<p class="flex items-center gap-2 font-medium"><ShieldCheck class="size-4 text-primary" />Admin</p>
				<p class="mt-1 text-xs text-muted-foreground">Everything: connections, discovery, settings, users, and writes on read/write connections.</p>
			</div>
			<div class="card p-4 text-[13px]">
				<p class="flex items-center gap-2 font-medium"><UserCheck class="size-4 text-primary" />Viewer</p>
				<p class="mt-1 text-xs text-muted-foreground">Browse and query every connection, or only the ones you pick, in a read-only transaction. You can let them unlock writes on specific connections. Can't see discovery, settings or credentials.</p>
			</div>
		</div>

		{#if oidc}
			<div class="card flex flex-wrap items-center gap-x-4 gap-y-1 p-4 text-xs text-muted-foreground">
				<span class="flex items-center gap-1.5 font-medium text-foreground"><KeyRound class="size-3.5 text-primary" />{oidc.name} sign-in is on.</span>
				{#if oidc.autoCreate.length}
					<span>New accounts are created for <code class="font-mono text-foreground">{oidc.autoCreate.join(', ')}</code> as <b class="text-foreground">{oidc.defaultRole}</b>{#if oidc.adminEmails.length}{' '}(admin for <code class="font-mono text-foreground">{oidc.adminEmails.join(', ')}</code>){/if}.</span>
				{:else}
					<span>Only users listed here can sign in — add their email and they can use {oidc.name} right away.</span>
				{/if}
			</div>
		{/if}

		<div class="card overflow-hidden">
			{#if loading}
				<div class="grid h-32 place-items-center"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
			{:else}
				<table class="w-full text-left text-[13px]">
					<thead class="border-b border-border bg-surface text-[11px] text-muted-foreground">
						<tr>
							<th class="px-4 py-2 font-medium">User</th>
							<th class="px-4 py-2 font-medium">Sign-in</th>
							<th class="px-4 py-2 font-medium">Role</th>
							<th class="px-4 py-2 font-medium">Connections</th>
							<th class="px-4 py-2 font-medium">Last seen</th>
							<th class="px-4 py-2"></th>
						</tr>
					</thead>
					<tbody class="divide-y divide-border">
						{#each users as u (u.id)}
							<tr class={u.disabled ? 'opacity-50' : ''}>
								<td class="px-4 py-2.5">
									<div class="flex items-center gap-2.5">
										<span class="grid size-7 shrink-0 place-items-center rounded-full bg-primary-soft text-[11px] font-semibold text-primary uppercase">{(u.name ?? u.email).slice(0, 1)}</span>
										<div class="min-w-0">
											<p class="truncate font-medium">{u.name ?? u.email}{#if isSelf(u)}<span class="ml-1.5 text-[11px] font-normal text-muted-foreground">(you)</span>{/if}</p>
											{#if u.name}<p class="truncate text-[11px] text-muted-foreground">{u.email}</p>{/if}
										</div>
									</div>
								</td>
								<td class="px-4 py-2.5">
									<div class="flex flex-wrap gap-1">
										{#if u.sso}<span class="badge badge-primary">SSO</span>{/if}
										{#if u.hasPassword}<span class="badge">password</span>{/if}
										{#if !u.sso && !u.hasPassword}<span class="badge">awaiting SSO</span>{/if}
										{#if u.disabled}<span class="badge badge-danger">disabled</span>{/if}
									</div>
								</td>
								<td class="px-4 py-2.5">
									<select
										class="input h-7 w-28 text-xs"
										value={u.role}
										disabled={isSelf(u)}
										onchange={(e) => patch(u, { role: (e.currentTarget as HTMLSelectElement).value }, 'Role updated')}
									>
										<option value="admin">Admin</option>
										<option value="viewer">Viewer</option>
									</select>
								</td>
								<td class="px-4 py-2.5">
									{#if u.role === 'admin'}
										<span class="text-xs text-muted-foreground">All</span>
									{:else}
										<button class="btn btn-ghost btn-sm -ml-2.5" onclick={() => editAccess(u)}>
											<Database />{u.connectionAccess === 'all' ? 'All, read-only' : 'Selected'}
										</button>
									{/if}
								</td>
								<td class="px-4 py-2.5 text-xs text-muted-foreground">{ago(u.lastLoginAt)}</td>
								<td class="px-4 py-2.5">
									{#if !isSelf(u)}
										<div class="flex justify-end gap-1">
											<button
												class="btn btn-ghost btn-sm"
												onclick={() => patch(u, { disabled: !u.disabled }, u.disabled ? 'User enabled' : 'User disabled')}
											>
												<Ban />{u.disabled ? 'Enable' : 'Disable'}
											</button>
											<button class="btn btn-ghost btn-icon btn-sm hover:text-danger" title="Delete" onclick={() => (confirmDelete = u)}><Trash2 /></button>
										</div>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</div>
	</div>
</div>

<Dialog bind:open={adding} title="Add user" description={oidc ? `They can sign in with ${oidc.name} using this email, or with a password if you set one.` : 'Set a password they can sign in with.'}>
	<form id="add-user" class="space-y-3" onsubmit={add}>
		<div class="grid grid-cols-2 gap-3">
			<div>
				<label class="label" for="u-email">Email</label>
				<input id="u-email" class="input" type="text" required bind:value={form.email} />
			</div>
			<div>
				<label class="label" for="u-name">Name <span class="opacity-60">(optional)</span></label>
				<input id="u-name" class="input" bind:value={form.name} />
			</div>
		</div>
		<div class="grid grid-cols-2 gap-3">
			<div>
				<label class="label" for="u-role">Role</label>
				<select id="u-role" class="input" bind:value={form.role}>
					<option value="viewer">Viewer</option>
					<option value="admin">Admin</option>
				</select>
			</div>
			<div>
				<label class="label" for="u-pass">Password <span class="opacity-60">{oidc ? '(optional)' : ''}</span></label>
				<input id="u-pass" class="input" type="password" autocomplete="new-password" required={!oidc} minlength="8" bind:value={form.password} />
			</div>
		</div>
	</form>
	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (adding = false)}>Cancel</button>
		<button class="btn btn-primary" form="add-user" disabled={saving}>{#if saving}<LoaderCircle class="animate-spin" />{:else}<Plus />{/if}Add user</button>
	{/snippet}
</Dialog>

<Dialog bind:open={() => confirmDelete !== null, (v) => !v && (confirmDelete = null)} title="Delete user?" description="They'll be signed out immediately. Saved connections are not affected.">
	<p class="text-[13px]">{confirmDelete?.email}</p>
	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (confirmDelete = null)}>Cancel</button>
		<button class="btn btn-danger" onclick={() => confirmDelete && remove(confirmDelete)}>Delete</button>
	{/snippet}
</Dialog>

<Dialog
	bind:open={() => accessFor !== null, (v) => !v && (accessFor = null)}
	title="Connection access"
	description={accessFor ? `What ${accessFor.name ?? accessFor.email} can open and change.` : ''}
	width="max-w-xl"
>
	<div class="space-y-4">
		<div class="inline-flex rounded-lg border border-border bg-surface p-0.5">
			<button class="h-7 rounded-md px-3 text-xs {accessMode === 'all' ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground'}" onclick={() => (accessMode = 'all')}>All connections</button>
			<button class="h-7 rounded-md px-3 text-xs {accessMode === 'selected' ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground'}" onclick={() => (accessMode = 'selected')}>Only selected</button>
		</div>
		<p class="text-xs text-muted-foreground">
			{accessMode === 'all'
				? 'They see every connection, read-only. Tick "Can unlock writes" to let them switch on write access temporarily (it’s logged).'
				: 'They only see the connections ticked below. New connections stay hidden until you add them.'}
		</p>
		<div class="divide-y divide-border rounded-xl border border-border">
			{#each connections.list as c (c.id)}
				{@const g = grants[c.id]}
				{#if g}
					<div class="flex items-center gap-3 px-3 py-2 text-[13px]">
						{#if accessMode === 'selected'}
							<input type="checkbox" class="size-4 accent-[var(--primary)]" bind:checked={g.read} onchange={() => !g.read && (g.write = false)} aria-label="Can open {c.name}" />
						{/if}
						<span class="size-2 shrink-0 rounded-full" style="background:{COLORS[c.color] ?? COLORS.violet}"></span>
						<span class="min-w-0 flex-1 truncate {accessMode === 'selected' && !g.read ? 'text-muted-foreground' : ''}">{c.name}</span>
						<label class="flex items-center gap-1.5 text-xs text-muted-foreground {accessMode === 'selected' && !g.read ? 'opacity-40' : ''}">
							<input type="checkbox" class="size-3.5 accent-[var(--warning)]" disabled={accessMode === 'selected' && !g.read} bind:checked={g.write} />
							Can unlock writes
						</label>
					</div>
				{/if}
			{:else}
				<p class="px-3 py-4 text-center text-xs text-muted-foreground">No connections saved yet.</p>
			{/each}
		</div>
	</div>
	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (accessFor = null)}>Cancel</button>
		<button class="btn btn-primary" disabled={savingAccess} onclick={saveAccess}>{#if savingAccess}<LoaderCircle class="animate-spin" />{/if}Save access</button>
	{/snippet}
</Dialog>
