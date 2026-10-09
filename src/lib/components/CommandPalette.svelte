<script lang="ts">
	import type { Component } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import {
		Activity,
		Bookmark,
		Camera,
		Database,
		Eye,
		Gauge,
		History,
		LayoutDashboard,
		Layers,
		Lock,
		LogOut,
		Moon,
		Network,
		PanelLeft,
		Plug,
		Plus,
		Radar,
		ScrollText,
		Search,
		Settings,
		SquareTerminal,
		Sun,
		Table2,
		UserRound,
		Users
	} from '@lucide/svelte';
	import { fuzzyRank } from '#lib/fuzzy.ts';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { connections, editor, isAdmin, refreshConnections, setTheme, theme, toast } from '#lib/client/state.svelte.ts';
	import {
		inWorkspace,
		isPaletteShortcut,
		loadObjects,
		loadRecents,
		loadSavedQueries,
		noteRecent,
		objects,
		palette,
		recents,
		savedCache
	} from '#lib/client/palette.svelte.ts';

	let { ontogglesidebar, signedIn = true }: { ontogglesidebar: () => void; signedIn?: boolean } = $props();

	type Item = {
		key: string;
		group: 'Actions' | 'Connections' | 'Pages' | 'Tables & views' | 'Saved queries';
		title: string;
		subtitle?: string;
		icon: Component;
		/** Extra text to match on, not shown. */
		keywords?: string;
		run: () => void | Promise<void>;
	};

	let dialog = $state<HTMLDialogElement>();
	let input = $state<HTMLInputElement>();
	let list = $state<HTMLElement>();
	let query = $state('');
	let active = $state(0);

	const ws = $derived(palette.workspace);
	const current = $derived(ws ? connections.list.find((c) => c.id === ws.connectionId) : undefined);
	const connName = (id: string) => connections.list.find((c) => c.id === id)?.name ?? 'connection';
	/** Connections whose tables are listed: the open one plus a few recent ones. */
	const objectConnections = $derived(
		[...new Set([...(ws ? [ws.connectionId] : []), ...recents.connections])].filter((id) => connections.list.some((c) => c.id === id)).slice(0, 4)
	);

	function show() {
		loadRecents();
		query = '';
		active = 0;
		palette.open = true;
		for (const id of objectConnections) loadObjects(id);
		loadSavedQueries();
	}

	$effect(() => {
		if (palette.open && dialog && !dialog.open) {
			dialog.showModal();
			queueMicrotask(() => input?.focus());
		} else if (!palette.open && dialog?.open) dialog.close();
	});

	function onwindowkey(e: KeyboardEvent) {
		if (!signedIn || !isPaletteShortcut(e)) return;
		e.preventDefault();
		if (palette.open) palette.open = false;
		else show();
	}

	async function lockWrites(id: string) {
		try {
			await api.del(`/api/connections/${id}/unlock`);
			await refreshConnections();
			toast('success', 'Writes locked', connName(id));
		} catch (err) {
			toast('error', 'Could not lock writes', errorMessage(err));
		}
	}

	async function signOut() {
		await api.post('/api/auth/logout').catch(() => {});
		goto('/login');
	}

	const items = $derived.by((): Item[] => {
		const out: Item[] = [];
		// Workspace actions first: ⌘K then ↵ opens a new query tab.
		if (ws && current) {
			out.push(
				{ key: `act:new-query`, group: 'Actions', title: 'New query', subtitle: current.name, icon: SquareTerminal, keywords: 'sql editor tab', run: () => ws.newQuery() },
				{ key: `act:schema-history`, group: 'Actions', title: 'Schema history', subtitle: current.name, icon: History, keywords: 'snapshots diff compare', run: () => ws.openTab('schema') },
				{ key: `act:snapshot`, group: 'Actions', title: 'Snapshot schema', subtitle: current.name, icon: Camera, keywords: 'schema snapshot', run: () => ws.snapshot() },
				{ key: `act:diagram`, group: 'Actions', title: 'Schema diagram', subtitle: current.name, icon: Network, keywords: 'er erd', run: () => ws.openTab('diagram') },
				{ key: `act:activity`, group: 'Actions', title: 'Activity', subtitle: current.name, icon: Activity, keywords: 'sessions locks', run: () => ws.openTab('activity') },
				{ key: `act:server`, group: 'Actions', title: 'Server overview', subtitle: current.name, icon: Gauge, run: () => ws.openTab('overview') }
			);
		}
		if (isAdmin()) out.push({ key: 'act:new-connection', group: 'Actions', title: 'New connection', icon: Plus, keywords: 'add database', run: () => void (editor.target = 'new') });
		out.push(
			{ key: 'act:theme', group: 'Actions', title: theme.value === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', icon: theme.value === 'dark' ? Sun : Moon, keywords: 'toggle theme dark light', run: () => setTheme(theme.value === 'dark' ? 'light' : 'dark') },
			{ key: 'act:sidebar', group: 'Actions', title: 'Toggle sidebar', subtitle: '⌘B', icon: PanelLeft, keywords: 'collapse expand', run: ontogglesidebar }
		);
		for (const c of connections.list) {
			if (c.access?.unlockedUntil) {
				out.push({ key: `act:lock:${c.id}`, group: 'Actions', title: 'Lock writes', subtitle: c.name, icon: Lock, keywords: 'read-only relock', run: () => lockWrites(c.id) });
			}
		}
		out.push({ key: 'act:sign-out', group: 'Actions', title: 'Sign out', icon: LogOut, keywords: 'logout log out', run: signOut });

		for (const c of connections.list) {
			out.push({
				key: `conn:${c.id}`,
				group: 'Connections',
				title: c.name,
				subtitle: `${c.engine === 'mysql' ? (c.flavor === 'mariadb' ? 'MariaDB' : 'MySQL') : c.engine === 'postgres' ? 'Postgres' : c.engine} · ${c.database || c.host}`,
				icon: Database,
				keywords: `${c.host} ${c.database}`,
				run: () => goto(`/c/${c.id}`)
			});
		}

		const pages: [string, string, Component, boolean][] = [
			['/', 'Overview', LayoutDashboard, true],
			['/discover', 'Discover', Radar, isAdmin()],
			['/integrations', 'Integrations', Plug, isAdmin()],
			['/users', 'Users', Users, isAdmin()],
			['/audit', 'Audit log', ScrollText, isAdmin()],
			['/settings', 'Settings', Settings, isAdmin()],
			['/account', 'My account', UserRound, true]
		];
		for (const [href, title, icon, ok] of pages) if (ok) out.push({ key: `page:${href}`, group: 'Pages', title, icon, run: () => goto(href) });

		for (const id of objectConnections) {
			const name = connName(id);
			for (const o of objects[id]?.items ?? []) {
				out.push({
					key: `table:${id}:${o.schema}.${o.name}`,
					group: 'Tables & views',
					title: o.name,
					subtitle: `${o.schema} · ${name}`,
					icon: o.kind === 'view' ? Eye : o.kind === 'matview' ? Layers : Table2,
					run: () => inWorkspace(id, (w) => w.openTable(o.schema, o.name, o.kind))
				});
			}
		}

		for (const q of savedCache.list) {
			const target = q.connectionId ?? ws?.connectionId ?? recents.connections.find((id) => connections.list.some((c) => c.id === id)) ?? connections.list[0]?.id;
			if (!target) continue;
			out.push({
				key: `saved:${q.id}`,
				group: 'Saved queries',
				title: q.name,
				subtitle: q.connectionId ? connName(q.connectionId) : 'any connection',
				icon: Bookmark,
				keywords: `${q.description ?? ''} ${q.sql.slice(0, 200)}`,
				run: () => inWorkspace(target, (w) => w.newQuery(q.sql, { id: q.id, name: q.name }))
			});
		}
		return out;
	});

	const GROUP_ORDER: Item['group'][] = ['Actions', 'Connections', 'Pages', 'Tables & views', 'Saved queries'];

	type Row = { item: Item; indexes: number[]; recent?: boolean };
	const results = $derived.by((): Row[] => {
		const q = query.trim();
		const recentRank = new Map(recents.items.map((k, i) => [k, i]));
		if (!q) {
			const byKey = new Map(items.map((i) => [i.key, i]));
			const pinned = ws ? items.filter((i) => i.key === 'act:new-query') : [];
			const recent = recents.items
				.map((k) => byKey.get(k))
				.filter((i): i is Item => !!i && !pinned.includes(i))
				.slice(0, 6);
			const seen = new Set([...pinned, ...recent].map((i) => i.key));
			// Without a query: recent items, then actions, connections and pages (tables only when searched).
			const rest = items.filter((i) => !seen.has(i.key) && i.group !== 'Tables & views' && i.group !== 'Saved queries');
			return [...pinned.map((item) => ({ item, indexes: [] })), ...recent.map((item) => ({ item, indexes: [], recent: true })), ...rest.map((item) => ({ item, indexes: [] }))];
		}
		return fuzzyRank(q, items, (i) => [i.title, `${i.subtitle ?? ''} ${i.keywords ?? ''}`], (i) => {
			const r = recentRank.get(i.key);
			// Recently used items float up; tables rank slightly below exact navigation targets.
			return (r === undefined ? 0 : 120 - r * 3) + (i.group === 'Tables & views' ? -10 : 0);
		})
			.slice(0, 60)
			.map(({ item, indexes }) => ({ item, indexes, recent: recentRank.has(item.key) }));
	});

	/** Results with group headers: by group when not searching, a single ranked list when searching. */
	const sections = $derived.by(() => {
		if (query.trim()) return [{ title: null as string | null, rows: results.map((r, i) => ({ ...r, index: i })) }];
		const out: { title: string | null; rows: (Row & { index: number })[] }[] = [];
		results.forEach((r, i) => {
			const title = r.recent ? 'Recent' : r.item.key === 'act:new-query' ? null : r.item.group;
			const last = out[out.length - 1];
			if (last && last.title === title) last.rows.push({ ...r, index: i });
			else out.push({ title, rows: [{ ...r, index: i }] });
		});
		return out;
	});

	$effect(() => {
		void query;
		active = 0;
	});

	$effect(() => {
		void active;
		list?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
	});

	function choose(row: Row | undefined) {
		if (!row) return;
		palette.open = false;
		noteRecent(row.item.key);
		void row.item.run();
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
			e.preventDefault();
			active = Math.min(active + 1, results.length - 1);
		} else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
			e.preventDefault();
			active = Math.max(active - 1, 0);
		} else if (e.key === 'PageDown') {
			e.preventDefault();
			active = Math.min(active + 8, results.length - 1);
		} else if (e.key === 'PageUp') {
			e.preventDefault();
			active = Math.max(active - 8, 0);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			choose(results[active]);
		}
	}

	function highlight(text: string, indexes: number[]): { text: string; hit: boolean }[] {
		if (!indexes.length) return [{ text, hit: false }];
		const set = new Set(indexes);
		const out: { text: string; hit: boolean }[] = [];
		for (let i = 0; i < text.length; i++) {
			const hit = set.has(i);
			const last = out[out.length - 1];
			if (last && last.hit === hit) last.text += text[i];
			else out.push({ text: text[i], hit });
		}
		return out;
	}

	// Close when navigating away (e.g. browser back).
	$effect(() => {
		void page.url.pathname;
		palette.open = false;
	});
</script>

<svelte:window onkeydown={onwindowkey} />

<dialog
	bind:this={dialog}
	onclose={() => (palette.open = false)}
	onclick={(e) => e.target === dialog && (palette.open = false)}
	aria-label="Command palette"
	class="mx-auto mt-[12vh] w-[calc(100%-2rem)] max-w-xl overflow-hidden rounded-2xl border border-border bg-card p-0 text-card-foreground shadow-surface-lg backdrop:bg-black/40 backdrop:backdrop-blur-[2px] open:animate-[pop_.12s_ease-out]"
>
	{#if palette.open}
		<div class="flex items-center gap-2.5 border-b border-border px-4">
			<Search class="size-4 shrink-0 text-muted-foreground" />
			<input
				bind:this={input}
				bind:value={query}
				{onkeydown}
				class="h-12 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground/70"
				placeholder={ws ? 'Search tables, connections, pages and actions…' : 'Search connections, pages and actions…'}
				role="combobox"
				aria-expanded="true"
				aria-controls="palette-list"
				aria-activedescendant={results.length ? `palette-${active}` : undefined}
				autocomplete="off"
				spellcheck="false"
			/>
			<span class="kbd">esc</span>
		</div>
		<div bind:this={list} id="palette-list" role="listbox" class="max-h-[min(26rem,60vh)] overflow-y-auto p-1.5">
			{#each sections as s, si (si)}
				{#if s.title}<p class="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{s.title}</p>{/if}
				{#each s.rows as r (r.item.key)}
					{@const Icon = r.item.icon}
					<button
						id="palette-{r.index}"
						data-index={r.index}
						role="option"
						aria-selected={r.index === active}
						class="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left {r.index === active ? 'bg-accent text-foreground' : 'text-foreground/90'}"
						onmousemove={() => (active = r.index)}
						onclick={() => choose(r)}
					>
						<Icon class="size-4 shrink-0 {r.index === active ? 'text-primary' : 'text-muted-foreground'}" />
						<span class="min-w-0 flex-1 truncate text-[13px]">
							{#each highlight(r.item.title, r.indexes) as part, pi (pi)}{#if part.hit}<mark class="bg-transparent font-semibold text-primary">{part.text}</mark>{:else}{part.text}{/if}{/each}
						</span>
						{#if r.item.subtitle}<span class="max-w-[45%] shrink-0 truncate text-[11px] text-muted-foreground">{r.item.subtitle}</span>{/if}
						{#if query.trim()}<span class="w-24 shrink-0 text-right text-[10px] text-muted-foreground/70">{r.item.group}</span>{/if}
					</button>
				{/each}
			{:else}
				<p class="px-3 py-8 text-center text-xs text-muted-foreground">Nothing matches “{query}”.</p>
			{/each}
		</div>
		<div class="flex items-center gap-3 border-t border-border bg-surface px-3 py-2 text-[11px] text-muted-foreground">
			<span class="flex items-center gap-1"><span class="kbd">↑</span><span class="kbd">↓</span>navigate</span>
			<span class="flex items-center gap-1"><span class="kbd">↵</span>open</span>
			{#if ws && !objects[ws.connectionId]}<span class="ml-auto">Loading tables…</span>{:else if objectConnections.length}<span class="ml-auto truncate">Tables from {objectConnections.map(connName).join(', ')}</span>{/if}
		</div>
	{/if}
</dialog>
