<script lang="ts">
	import { untrack } from 'svelte';
	import { CircleCheck, FileUp, KeyRound, LoaderCircle, TriangleAlert, Upload } from '@lucide/svelte';
	import Dialog from './Dialog.svelte';
	import { bytes, int } from '#lib/client/format.ts';
	import { toast } from '#lib/client/state.svelte.ts';
	import { columnNameFrom, csvRecords, detectDelimiter, detectHeader, inferType, sqlTypeFor } from '#lib/csv.ts';
	import type { EditInfo, OnConflict } from '#lib/rows.ts';
	import type { Engine } from '#lib/types.ts';

	let {
		open = $bindable(false),
		connectionId,
		engine,
		schema,
		table,
		info,
		ondone
	}: {
		open: boolean;
		connectionId: string;
		engine: Engine;
		schema: string;
		table: string;
		info: EditInfo;
		ondone: (schema: string, table: string, created: boolean) => void;
	} = $props();

	const PREVIEW = 20;
	const INFER_ROWS = 10_000;
	const DELIMS: { value: string; label: string }[] = [
		{ value: ',', label: 'Comma ,' },
		{ value: ';', label: 'Semicolon ;' },
		{ value: '\t', label: 'Tab' },
		{ value: '|', label: 'Pipe |' }
	];

	let file = $state<File | null>(null);
	let text = '';
	let delimiter = $state(',');
	let header = $state(true);
	let emptyAsNull = $state(true);
	let records = $state<string[][]>([]);
	let totalRows = $state<number | null>(null);
	let parseError = $state('');
	let dragging = $state(false);

	let mode = $state<'existing' | 'new'>('existing');
	let mapping = $state<(string | null)[]>([]);
	let onConflict = $state<OnConflict>('error');
	let truncate = $state(false);
	let confirmText = $state('');
	let newName = $state('');
	let newCols = $state<{ include: boolean; name: string; type: string; pk: boolean }[]>([]);

	let uploading = $state(false);
	let progress = $state(0);
	let error = $state('');
	let result = $state<{ rows: number; affected: number; deleted: number; created: boolean; table: string } | null>(null);

	const targets = $derived(info.columns.filter((c) => c.editable));
	const width = $derived(records[0]?.length ?? 0);
	const headers = $derived(header ? (records[0] ?? []) : Array.from({ length: width }, (_, i) => `column ${i + 1}`));
	const sample = $derived((header ? records.slice(1) : records).slice(0, PREVIEW));
	const dataRows = $derived(totalRows === null ? null : Math.max(0, totalRows - (header ? 1 : 0)));

	function reset() {
		file = null;
		text = '';
		records = [];
		totalRows = null;
		parseError = '';
		mapping = [];
		newCols = [];
		error = '';
		result = null;
		truncate = false;
		confirmText = '';
		onConflict = 'error';
		mode = 'existing';
		newName = '';
		progress = 0;
	}

	// Closing after a successful import tells the table (it may open the new table in another tab).
	$effect(() => {
		if (open) return;
		const done = untrack(() => result);
		if (done) ondone(schema, done.table, done.created);
		untrack(reset);
	});

	const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

	async function choose(f: File | undefined | null) {
		if (!f) return;
		reset();
		if (f.size > info.importMaxBytes) {
			error = `${f.name} is ${bytes(f.size)}; the import limit is ${bytes(info.importMaxBytes)}.`;
			return;
		}
		file = f;
		text = await f.text();
		delimiter = detectDelimiter(text);
		parse(true);
	}

	/** Reads the preview (and, in the background, counts rows and infers types). */
	function parse(detect = false) {
		parseError = '';
		const out: string[][] = [];
		try {
			for (const r of csvRecords(text, delimiter)) {
				out.push(r.fields);
				if (out.length > PREVIEW) break;
			}
		} catch (err) {
			parseError = (err as Error).message;
		}
		records = out;
		if (detect) header = detectHeader(out);
		remap();
		totalRows = null;
		const snapshot = { text, delimiter };
		setTimeout(() => analyze(snapshot.text, snapshot.delimiter), 0);
	}

	function remap() {
		const used = new Set<string>();
		mapping = headers.map((h) => {
			const match = header ? targets.find((t) => norm(t.name) === norm(h) && !used.has(t.name)) : undefined;
			if (match) used.add(match.name);
			return match?.name ?? null;
		});
	}

	function analyze(source: string, delim: string) {
		if (source !== text || delim !== delimiter) return;
		const values: string[][] = Array.from({ length: width }, () => []);
		let count = 0;
		try {
			for (const r of csvRecords(source, delim)) {
				count++;
				if (count === 1 && header) continue;
				if (count <= INFER_ROWS) r.fields.forEach((v, i) => values[i]?.push(v));
			}
		} catch (err) {
			parseError = (err as Error).message;
		}
		if (source !== text || delim !== delimiter) return;
		totalRows = count;
		newCols = headers.map((h, i) => {
			const t = inferType(values[i] ?? []);
			const name = columnNameFrom(header ? h : '', i);
			return { include: true, name, type: sqlTypeFor(engine, t), pk: name === 'id' && (t.kind === 'integer' || t.kind === 'bigint' || t.kind === 'uuid') && !t.nullable };
		});
		if (!newName) newName = columnNameFrom((file?.name ?? 'import').replace(/\.[^.]+$/, ''), 0);
	}

	const mappedCount = $derived(mode === 'new' ? newCols.filter((c) => c.include).length : mapping.filter(Boolean).length);
	const duplicate = $derived.by(() => {
		const names = mode === 'new' ? newCols.filter((c) => c.include).map((c) => c.name.trim().toLowerCase()) : (mapping.filter(Boolean) as string[]);
		return names.find((n, i) => names.indexOf(n) !== i) ?? null;
	});
	const targetName = $derived(mode === 'new' ? newName.trim() : table);
	const conflictNeedsKey = $derived(engine !== 'mysql' && !info.key.length);
	const problem = $derived.by(() => {
		if (!file) return 'Choose a file';
		if (parseError) return parseError;
		if (!width) return 'The file is empty';
		if (!mappedCount) return 'Map at least one column';
		if (duplicate) return `“${duplicate}” is used twice`;
		if (mode === 'new') {
			if (!newName.trim()) return 'Name the new table';
			if (newCols.some((c) => c.include && (!c.name.trim() || !c.type.trim()))) return 'Every column needs a name and a type';
		} else if (truncate && confirmText !== table) return `Type ${table} to confirm emptying it`;
		return null;
	});

	function submit() {
		if (!file || problem) return;
		uploading = true;
		error = '';
		progress = 0;
		const options = {
			schema,
			table: targetName,
			delimiter,
			header,
			emptyAsNull,
			onConflict: mode === 'new' ? 'error' : onConflict,
			truncate: mode === 'existing' && truncate,
			confirmTruncate: mode === 'existing' && truncate ? confirmText : undefined,
			mapping: mode === 'new' ? newCols.map((c) => (c.include ? c.name.trim() : null)) : mapping,
			create:
				mode === 'new'
					? {
							columns: newCols.filter((c) => c.include).map((c) => ({ name: c.name.trim(), type: c.type.trim() })),
							primaryKey: newCols.filter((c) => c.include && c.pk).map((c) => c.name.trim())
						}
					: undefined
		};
		// The file is the body; options travel in a header (see the import endpoint).
		const xhr = new XMLHttpRequest();
		xhr.open('POST', `/api/connections/${connectionId}/import`);
		xhr.setRequestHeader('content-type', 'text/csv');
		xhr.setRequestHeader('x-import-options', encodeURIComponent(JSON.stringify(options)));
		xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable) progress = e.loaded / e.total;
		};
		xhr.onload = () => {
			uploading = false;
			let body: Record<string, unknown> = {};
			try {
				body = JSON.parse(xhr.responseText);
			} catch {}
			if (xhr.status >= 200 && xhr.status < 300) {
				result = { rows: Number(body.rows), affected: Number(body.affected), deleted: Number(body.deleted ?? 0), created: !!body.created, table: targetName };
				toast('success', `Imported ${int(result.rows)} rows`, `${schema}.${targetName}`);
			} else if (xhr.status === 413 && !body.message) {
				error = 'The server refused a file this large. Raise BODY_SIZE_LIMIT (the Docker image allows 64 MB) and PGM_IMPORT_MAX_MB.';
			} else error = String(body.message ?? `Import failed (${xhr.status})`);
		};
		xhr.onerror = () => {
			uploading = false;
			error = 'The upload failed (network error).';
		};
		xhr.send(file);
	}
</script>

<Dialog bind:open title="Import CSV" description="Rows are inserted in one transaction: if any row fails, nothing is imported." width="max-w-5xl">
	{#if result}
		<div class="flex flex-col items-center gap-2 py-8 text-center">
			<CircleCheck class="size-8 text-success" />
			<p class="text-[15px] font-semibold">Imported {int(result.rows)} row{result.rows === 1 ? '' : 's'} into {schema}.{result.table}</p>
			<p class="text-xs text-muted-foreground">
				{#if result.created}Created the table. {/if}{#if result.deleted}Deleted {int(result.deleted)} existing rows first. {/if}The database reported {int(result.affected)} affected rows.
			</p>
		</div>
	{:else}
		<div class="space-y-4">
			<label
				class="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed px-4 py-3 text-sm transition-colors {dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'}"
				ondragover={(e) => (e.preventDefault(), (dragging = true))}
				ondragleave={() => (dragging = false)}
				ondrop={(e) => {
					e.preventDefault();
					dragging = false;
					choose(e.dataTransfer?.files[0]);
				}}
			>
				<FileUp class="size-5 text-muted-foreground" />
				{#if file}
					<span class="font-medium">{file.name}</span>
					<span class="text-xs text-muted-foreground">{bytes(file.size)}{#if dataRows !== null} · {int(dataRows)} rows{:else} · counting…{/if}</span>
					<span class="ml-auto text-xs text-primary">Choose another</span>
				{:else}
					<span>Drop a CSV file here or <span class="text-primary">choose one</span></span>
					<span class="ml-auto text-xs text-muted-foreground">up to {bytes(info.importMaxBytes)}</span>
				{/if}
				<input type="file" accept=".csv,.tsv,.txt,text/csv" class="hidden" onchange={(e) => choose(e.currentTarget.files?.[0])} />
			</label>

			{#if file && width}
				<div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
					<label class="flex items-center gap-2">
						<span class="text-muted-foreground">Delimiter</span>
						<select class="input h-7 w-32 py-0 text-xs" bind:value={delimiter} onchange={() => parse()}>
							{#each DELIMS as d (d.value)}<option value={d.value}>{d.label}</option>{/each}
						</select>
					</label>
					<label class="flex items-center gap-1.5"><input type="checkbox" bind:checked={header} onchange={() => parse()} />First row is a header</label>
					<label class="flex items-center gap-1.5"><input type="checkbox" bind:checked={emptyAsNull} />Empty values become NULL</label>
					<div class="ml-auto inline-flex rounded-lg border border-border bg-surface p-0.5">
						<button class="h-7 rounded-md px-3 {mode === 'existing' ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground'}" onclick={() => (mode = 'existing')}>Into {table}</button>
						<button class="h-7 rounded-md px-3 {mode === 'new' ? 'bg-card text-foreground shadow-surface' : 'text-muted-foreground'}" onclick={() => (mode = 'new')}>Into a new table</button>
					</div>
				</div>

				{#if mode === 'new'}
					<label class="flex items-center gap-2 text-xs">
						<span class="text-muted-foreground">New table</span>
						<span class="font-mono text-muted-foreground">{schema}.</span>
						<input class="input h-7 w-64 font-mono text-xs" bind:value={newName} />
						{#if dataRows === null}<span class="flex items-center gap-1 text-muted-foreground"><LoaderCircle class="size-3 animate-spin" />Inferring types…</span>{/if}
					</label>
				{/if}

				<div class="overflow-x-auto rounded-lg border border-border">
					<table class="w-full font-mono text-[11px]">
						<thead class="bg-surface">
							<tr class="border-b border-border text-left">
								{#each headers as h, i (i)}
									<th class="min-w-36 px-2 py-1.5 align-top font-normal">
										<div class="truncate font-sans text-[12px] font-semibold" title={h}>{h}</div>
										{#if mode === 'existing'}
											<select class="input mt-1 h-7 py-0 font-mono text-[11px] {mapping[i] ? '' : 'text-muted-foreground'}" bind:value={mapping[i]}>
												<option value={null}>— ignore —</option>
												{#each targets as t (t.name)}<option value={t.name}>{t.name}</option>{/each}
											</select>
										{:else if newCols[i]}
											<div class="mt-1 space-y-1">
												<input class="input h-7 font-mono text-[11px] {newCols[i].include ? '' : 'opacity-50'}" bind:value={newCols[i].name} disabled={!newCols[i].include} />
												<input class="input h-7 font-mono text-[11px] {newCols[i].include ? '' : 'opacity-50'}" bind:value={newCols[i].type} disabled={!newCols[i].include} />
												<div class="flex items-center gap-2 font-sans text-[11px] text-muted-foreground">
													<label class="flex items-center gap-1"><input type="checkbox" bind:checked={newCols[i].include} />Import</label>
													<label class="flex items-center gap-1"><input type="checkbox" bind:checked={newCols[i].pk} disabled={!newCols[i].include} /><KeyRound class="size-3" />Key</label>
												</div>
											</div>
										{/if}
									</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each sample as row, r (r)}
								<tr class="border-b border-border/50 last:border-0">
									{#each headers as _, c (c)}
										{@const v = row[c]}
										<td class="max-w-56 truncate px-2 py-1 {(mode === 'existing' ? mapping[c] : newCols[c]?.include) ? '' : 'text-muted-foreground/50'}" title={v}>
											{#if v === undefined}<span class="text-danger">missing</span>{:else if v === '' && emptyAsNull}<span class="text-muted-foreground/60 italic">NULL</span>{:else}{v}{/if}
										</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="text-[11px] text-muted-foreground">Showing the first {Math.min(PREVIEW, sample.length)} rows.</p>

				{#if mode === 'existing'}
					<div class="flex flex-wrap items-start gap-x-6 gap-y-3 text-xs">
						<label class="flex items-center gap-2">
							<span class="text-muted-foreground">When a row already exists</span>
							<select class="input h-7 w-44 py-0 text-xs" bind:value={onConflict}>
								<option value="error">Stop with an error</option>
								<option value="skip">Skip it</option>
								<option value="update" disabled={conflictNeedsKey}>Update it{conflictNeedsKey ? ' (needs a key)' : ''}</option>
							</select>
						</label>
						<div class="space-y-1.5">
							<label class="flex items-center gap-1.5"><input type="checkbox" bind:checked={truncate} />Delete all existing rows first</label>
							{#if truncate}
								<div class="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-1.5 text-danger">
									<TriangleAlert class="size-3.5" />
									<span>Type <span class="font-mono font-semibold">{table}</span> to confirm</span>
									<input class="input h-6 w-40 font-mono text-xs" bind:value={confirmText} />
								</div>
							{/if}
						</div>
					</div>
				{/if}
			{/if}

			{#if error}
				<div class="rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs text-danger">{error}</div>
			{/if}
		</div>
	{/if}
	{#snippet footer()}
		{#if result}
			<button class="btn btn-primary" onclick={() => (open = false)}>Done</button>
		{:else}
			{#if uploading}
				<div class="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
					<div class="h-1.5 w-40 overflow-hidden rounded-full bg-muted"><div class="h-full bg-primary transition-all" style="width:{Math.round(progress * 100)}%"></div></div>
					{progress < 1 ? `Uploading ${Math.round(progress * 100)}%` : 'Importing…'}
				</div>
			{:else if problem && file}
				<span class="mr-auto text-xs text-muted-foreground">{problem}</span>
			{/if}
			<button class="btn btn-ghost" onclick={() => (open = false)}>Cancel</button>
			<button class="btn btn-primary" disabled={!!problem || uploading} onclick={submit}>
				{#if uploading}<LoaderCircle class="animate-spin" />{:else}<Upload />{/if}Import{#if dataRows !== null}&nbsp;{int(dataRows)} rows{/if}
			</button>
		{/if}
	{/snippet}
</Dialog>
