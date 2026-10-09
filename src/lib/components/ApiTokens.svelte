<script lang="ts">
	import { onMount } from 'svelte';
	import { Ban, CircleAlert, Copy, KeyRound, LoaderCircle, Plus, Trash2, X } from '@lucide/svelte';
	import Switch from './Switch.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { ago } from '#lib/client/format.ts';
	import { confirmAction, toast } from '#lib/client/state.svelte.ts';

	type Token = {
		id: string;
		name: string;
		prefix: string;
		scope: 'status';
		includeAddresses: boolean;
		expiresAt: string | null;
		createdBy: string | null;
		createdAt: string;
		lastUsedAt: string | null;
		revokedAt: string | null;
	};

	let tokens = $state<Token[]>([]);
	let loaded = $state(false);
	let form = $state({ name: '', expiresInDays: '', includeAddresses: false });
	let busy = $state(false);
	/** The token just created: shown once, then gone for good. */
	let created = $state<{ token: string; record: Token } | null>(null);

	const origin = typeof location === 'undefined' ? '' : location.origin;

	async function load() {
		try {
			tokens = await api.get<Token[]>('/api/integrations/tokens');
		} catch (err) {
			toast('error', 'Could not load API tokens', errorMessage(err));
		} finally {
			loaded = true;
		}
	}
	onMount(load);

	async function create(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			created = await api.post<{ token: string; record: Token }>('/api/integrations/tokens', {
				name: form.name,
				expiresInDays: form.expiresInDays ? Number(form.expiresInDays) : null,
				includeAddresses: form.includeAddresses
			});
			form = { name: '', expiresInDays: '', includeAddresses: false };
			await load();
		} catch (err) {
			toast('error', 'Could not create the token', errorMessage(err));
		} finally {
			busy = false;
		}
	}

	async function revoke(t: Token) {
		const ok = await confirmAction({
			title: `Revoke “${t.name}”?`,
			body: 'Dashboards using it stop getting status right away. This can’t be undone.',
			confirmLabel: 'Revoke',
			danger: true
		});
		if (!ok) return;
		try {
			await api.del(`/api/integrations/tokens/${t.id}`);
			if (created?.record.id === t.id) created = null;
			await load();
		} catch (err) {
			toast('error', 'Could not revoke', errorMessage(err));
		}
	}

	async function purge(t: Token) {
		try {
			await api.del(`/api/integrations/tokens/${t.id}?purge=1`);
			await load();
		} catch (err) {
			toast('error', 'Could not remove', errorMessage(err));
		}
	}

	function copy(text: string, what = 'Copied') {
		navigator.clipboard.writeText(text);
		toast('success', what);
	}

	const expired = (t: Token) => !!t.expiresAt && Date.parse(t.expiresAt) <= Date.now();
	const curl = $derived(created ? `curl -H "Authorization: Bearer ${created.token}" ${origin}/api/status` : '');
</script>

{#if created}
	<div class="mt-4 rounded-lg border border-success/30 bg-success/5 p-3">
		<div class="flex items-start gap-2">
			<KeyRound class="mt-0.5 size-4 shrink-0 text-success" />
			<div class="min-w-0 flex-1">
				<p class="text-[13px] font-medium">Token “{created.record.name}” created — copy it now</p>
				<p class="text-[11px] text-muted-foreground">Only a hash is stored, so it can't be shown again. Treat it like a password.</p>
			</div>
			<button class="btn btn-ghost btn-icon btn-sm -mt-1 -mr-1" aria-label="Dismiss" onclick={() => (created = null)}><X /></button>
		</div>
		<div class="mt-2 flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5">
			<code class="min-w-0 flex-1 font-mono text-xs break-all select-all">{created.token}</code>
			<button class="btn btn-secondary btn-sm" onclick={() => copy(created!.token, 'Token copied')}><Copy />Copy</button>
		</div>
		<div class="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
			<code class="min-w-0 flex-1 truncate font-mono">{curl}</code>
			<button class="btn btn-ghost btn-sm" onclick={() => copy(curl, 'Command copied')}><Copy />curl</button>
		</div>
	</div>
{/if}

{#if tokens.length}
	<div class="mt-4 overflow-hidden rounded-lg border border-border">
		<table class="w-full text-xs">
			<thead class="bg-surface text-left text-[11px] text-muted-foreground">
				<tr>
					<th class="px-3 py-2 font-medium">Name</th>
					<th class="px-3 py-2 font-medium">Token</th>
					<th class="px-3 py-2 font-medium">Last used</th>
					<th class="px-3 py-2 font-medium">Expires</th>
					<th class="w-24 px-3 py-2"></th>
				</tr>
			</thead>
			<tbody>
				{#each tokens as t (t.id)}
					{@const dead = !!t.revokedAt || expired(t)}
					<tr class="border-t border-border {dead ? 'text-muted-foreground' : ''}">
						<td class="px-3 py-2">
							<span class="font-medium {dead ? 'line-through' : ''}">{t.name}</span>
							{#if t.includeAddresses}<span class="badge badge-warning ml-1.5">addresses</span>{/if}
							{#if t.revokedAt}<span class="badge ml-1.5">revoked</span>{:else if expired(t)}<span class="badge ml-1.5">expired</span>{/if}
							<p class="text-[11px] text-muted-foreground">created {ago(t.createdAt)}{t.createdBy ? ` by ${t.createdBy}` : ''}</p>
						</td>
						<td class="px-3 py-2 font-mono text-muted-foreground">{t.prefix}…</td>
						<td class="px-3 py-2 text-muted-foreground">{t.lastUsedAt ? ago(t.lastUsedAt) : 'never'}</td>
						<td class="px-3 py-2 text-muted-foreground">{t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : 'never'}</td>
						<td class="px-3 py-2 text-right">
							{#if !t.revokedAt}
								<button class="btn btn-ghost btn-sm hover:text-danger" onclick={() => revoke(t)}><Ban />Revoke</button>
							{:else}
								<button class="btn btn-ghost btn-icon btn-sm" title="Remove from the list" onclick={() => purge(t)}><Trash2 /></button>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{:else if loaded}
	<p class="mt-4 text-xs text-muted-foreground">No tokens yet.</p>
{/if}

<form class="mt-4 grid items-end gap-2 md:grid-cols-[1fr_9rem_auto_auto]" onsubmit={create}>
	<div>
		<label class="label" for="tok-name">Name</label>
		<input id="tok-name" class="input h-8 text-xs" placeholder="Homepage dashboard" maxlength="80" required bind:value={form.name} />
	</div>
	<div>
		<label class="label" for="tok-exp">Expires</label>
		<select id="tok-exp" class="input h-8 text-xs" bind:value={form.expiresInDays}>
			<option value="">Never</option>
			<option value="30">In 30 days</option>
			<option value="90">In 90 days</option>
			<option value="365">In a year</option>
		</select>
	</div>
	<label class="flex h-8 items-center gap-2 text-xs text-muted-foreground" title="Adds host, port and database name to each item. Off by default.">
		<Switch label="Include addresses" bind:checked={form.includeAddresses} />Include addresses
	</label>
	<button class="btn btn-primary h-8" disabled={busy || !form.name.trim()}>{#if busy}<LoaderCircle class="animate-spin" />{:else}<Plus />{/if}Create token</button>
</form>
<p class="mt-3 flex items-start gap-1.5 text-[11px] text-muted-foreground">
	<CircleAlert class="mt-px size-3.5 shrink-0" />
	<span>
		Send it as <code class="font-mono">Authorization: Bearer pgm_…</code>. Widgets that can't set headers may use <code class="font-mono">?token=pgm_…</code>, but
		URLs end up in proxy logs and browser history — prefer the header, and give such widgets their own token so you can revoke it alone. Badges:
		<code class="font-mono">/api/status/badge/&lt;connection id&gt;.svg?token=…</code>
	</span>
</p>
