<script lang="ts">
	import { CalendarClock, LoaderCircle, Pencil, Play, Plus, Trash2 } from '@lucide/svelte';
	import Dialog from '#lib/components/Dialog.svelte';
	import Switch from '#lib/components/Switch.svelte';
	import type { BackupsData } from './types.ts';
	import { describeRetention, describeTiming, WEEKDAYS, type BackupSchedule, type Frequency } from '#lib/backups.ts';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { ago } from '#lib/client/format.ts';
	import { confirmAction, connections, toast } from '#lib/client/state.svelte.ts';

	let { data, reload, goto }: { data: BackupsData; reload: () => Promise<void>; goto: (t: 'runs' | 'destinations') => void } = $props();

	const backupable = $derived(connections.list.filter((c) => c.engine === 'postgres' || c.engine === 'mysql'));
	const connName = (id: string | null) => (id ? (connections.list.find((c) => c.id === id)?.name ?? 'removed connection') : 'All connections');
	const destName = (id: string) => data.destinations.find((d) => d.id === id)?.name ?? '—';

	type Form = {
		id: string | null;
		name: string;
		connectionId: string;
		destinationId: string;
		frequency: Frequency;
		time: string;
		minute: number;
		weekday: number;
		keepLast: string;
		keepDays: string;
		compress: boolean;
		enabled: boolean;
	};
	let open = $state(false);
	let saving = $state(false);
	let form = $state<Form>(blank());
	let running = $state<string | null>(null);

	function blank(): Form {
		return {
			id: null,
			name: 'Nightly',
			connectionId: '',
			destinationId: data.destinations[0]?.id ?? '',
			frequency: 'daily',
			time: '03:00',
			minute: 0,
			weekday: 0,
			keepLast: '7',
			keepDays: '',
			compress: true,
			enabled: true
		};
	}

	const pad = (n: number) => String(n).padStart(2, '0');

	function edit(s: BackupSchedule | null) {
		form = s
			? {
					id: s.id,
					name: s.name,
					connectionId: s.connectionId ?? '',
					destinationId: s.destinationId,
					frequency: s.frequency,
					time: `${pad(s.hour)}:${pad(s.minute)}`,
					minute: s.minute,
					weekday: s.weekday,
					keepLast: s.keepLast ? String(s.keepLast) : '',
					keepDays: s.keepDays ? String(s.keepDays) : '',
					compress: s.compress,
					enabled: s.enabled
				}
			: blank();
		open = true;
	}

	function payload(f: Form) {
		const [h, m] = f.time.split(':').map(Number);
		return {
			name: f.name,
			connectionId: f.connectionId || null,
			destinationId: f.destinationId,
			frequency: f.frequency,
			hour: f.frequency === 'hourly' ? 0 : h || 0,
			minute: f.frequency === 'hourly' ? Number(f.minute) || 0 : m || 0,
			weekday: Number(f.weekday),
			keepLast: f.keepLast ? Number(f.keepLast) : null,
			keepDays: f.keepDays ? Number(f.keepDays) : null,
			compress: f.compress,
			enabled: f.enabled
		};
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		saving = true;
		try {
			if (form.id) await api.put(`/api/backups/schedules/${form.id}`, payload(form));
			else await api.post('/api/backups/schedules', payload(form));
			open = false;
			await reload();
		} catch (err) {
			toast('error', 'Could not save the schedule', errorMessage(err));
		} finally {
			saving = false;
		}
	}

	async function toggle(s: BackupSchedule, enabled: boolean) {
		try {
			await api.put(`/api/backups/schedules/${s.id}`, { ...s, enabled });
			await reload();
		} catch (err) {
			toast('error', 'Could not update the schedule', errorMessage(err));
		}
	}

	async function runNow(s: BackupSchedule) {
		running = s.id;
		try {
			const runs = await api.post<unknown[]>(`/api/backups/schedules/${s.id}/run`);
			toast('success', `Started ${runs.length} backup${runs.length === 1 ? '' : 's'}`);
			await reload();
			goto('runs');
		} catch (err) {
			toast('error', 'Could not start the backup', errorMessage(err));
		} finally {
			running = null;
		}
	}

	async function remove(s: BackupSchedule) {
		const ok = await confirmAction({ title: `Delete “${s.name}”?`, body: 'Backups it already made are kept.', confirmLabel: 'Delete', danger: true });
		if (!ok) return;
		try {
			await api.del(`/api/backups/schedules/${s.id}`);
			await reload();
		} catch (err) {
			toast('error', 'Could not delete the schedule', errorMessage(err));
		}
	}

	const lastRun = (s: BackupSchedule) => data.runs.find((r) => r.scheduleId === s.id && r.kind === 'backup');
</script>

<div class="flex items-center justify-end">
	<button class="btn btn-primary" onclick={() => edit(null)} disabled={!data.destinations.length}><Plus />New schedule</button>
</div>

{#if !data.destinations.length}
	<div class="card px-6 py-12 text-center">
		<p class="text-sm font-medium">Add a destination first</p>
		<p class="mt-1 text-[13px] text-muted-foreground">Schedules write to a folder, an SFTP server or an S3 bucket.</p>
		<button class="btn btn-primary mt-4" onclick={() => goto('destinations')}>Add a destination</button>
	</div>
{:else if !data.schedules.length}
	<div class="card px-6 py-12 text-center">
		<div class="mx-auto grid size-10 place-items-center rounded-xl bg-primary-soft text-primary"><CalendarClock class="size-5" /></div>
		<p class="mt-3 text-sm font-medium">No schedules yet</p>
		<p class="mt-1 text-[13px] text-muted-foreground">Back up one connection or all of them hourly, daily or weekly, and keep the last few.</p>
	</div>
{:else}
	<div class="card divide-y divide-border">
		{#each data.schedules as s (s.id)}
			{@const last = lastRun(s)}
			<div class="flex flex-wrap items-center gap-4 px-4 py-3">
				<Switch checked={s.enabled} label="Enabled" onchange={(v) => toggle(s, v)} />
				<div class="min-w-0 flex-1">
					<p class="truncate text-[13px] font-medium">{s.name} <span class="font-normal text-muted-foreground">· {connName(s.connectionId)} → {destName(s.destinationId)}</span></p>
					<p class="mt-0.5 text-xs text-muted-foreground">
						{describeTiming(s)} · {describeRetention(s)}{s.compress ? '' : ' · uncompressed'}
					</p>
				</div>
				<div class="text-right text-xs text-muted-foreground">
					<p>
						{#if s.enabled && s.nextRunAt}Next {new Date(s.nextRunAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}{:else}Paused{/if}
					</p>
					<p class="mt-0.5">
						Last {ago(s.lastRunAt)}
						{#if last}<span class="ml-1 badge {last.status === 'failed' ? 'badge-danger' : last.status === 'running' ? 'badge-primary' : 'badge-success'}">{last.status}</span>{/if}
					</p>
				</div>
				<div class="flex items-center">
					<button class="btn btn-secondary btn-sm" onclick={() => runNow(s)} disabled={running === s.id}>
						{#if running === s.id}<LoaderCircle class="animate-spin" />{:else}<Play />{/if}Run now
					</button>
					<button class="btn btn-ghost btn-icon btn-sm" title="Edit" onclick={() => edit(s)}><Pencil /></button>
					<button class="btn btn-ghost btn-icon btn-sm hover:text-danger" title="Delete" onclick={() => remove(s)}><Trash2 /></button>
				</div>
			</div>
		{/each}
	</div>
{/if}

<Dialog bind:open title={form.id ? 'Edit schedule' : 'New schedule'} description="Times are in the server's time zone ({data.timeZone}).">
	<form id="schedule" class="space-y-3" onsubmit={save}>
		<div class="grid grid-cols-2 gap-3">
			<div>
				<label class="label" for="s-name">Name</label>
				<input id="s-name" class="input" required bind:value={form.name} />
			</div>
			<div>
				<label class="label" for="s-conn">Connection</label>
				<select id="s-conn" class="input" bind:value={form.connectionId}>
					<option value="">All connections</option>
					{#each backupable as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
				</select>
			</div>
		</div>
		<div>
			<label class="label" for="s-dest">Destination</label>
			<select id="s-dest" class="input" required bind:value={form.destinationId}>
				{#each data.destinations as d (d.id)}<option value={d.id}>{d.name} — {d.where}</option>{/each}
			</select>
		</div>
		<div class="grid grid-cols-3 gap-3">
			<div>
				<label class="label" for="s-freq">Every</label>
				<select id="s-freq" class="input" bind:value={form.frequency}>
					<option value="hourly">Hour</option>
					<option value="daily">Day</option>
					<option value="weekly">Week</option>
				</select>
			</div>
			{#if form.frequency === 'hourly'}
				<div>
					<label class="label" for="s-min">At minute</label>
					<input id="s-min" class="input" type="number" min="0" max="59" required bind:value={form.minute} />
				</div>
			{:else}
				{#if form.frequency === 'weekly'}
					<div>
						<label class="label" for="s-day">On</label>
						<select id="s-day" class="input" bind:value={form.weekday}>
							{#each WEEKDAYS as d, i (d)}<option value={i}>{d}</option>{/each}
						</select>
					</div>
				{/if}
				<div>
					<label class="label" for="s-time">At</label>
					<input id="s-time" class="input" type="time" required bind:value={form.time} />
				</div>
			{/if}
		</div>
		<div class="grid grid-cols-2 gap-3">
			<div>
				<label class="label" for="s-keep">Keep the last</label>
				<div class="relative">
					<input id="s-keep" class="input pr-16" type="number" min="1" placeholder="all" bind:value={form.keepLast} />
					<span class="pointer-events-none absolute top-2.5 right-3 text-xs text-muted-foreground">backups</span>
				</div>
			</div>
			<div>
				<label class="label" for="s-days">and/or keep</label>
				<div class="relative">
					<input id="s-days" class="input pr-12" type="number" min="1" placeholder="—" bind:value={form.keepDays} />
					<span class="pointer-events-none absolute top-2.5 right-3 text-xs text-muted-foreground">days</span>
				</div>
			</div>
		</div>
		<p class="text-xs text-muted-foreground">
			After each successful backup, older ones of the same connection from this schedule are deleted unless either rule keeps them.
			The newest backup is always kept. Leave both empty to keep everything.
		</p>
		<div class="flex items-center justify-between gap-3 border-t border-border pt-3">
			<div>
				<p class="text-[13px]">Compress</p>
				<p class="text-xs text-muted-foreground">gzip for MySQL/MariaDB; Postgres custom-format dumps are compressed by pg_dump.</p>
			</div>
			<Switch bind:checked={form.compress} label="Compress" />
		</div>
		<div class="flex items-center justify-between gap-3">
			<p class="text-[13px]">Enabled</p>
			<Switch bind:checked={form.enabled} label="Enabled" />
		</div>
	</form>
	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (open = false)}>Cancel</button>
		<button class="btn btn-primary" form="schedule" disabled={saving}>{#if saving}<LoaderCircle class="animate-spin" />{/if}{form.id ? 'Save' : 'Create schedule'}</button>
	{/snippet}
</Dialog>
