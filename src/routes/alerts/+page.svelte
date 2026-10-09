<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import {
		BellRing,
		CircleAlert,
		CircleCheck,
		History,
		ListChecks,
		LoaderCircle,
		Pencil,
		Plus,
		RefreshCw,
		Send,
		Trash2,
		TriangleAlert,
		Webhook
	} from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import Dialog from '#lib/components/Dialog.svelte';
	import Switch from '#lib/components/Switch.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { ago } from '#lib/client/format.ts';
	import { confirmAction, connections, toast } from '#lib/client/state.svelte.ts';
	import {
		CHANNEL_KINDS,
		CHANNELS,
		RULE_KINDS,
		RULES,
		defaultParams,
		type ActiveAlert,
		type AlertChannel,
		type AlertEvent,
		type AlertRule,
		type AlertRuleKind,
		type AlertSettings,
		type ChannelKind
	} from '#lib/alerts.ts';

	type JobStatus = { name: string; running: boolean; lastStartedAt: string | null; lastFinishedAt: string | null; lastError: string | null };
	type Overview = { active: ActiveAlert[]; events: AlertEvent[]; settings: AlertSettings; jobs: JobStatus[] };

	let tab = $state<'active' | 'rules' | 'channels'>('active');
	let overview = $state<Overview | null>(null);
	let events = $state<AlertEvent[]>([]);
	let moreEvents = $state(false);
	let rules = $state<AlertRule[]>([]);
	let channels = $state<AlertChannel[]>([]);
	let settings = $state<AlertSettings>({ intervalSeconds: 60, renotifyHours: 6, publicUrl: '' });
	let checking = $state(false);
	const PAGE = 100;

	async function loadOverview() {
		const o = await api.get<Overview>(`/api/alerts?limit=${PAGE}`);
		overview = o;
		events = o.events;
		moreEvents = o.events.length === PAGE;
		settings = { ...o.settings, publicUrl: o.settings.publicUrl || '' };
	}

	async function loadAll() {
		try {
			await Promise.all([
				loadOverview(),
				api.get<AlertRule[]>('/api/alerts/rules').then((r) => (rules = r)),
				api.get<AlertChannel[]>('/api/alerts/channels').then((c) => (channels = c))
			]);
		} catch (err) {
			toast('error', 'Could not load alerts', errorMessage(err));
		}
	}

	onMount(() => {
		loadAll();
		const t = setInterval(() => loadOverview().catch(() => {}), 30_000);
		return () => clearInterval(t);
	});

	async function olderEvents() {
		const before = events.at(-1)?.id;
		const o = await api.get<Overview>(`/api/alerts?limit=${PAGE}&before=${before}`);
		events = [...events, ...o.events];
		moreEvents = o.events.length === PAGE;
	}

	async function checkNow() {
		checking = true;
		try {
			await api.post('/api/alerts/run');
			await loadOverview();
			await invalidateAll(); // refresh sidebar badges
			toast('success', 'Checks finished');
		} catch (err) {
			toast('error', 'Checks failed', errorMessage(err));
		} finally {
			checking = false;
		}
	}

	const connName = (id: string | null) => (id ? (connections.list.find((c) => c.id === id)?.name ?? 'removed connection') : 'All connections');
	const alertJob = $derived(overview?.jobs.find((j) => j.name === 'alerts'));
	const sizeJob = $derived(overview?.jobs.find((j) => j.name === 'size-history'));

	// --- settings ----------------------------------------------------------------

	let savingSettings = $state(false);
	async function saveSettings(e: SubmitEvent) {
		e.preventDefault();
		savingSettings = true;
		try {
			settings = await api.put<AlertSettings>('/api/alerts/settings', settings);
			toast('success', 'Alert settings saved');
		} catch (err) {
			toast('error', 'Could not save settings', errorMessage(err));
		} finally {
			savingSettings = false;
		}
	}

	// --- rules -------------------------------------------------------------------

	async function saveRule(r: AlertRule) {
		try {
			const updated = await api.put<AlertRule>(`/api/alerts/rules/${r.id}`, r);
			rules = rules.map((x) => (x.id === r.id ? updated : x));
		} catch (err) {
			toast('error', 'Could not save rule', errorMessage(err));
		}
	}

	async function deleteRule(r: AlertRule) {
		const ok = await confirmAction({ title: `Delete “${RULES[r.kind].label}”?`, body: `Scope: ${connName(r.connectionId)}.`, confirmLabel: 'Delete rule', danger: true });
		if (!ok) return;
		try {
			await api.del(`/api/alerts/rules/${r.id}`);
			rules = rules.filter((x) => x.id !== r.id);
		} catch (err) {
			toast('error', 'Could not delete rule', errorMessage(err));
		}
	}

	let newRule = $state<{ kind: AlertRuleKind; connectionId: string }>({ kind: 'long_query', connectionId: '' });
	async function addRule() {
		try {
			const r = await api.post<AlertRule>('/api/alerts/rules', {
				kind: newRule.kind,
				connectionId: newRule.connectionId || null,
				enabled: true,
				params: defaultParams(newRule.kind),
				notifyResolved: true
			});
			rules = [...rules, r];
		} catch (err) {
			toast('error', 'Could not add rule', errorMessage(err));
		}
	}

	async function addDefaults() {
		try {
			const r = await api.post<{ added: number; rules: AlertRule[] }>('/api/alerts/rules/defaults');
			rules = r.rules;
			toast('success', r.added ? `Added ${r.added} default rules` : 'Every default rule already exists');
		} catch (err) {
			toast('error', 'Could not add default rules', errorMessage(err));
		}
	}

	const missingDefaults = $derived(RULE_KINDS.filter((k) => !rules.some((r) => r.kind === k && r.connectionId === null)));
	const sortedRules = $derived(
		[...rules].sort((a, b) => RULE_KINDS.indexOf(a.kind) - RULE_KINDS.indexOf(b.kind) || Number(a.connectionId !== null) - Number(b.connectionId !== null))
	);

	// --- channels ----------------------------------------------------------------

	type Form = { id: string | null; kind: ChannelKind; name: string; enabled: boolean; config: Record<string, string>; secrets: Record<string, string>; clear: string[] };
	let form = $state<Form | null>(null);
	let dialogOpen = $state(false);
	let saving = $state(false);
	let testing = $state<string | null>(null);
	const editing = $derived(form?.id ? channels.find((c) => c.id === form!.id) : undefined);

	function openChannel(c?: AlertChannel) {
		form = c
			? { id: c.id, kind: c.kind, name: c.name, enabled: c.enabled, config: { ...c.config }, secrets: {}, clear: [] }
			: { id: null, kind: 'ntfy', name: '', enabled: true, config: { server: 'https://ntfy.sh' }, secrets: {}, clear: [] };
		dialogOpen = true;
	}

	const payload = (f: Form) => ({
		id: f.id ?? undefined,
		kind: f.kind,
		name: f.name.trim() || CHANNELS[f.kind].label,
		enabled: f.enabled,
		config: f.config,
		secrets: f.secrets,
		clearSecrets: f.clear
	});

	async function saveChannel(e: SubmitEvent) {
		e.preventDefault();
		if (!form) return;
		saving = true;
		try {
			if (form.id) {
				await api.put(`/api/alerts/channels/${form.id}`, payload(form));
			} else {
				const r = await api.post<{ seededRules: number }>('/api/alerts/channels', payload(form));
				if (r.seededRules) toast('success', 'Channel added', `The ${r.seededRules} default alert rules are now active for every connection.`);
			}
			dialogOpen = false;
			await loadAll();
		} catch (err) {
			toast('error', 'Could not save channel', errorMessage(err));
		} finally {
			saving = false;
		}
	}

	async function test(body: ReturnType<typeof payload>, key: string) {
		testing = key;
		try {
			const r = await api.post<{ ok: boolean; error?: string }>('/api/alerts/channels/test', body);
			if (r.ok) toast('success', 'Test notification sent', 'Check that it arrived.');
			else toast('error', 'Test failed', r.error);
		} catch (err) {
			toast('error', 'Test failed', errorMessage(err));
		} finally {
			testing = null;
		}
	}

	function testSaved(c: AlertChannel) {
		return test({ id: c.id, kind: c.kind, name: c.name, enabled: c.enabled, config: c.config, secrets: {}, clearSecrets: [] }, c.id);
	}

	async function toggleChannel(c: AlertChannel, enabled: boolean) {
		try {
			await api.put(`/api/alerts/channels/${c.id}`, { kind: c.kind, name: c.name, enabled, config: c.config, secrets: {} });
			channels = await api.get<AlertChannel[]>('/api/alerts/channels');
		} catch (err) {
			toast('error', 'Could not update channel', errorMessage(err));
		}
	}

	async function deleteChannel(c: AlertChannel) {
		const ok = await confirmAction({ title: `Delete ${c.name}?`, body: 'Alerts stop going to this channel. Rules and history are kept.', confirmLabel: 'Delete channel', danger: true });
		if (!ok) return;
		try {
			await api.del(`/api/alerts/channels/${c.id}`);
			channels = channels.filter((x) => x.id !== c.id);
		} catch (err) {
			toast('error', 'Could not delete channel', errorMessage(err));
		}
	}

	const EVENT_LABEL = { fired: 'Fired', resolved: 'Resolved', renotified: 'Still firing' };
	const TABS = [
		{ key: 'active', label: 'Active & history', icon: History },
		{ key: 'rules', label: 'Rules', icon: ListChecks },
		{ key: 'channels', label: 'Channels', icon: Webhook }
	] as const;
</script>

<svelte:head><title>Alerts · pg·modern</title></svelte:head>

<div class="h-full overflow-y-auto">
	<PageHeader title="Alerts" description="Checks every database in the background and notifies you when something needs attention.">
		{#snippet actions()}
			<button class="btn btn-secondary" disabled={checking} onclick={checkNow}>
				{#if checking}<LoaderCircle class="animate-spin" />{:else}<RefreshCw />{/if}Check now
			</button>
		{/snippet}
	</PageHeader>

	<div class="space-y-4 px-8 pb-10">
		<div class="flex flex-wrap items-center gap-3">
			<div class="inline-flex rounded-xl border border-border bg-surface p-1">
				{#each TABS as t (t.key)}
					<button
						class="flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] {tab === t.key ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground'}"
						onclick={() => (tab = t.key)}
					>
						<t.icon class="size-3.5" />{t.label}
						{#if t.key === 'active' && overview?.active.length}<span class="rounded-full bg-danger/15 px-1.5 text-[10px] font-semibold text-danger">{overview.active.length}</span>{/if}
					</button>
				{/each}
			</div>
			{#if alertJob}
				<span class="text-[11px] text-muted-foreground">
					Last check {ago(alertJob.lastFinishedAt)}{#if alertJob.lastError} · <span class="text-danger">{alertJob.lastError}</span>{/if}
					{#if sizeJob} · size sample {ago(sizeJob.lastFinishedAt)}{/if}
				</span>
			{/if}
		</div>

		{#if !overview}
			<div class="grid h-40 place-items-center"><LoaderCircle class="size-5 animate-spin text-muted-foreground" /></div>
		{:else if tab === 'active'}
			{#if !channels.length}
				<div class="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/5 p-4 text-[13px]">
					<TriangleAlert class="mt-0.5 size-4 shrink-0 text-warning" />
					<div>
						<p class="font-medium">No notification channel yet</p>
						<p class="mt-0.5 text-muted-foreground">
							Add ntfy, Gotify, Discord, a Slack-compatible or generic webhook, or Apprise under <button class="text-primary hover:underline" onclick={() => (tab = 'channels')}>Channels</button>. The first channel also turns on a sensible set of rules.
						</p>
					</div>
				</div>
			{/if}

			<section class="space-y-2">
				<h2 class="text-[13px] font-semibold">Firing now</h2>
				{#each overview.active as a (a.ruleId + a.connectionId)}
					<div class="card flex items-start gap-3 p-3.5">
						<div class="grid size-8 shrink-0 place-items-center rounded-lg {a.severity === 'critical' ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning'}">
							<BellRing class="size-4" />
						</div>
						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-center gap-2 text-[13px]">
								<span class="font-semibold">{RULES[a.ruleKind].label}</span>
								<span class="badge {a.severity === 'critical' ? 'badge-danger' : 'badge-warning'}">{a.severity}</span>
								<a class="text-muted-foreground hover:text-primary" href="/c/{a.connectionId}">{a.connectionName}</a>
								<span class="ml-auto text-[11px] text-muted-foreground" title={new Date(a.since).toLocaleString()}>since {ago(a.since)}</span>
							</div>
							<p class="mt-1 text-xs break-words text-muted-foreground">{a.message}</p>
						</div>
					</div>
				{:else}
					<div class="card flex items-center gap-2 p-4 text-[13px] text-muted-foreground"><CircleCheck class="size-4 text-success" />All clear — nothing is firing.</div>
				{/each}
			</section>

			<section class="space-y-2">
				<h2 class="text-[13px] font-semibold">History</h2>
				<div class="card overflow-hidden">
					<table class="w-full table-fixed text-left text-[13px]">
						<thead class="border-b border-border bg-surface text-[11px] text-muted-foreground">
							<tr>
								<th class="w-32 px-4 py-2 font-medium">When</th>
								<th class="w-28 px-4 py-2 font-medium">Event</th>
								<th class="w-56 px-4 py-2 font-medium">Alert</th>
								<th class="px-4 py-2 font-medium">Details</th>
								<th class="w-36 px-4 py-2 text-right font-medium">Delivery</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-border">
							{#each events as e (e.id)}
								<tr class="align-top hover:bg-accent/30">
									<td class="px-4 py-2.5 text-xs text-muted-foreground" title={new Date(e.at).toLocaleString()}>{ago(e.at)}</td>
									<td class="px-4 py-2.5 text-xs">
										<span class="badge {e.event === 'resolved' ? 'badge-success' : e.severity === 'critical' ? 'badge-danger' : 'badge-warning'}">{EVENT_LABEL[e.event]}</span>
									</td>
									<td class="px-4 py-2.5 text-xs">
										<p>{RULES[e.ruleKind]?.label ?? e.ruleKind}</p>
										{#if e.connectionName}
											<p class="truncate text-[11px] text-muted-foreground">
												{#if connections.list.some((c) => c.id === e.connectionId)}<a class="hover:text-primary" href="/c/{e.connectionId}">{e.connectionName}</a>{:else}{e.connectionName}{/if}
											</p>
										{/if}
									</td>
									<td class="px-4 py-2.5 text-xs break-words text-muted-foreground">{e.message}</td>
									<td class="px-4 py-2.5 text-right text-[11px] text-muted-foreground">
										{#if e.error}<span class="text-danger" title={e.error}><CircleAlert class="inline size-3" /> {e.delivered} sent, failed</span>
										{:else if e.delivered}<span><CircleCheck class="inline size-3 text-success" /> {e.delivered} sent</span>
										{:else}—{/if}
									</td>
								</tr>
							{:else}
								<tr><td colspan="5" class="px-4 py-10 text-center text-xs text-muted-foreground">No alerts yet.</td></tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if moreEvents}<div class="text-center"><button class="btn btn-secondary btn-sm" onclick={olderEvents}>Load older</button></div>{/if}
			</section>
		{:else if tab === 'rules'}
			<form class="card grid gap-4 p-4 md:grid-cols-[repeat(3,minmax(0,1fr))_auto] md:items-end" onsubmit={saveSettings}>
				<label>
					<span class="label">Check every (seconds)</span>
					<input class="input" type="number" min="30" max="3600" bind:value={settings.intervalSeconds} />
				</label>
				<label>
					<span class="label">Re-notify while firing (hours, 0 = never)</span>
					<input class="input" type="number" min="0" step="0.5" bind:value={settings.renotifyHours} />
				</label>
				<label>
					<span class="label">Public URL, for links in notifications</span>
					<input class="input" placeholder={typeof location === 'undefined' ? '' : location.origin} bind:value={settings.publicUrl} />
				</label>
				<button class="btn btn-primary" disabled={savingSettings}>Save</button>
			</form>

			<div class="card overflow-hidden">
				<table class="w-full text-left text-[13px]">
					<thead class="border-b border-border bg-surface text-[11px] text-muted-foreground">
						<tr>
							<th class="px-4 py-2 font-medium">Rule</th>
							<th class="w-44 px-4 py-2 font-medium">Applies to</th>
							<th class="w-80 px-4 py-2 font-medium">Threshold</th>
							<th class="w-28 px-4 py-2 font-medium" title="Also notify when the alert resolves">Notify resolved</th>
							<th class="w-20 px-4 py-2 font-medium">Enabled</th>
							<th class="w-12 px-2 py-2"></th>
						</tr>
					</thead>
					<tbody class="divide-y divide-border">
						{#each sortedRules as r (r.id)}
							{@const def = RULES[r.kind]}
							<tr class="align-top {r.enabled ? '' : 'opacity-60'}">
								<td class="px-4 py-3">
									<p class="flex items-center gap-2 font-medium">
										{def.label}
										<span class="badge {def.severity === 'critical' ? 'badge-danger' : 'badge-warning'}">{def.severity}</span>
										{#if def.postgresOnly}<span class="badge">Postgres</span>{/if}
									</p>
									<p class="mt-0.5 text-[11px] text-muted-foreground">{def.description}</p>
								</td>
								<td class="px-4 py-3 text-xs">
									{#if r.connectionId}{connName(r.connectionId)}<p class="text-[11px] text-muted-foreground">overrides the global rule</p>{:else}All connections{/if}
								</td>
								<td class="px-4 py-3">
									{#each def.params as p (p.key)}
										<label class="flex items-center gap-2 text-xs">
											<span class="shrink-0 text-muted-foreground">{p.label}</span>
											<input
												class="input h-7 w-20 px-2 text-xs"
												type="number"
												min={p.min}
												max={p.max}
												step="any"
												bind:value={r.params[p.key]}
												onchange={() => saveRule(r)}
											/>
											<span class="whitespace-nowrap text-muted-foreground">{p.unit}</span>
										</label>
									{/each}
								</td>
								<td class="px-4 py-3"><Switch label="Notify when resolved" bind:checked={r.notifyResolved} onchange={() => saveRule(r)} /></td>
								<td class="px-4 py-3"><Switch label="Enabled" bind:checked={r.enabled} onchange={() => saveRule(r)} /></td>
								<td class="px-2 py-2.5"><button class="btn btn-ghost btn-icon btn-sm hover:text-danger" title="Delete rule" onclick={() => deleteRule(r)}><Trash2 /></button></td>
							</tr>
						{:else}
							<tr><td colspan="6" class="px-4 py-10 text-center text-xs text-muted-foreground">No rules yet. Add the defaults, or add a channel and they're added for you.</td></tr>
						{/each}
					</tbody>
				</table>
				<div class="flex flex-wrap items-center gap-2 border-t border-border bg-surface px-4 py-3">
					<select class="input h-8 w-56 text-xs" bind:value={newRule.kind}>
						{#each RULE_KINDS as k (k)}<option value={k}>{RULES[k].label}</option>{/each}
					</select>
					<select class="input h-8 w-56 text-xs" bind:value={newRule.connectionId}>
						<option value="">All connections</option>
						{#each connections.list as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
					</select>
					<button class="btn btn-secondary btn-sm" onclick={addRule}><Plus />Add rule</button>
					{#if missingDefaults.length}
						<button class="btn btn-ghost btn-sm ml-auto" onclick={addDefaults}><ListChecks />Add default rules ({missingDefaults.length})</button>
					{/if}
				</div>
			</div>
			<p class="text-[11px] text-muted-foreground">
				A rule for one connection replaces the all-connections rule of the same kind there; disable it to turn that check off for just that connection.
				Checks run read-only with short timeouts, one session per database.
			</p>
		{:else}
			<div class="flex justify-end"><button class="btn btn-primary" onclick={() => openChannel()}><Plus />Add channel</button></div>
			<div class="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
				{#each channels as c (c.id)}
					<div class="card p-4">
						<div class="flex items-start gap-3">
							<div class="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary"><Send class="size-4" /></div>
							<div class="min-w-0 flex-1">
								<p class="truncate text-[14px] font-semibold">{c.name}</p>
								<p class="text-xs text-muted-foreground">{CHANNELS[c.kind].label}</p>
							</div>
							<Switch label="Enabled" checked={c.enabled} onchange={(v) => toggleChannel(c, v)} />
						</div>
						<dl class="mt-3 space-y-1 text-[11px]">
							{#each CHANNELS[c.kind].fields as f (f.key)}
								{#if f.secret ? c.secrets[f.key] : c.config[f.key]}
									<div class="flex gap-2"><dt class="w-28 shrink-0 text-muted-foreground">{f.label}</dt><dd class="truncate font-mono">{f.secret ? c.secrets[f.key] : c.config[f.key]}</dd></div>
								{/if}
							{/each}
						</dl>
						<p class="mt-3 text-[11px] {c.lastError ? 'text-danger' : 'text-muted-foreground'}">
							{#if c.lastError}Last delivery failed: {c.lastError}{:else if c.lastSentAt}Last sent {ago(c.lastSentAt)}{:else}Nothing sent yet{/if}
						</p>
						<div class="-mx-2 mt-2 flex items-center gap-1">
							<button class="btn btn-ghost btn-sm" disabled={testing === c.id} onclick={() => testSaved(c)}>
								{#if testing === c.id}<LoaderCircle class="animate-spin" />{:else}<Send />{/if}Send test
							</button>
							<button class="btn btn-ghost btn-sm" onclick={() => openChannel(c)}><Pencil />Edit</button>
							<button class="btn btn-ghost btn-sm ml-auto hover:text-danger" onclick={() => deleteChannel(c)}><Trash2 />Delete</button>
						</div>
					</div>
				{:else}
					<div class="card col-span-full px-6 py-12 text-center text-[13px] text-muted-foreground">
						No channels yet. Alerts are still recorded in the history; add a channel to be notified.
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

<Dialog bind:open={dialogOpen} title={form?.id ? 'Edit channel' : 'Add channel'} description={form ? CHANNELS[form.kind].description : ''}>
	{#if form}
		<form id="channel-form" class="space-y-3" onsubmit={saveChannel}>
			{#if !form.id}
				<label class="block">
					<span class="label">Type</span>
					<select class="input" bind:value={form.kind} onchange={() => form && (form.config = form.kind === 'ntfy' ? { server: 'https://ntfy.sh' } : {})}>
						{#each CHANNEL_KINDS as k (k)}<option value={k}>{CHANNELS[k].label}</option>{/each}
					</select>
				</label>
			{/if}
			<label class="block">
				<span class="label">Name</span>
				<input class="input" placeholder={CHANNELS[form.kind].label} bind:value={form.name} />
			</label>
			{#each CHANNELS[form.kind].fields as f (f.key)}
				{@const stored = editing?.secrets[f.key]}
				<label class="block">
					<span class="label">{f.label}{f.required ? '' : ' (optional)'}</span>
					{#if f.secret}
						<input
							class="input font-mono text-xs"
							type="password"
							autocomplete="off"
							placeholder={stored && !form.clear.includes(f.key) ? `Saved (${stored}) — leave blank to keep` : (f.placeholder ?? '')}
							bind:value={form.secrets[f.key]}
						/>
						{#if stored && !f.required}
							<span class="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
								<input
									type="checkbox"
									checked={form.clear.includes(f.key)}
									onchange={(e) => form && (form.clear = e.currentTarget.checked ? [...form.clear, f.key] : form.clear.filter((k) => k !== f.key))}
								/>Remove the saved value
							</span>
						{/if}
					{:else}
						<input class="input" placeholder={f.placeholder ?? ''} bind:value={form.config[f.key]} />
					{/if}
				</label>
			{/each}
			{#if form.kind === 'webhook'}
				<p class="text-[11px] text-muted-foreground">
					POSTs JSON: <code class="font-mono">{'{ source, version, event, severity, status, title, alert, message, rule, connection, value, since, at, url }'}</code> — see the README.
				</p>
			{/if}
			<label class="flex items-center gap-2 text-[13px]"><Switch label="Enabled" bind:checked={form.enabled} />Enabled</label>
		</form>
	{/if}
	{#snippet footer()}
		{#if form}
			<button class="btn btn-ghost mr-auto" type="button" disabled={testing === 'form'} onclick={() => form && test(payload(form), 'form')}>
				{#if testing === 'form'}<LoaderCircle class="animate-spin" />{:else}<Send />{/if}Send test
			</button>
			<button class="btn btn-secondary" type="button" onclick={() => (dialogOpen = false)}>Cancel</button>
			<button class="btn btn-primary" form="channel-form" disabled={saving}>{form.id ? 'Save' : 'Add channel'}</button>
		{/if}
	{/snippet}
</Dialog>
