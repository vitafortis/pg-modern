<script lang="ts">
	import { onMount } from 'svelte';
	import { Database, ShieldAlert } from '@lucide/svelte';
	import Switch from './Switch.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { toast } from '#lib/client/state.svelte.ts';

	type View = { sqliteArchive: boolean; sqliteSnapshotMaxMb: number };
	let view = $state<View | null>(null);
	let maxMb = $state(512);

	onMount(async () => {
		view = await api.get<View>('/api/settings/sqlite');
		maxMb = view.sqliteSnapshotMaxMb;
	});

	async function save(patch: Partial<View>, message: string) {
		try {
			view = await api.put<View>('/api/settings/sqlite', patch);
			maxMb = view.sqliteSnapshotMaxMb;
			toast('success', message);
		} catch (err) {
			toast('error', 'Could not save', errorMessage(err));
		}
	}
</script>

<section id="sqlite" class="card scroll-mt-6 p-5">
	<div class="flex items-start gap-4">
		<div class="min-w-0 flex-1">
			<h2 class="flex items-center gap-2 text-[14px] font-semibold"><Database class="size-4 text-primary" />SQLite in containers</h2>
			<p class="mt-1 text-xs text-muted-foreground">
				SQLite files in scan folders, and in container bind mounts that pg·modern can also see, are always found and opened in place. Turn this on to
				also find databases inside container volumes pg·modern can’t see, and browse read-only snapshots of them.
			</p>
		</div>
		{#if view}
			<label class="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
				<Switch
					label="Read SQLite files from containers via the Docker API"
					checked={view.sqliteArchive}
					onchange={(v) => save({ sqliteArchive: v }, v ? 'Reading SQLite from containers is on' : 'Reading SQLite from containers is off')}
				/>
				Read SQLite files from containers via the Docker API
			</label>
		{/if}
	</div>

	<div class="mt-4 grid gap-4 lg:grid-cols-[1fr_16rem]">
		<div class="rounded-lg border border-warning/30 bg-warning/5 p-3 text-[11px] text-muted-foreground">
			<p class="flex items-center gap-1.5 font-medium text-foreground"><ShieldAlert class="size-3.5 text-warning" />What this allows</p>
			<ul class="mt-1.5 list-disc space-y-1 pl-4">
				<li>
					pg·modern reads files inside your containers with <code class="font-mono">GET/HEAD /containers/&#123;id&#125;/archive</code>. The read-only
					docker-socket-proxy (<code class="font-mono">CONTAINERS=1</code>, <code class="font-mono">POST=0</code>; linuxserver’s also needs <code class="font-mono">ALLOW_ARCHIVE=1</code>) allows this — so any file in any
					container (secrets, keys, .env files) is readable by whoever controls pg·modern. Nothing can be written into a container.
				</li>
				<li>Discovery stats known app paths and lists each non-media mount (stopping after 64 MB per mount).</li>
				<li>
					Imported databases are copied into pg·modern’s data folder (with their <code class="font-mono">-wal</code>, merged into the copy) and are always
					read-only. Copying a live database isn’t a transactional backup; including the -wal makes it consistent in practice.
				</li>
			</ul>
		</div>
		{#if view}
			<form
				class="self-start"
				onsubmit={(e) => {
					e.preventDefault();
					save({ sqliteSnapshotMaxMb: Number(maxMb) }, 'Snapshot limit saved');
				}}
			>
				<label class="label" for="sqlite-max">Largest snapshot (MB)</label>
				<div class="flex gap-2">
					<input id="sqlite-max" class="input h-8 font-mono text-xs" type="number" min="1" max="65536" bind:value={maxMb} />
					<button class="btn btn-secondary" disabled={Number(maxMb) === view.sqliteSnapshotMaxMb}>Save</button>
				</div>
				<p class="mt-1 text-[11px] text-muted-foreground">Database plus its -wal. Larger ones are listed but can’t be imported.</p>
			</form>
		{/if}
	</div>
</section>
