<script lang="ts">
	import { onMount } from 'svelte';
	import { KeyRound, ShieldCheck, Plug, ArrowRight } from '@lucide/svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { api } from '#lib/client/api.ts';

	type Env = {
		scanDepth: number;
		statementTimeoutMs: number;
		maxRows: number;
		dataDir: string;
		keySource: string;
		authDisabled: boolean;
		inContainer: boolean;
	};

	let env = $state<Env | null>(null);

	onMount(async () => {
		env = (await api.get<{ env: Env }>('/api/settings')).env;
	});
</script>

<svelte:head><title>Settings · pg·modern</title></svelte:head>

<div class="h-full overflow-y-auto">
	<PageHeader title="Settings" description="How pg·modern protects your credentials and runs queries." />

	<div class="max-w-5xl space-y-5 px-8 pb-10">
		<a href="/integrations" class="card flex items-center gap-3 p-4 transition-colors hover:bg-accent/40">
			<span class="grid size-9 place-items-center rounded-lg bg-primary-soft text-primary"><Plug class="size-4" /></span>
			<div class="flex-1">
				<p class="text-[13px] font-medium">Integrations</p>
				<p class="text-xs text-muted-foreground">Single sign-on, Arcane, Docker endpoints and scan folders.</p>
			</div>
			<ArrowRight class="size-4 text-muted-foreground" />
		</a>

		<section class="card p-5">
			<h2 class="flex items-center gap-2 text-[14px] font-semibold"><ShieldCheck class="size-4 text-primary" />Security</h2>
			{#if env}
				<div class="mt-4 grid gap-x-8 gap-y-3 text-[13px] md:grid-cols-2">
					<div class="flex items-center justify-between gap-4"><span class="text-muted-foreground">Credential encryption</span><span class="font-mono text-xs">AES-256-GCM</span></div>
					<div class="flex items-center justify-between gap-4"><span class="flex items-center gap-1.5 text-muted-foreground"><KeyRound class="size-3.5" />Master key</span><span class="font-mono text-xs">{env.keySource}</span></div>
					<div class="flex items-center justify-between gap-4"><span class="text-muted-foreground">Data directory</span><span class="truncate font-mono text-xs">{env.dataDir}</span></div>
					<div class="flex items-center justify-between gap-4"><span class="text-muted-foreground">Login</span>{#if env.authDisabled}<span class="badge badge-warning">disabled (PGM_AUTH)</span>{:else}<span class="badge badge-success">required</span>{/if}</div>
					<div class="flex items-center justify-between gap-4"><span class="text-muted-foreground">Statement timeout</span><span class="font-mono text-xs">{env.statementTimeoutMs / 1000}s</span></div>
					<div class="flex items-center justify-between gap-4"><span class="text-muted-foreground">Max rows per result</span><span class="font-mono text-xs">{env.maxRows.toLocaleString()}</span></div>
				</div>
				<div class="mt-5 space-y-2 rounded-xl bg-surface p-4 text-xs text-muted-foreground">
					<p><b class="font-medium text-foreground">Read-only by default.</b> New and imported connections run every statement inside <code class="font-mono">BEGIN READ ONLY … ROLLBACK</code>, with <code class="font-mono">default_transaction_read_only</code> set on the session and transaction-control statements blocked.</p>
					<p><b class="font-medium text-foreground">Secrets stay server-side.</b> Discovered passwords are never sent to the browser; imports reference them by fingerprint and they go straight into the encrypted store.</p>
					{#if env.keySource === 'key file'}
						<p><b class="font-medium text-foreground">Back up your key.</b> Credentials are sealed with <code class="font-mono">{env.dataDir}/secret.key</code>. Set <code class="font-mono">PGM_SECRET_KEY</code> to manage it yourself.</p>
					{/if}
				</div>
			{/if}
		</section>
	</div>
</div>
