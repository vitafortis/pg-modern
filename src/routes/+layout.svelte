<script lang="ts">
	import '../app.css';
	import favicon from '#lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import {
		LayoutDashboard,
		Radar,
		Settings,
		Plus,
		Moon,
		Sun,
		LogOut,
		Lock,
		PencilLine,
		Search,
		PanelLeftClose,
		PanelLeftOpen
	} from '@lucide/svelte';
	import Logo from '#lib/components/Logo.svelte';
	import Toaster from '#lib/components/Toaster.svelte';
	import ConnectionDialog from '#lib/components/ConnectionDialog.svelte';
	import { api } from '#lib/client/api.ts';
	import { COLORS } from '#lib/client/format.ts';
	import { connections, editor, setTheme, theme } from '#lib/client/state.svelte.ts';
	import type { LayoutProps } from './$types';

	let { children, data }: LayoutProps = $props();

	// Seed the shared store from the server render; pages refresh it after mutations.
	$effect.pre(() => {
		connections.list = data.connections;
		connections.loaded = true;
	});

	$effect(() => {
		theme.value = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
	});

	let filter = $state('');
	let collapsed = $state(false);
	const bare = $derived(page.url.pathname === '/login' || page.url.pathname === '/setup');
	const filtered = $derived(
		connections.list.filter((c) =>
			`${c.name} ${c.host} ${c.database}`.toLowerCase().includes(filter.toLowerCase())
		)
	);

	const nav = [
		{ href: '/', label: 'Overview', icon: LayoutDashboard },
		{ href: '/discover', label: 'Discover', icon: Radar },
		{ href: '/settings', label: 'Settings', icon: Settings }
	];

	async function logout() {
		await api.post('/api/auth/logout');
		goto('/login');
	}

	function onkeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
			e.preventDefault();
			collapsed = !collapsed;
		}
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>pg·modern</title>
</svelte:head>

<svelte:window {onkeydown} />

{#if bare}
	{@render children()}
{:else}
	<div class="flex h-dvh overflow-hidden">
		<aside
			class="flex shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200 {collapsed
				? 'w-14'
				: 'w-64'}"
		>
			<div class="flex h-14 items-center gap-2.5 px-3.5">
				<a href="/" class="flex items-center gap-2.5">
					<Logo size={26} />
					{#if !collapsed}
						<span class="text-[15px] font-semibold tracking-tight">pg<span class="text-primary">·</span>modern</span>
					{/if}
				</a>
			</div>

			<nav class="space-y-0.5 px-2 pt-1">
				{#each nav as item (item.href)}
					{@const active = item.href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(item.href)}
					<a
						href={item.href}
						title={item.label}
						class="relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors {active
							? 'bg-accent text-foreground shadow-surface'
							: 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'}"
					>
						{#if active}<span class="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-primary"></span>{/if}
						<item.icon class="size-4 shrink-0" />
						{#if !collapsed}{item.label}{/if}
					</a>
				{/each}
			</nav>

			<div class="mt-5 flex items-center justify-between px-4 pb-1.5">
				{#if !collapsed}
					<span class="text-[11px] font-semibold tracking-wider text-muted-foreground/80 uppercase">Connections</span>
				{/if}
				<button class="btn btn-ghost btn-icon btn-sm -mr-1.5" title="New connection" onclick={() => (editor.target = 'new')}>
					<Plus />
				</button>
			</div>

			{#if !collapsed && connections.list.length > 6}
				<div class="relative mx-2 mb-1.5">
					<Search class="absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
					<input class="input h-7 pl-7 text-xs" placeholder="Filter…" bind:value={filter} />
				</div>
			{/if}

			<div class="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
				{#each filtered as c (c.id)}
					{@const active = page.url.pathname.startsWith(`/c/${c.id}`)}
					<a
						href="/c/{c.id}"
						title="{c.name} — {c.user}@{c.host}:{c.port}/{c.database}"
						class="group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors {active
							? 'bg-accent text-foreground'
							: 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'}"
					>
						<span class="size-2 shrink-0 rounded-full" style="background:{COLORS[c.color] ?? COLORS.violet}; box-shadow: 0 0 8px {COLORS[c.color] ?? COLORS.violet}"></span>
						{#if !collapsed}
							<span class="min-w-0 flex-1 truncate">{c.name}</span>
							{#if c.readOnly}
								<Lock class="size-3 shrink-0 opacity-40" />
							{:else}
								<PencilLine class="size-3 shrink-0 text-warning" />
							{/if}
						{/if}
					</a>
				{:else}
					{#if !collapsed}
						<button
							class="w-full rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground"
							onclick={() => goto('/discover')}
						>
							No connections yet.<br /><span class="text-primary">Discover databases →</span>
						</button>
					{/if}
				{/each}
			</div>

			<div class="flex items-center gap-1 border-t border-border p-2 {collapsed ? 'flex-col' : ''}">
				<button class="btn btn-ghost btn-icon btn-sm" title="Toggle sidebar (⌘B)" onclick={() => (collapsed = !collapsed)}>
					{#if collapsed}<PanelLeftOpen />{:else}<PanelLeftClose />{/if}
				</button>
				<button
					class="btn btn-ghost btn-icon btn-sm"
					title="Toggle theme"
					onclick={() => setTheme(theme.value === 'dark' ? 'light' : 'dark')}
				>
					{#if theme.value === 'dark'}<Sun />{:else}<Moon />{/if}
				</button>
				{#if data.auth === 'authenticated'}
					<button class="btn btn-ghost btn-icon btn-sm {collapsed ? '' : 'ml-auto'}" title="Sign out" onclick={logout}><LogOut /></button>
				{/if}
			</div>
		</aside>

		<main class="relative min-w-0 flex-1 overflow-hidden">
			{@render children()}
		</main>
	</div>
	<ConnectionDialog />
{/if}

<Toaster />
