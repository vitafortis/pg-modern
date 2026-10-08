<script lang="ts">
	import { onMount } from 'svelte';
	import { Ban, KeyRound, LoaderCircle, Plus, ShieldCheck, Trash2, UserCheck, UserPlus } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import Dialog from '#lib/components/Dialog.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { ago } from '#lib/client/format.ts';
	import { session, toast } from '#lib/client/state.svelte.ts';
	import type { Role, User } from '#lib/types.ts';

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
			api.get<{ env: { oidc: Oidc } }>('/api/settings').then((s) => s.env.oidc)
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
				<p class="mt-1 text-xs text-muted-foreground">Browse and query every connection — always in a read-only transaction. Can't see discovery, settings or credentials.</p>
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
