import { hostname, networkInterfaces } from 'node:os';
import { config, IN_CONTAINER } from '../config.ts';
import type { NetworkPath, SelfNetworks } from '#lib/types.ts';

/** The container's view of its networks, normalised from the Docker or Arcane API. */
export interface ContainerNetworks {
	id: string;
	name: string;
	/** Network name → IP on that network ('' when unknown). */
	networks: Record<string, string>;
	/** Published host ports for the database's internal port. */
	published: { host: string; port: number }[];
	running: boolean;
}

/** Networks that don't give peers a route by name or IP. */
const NO_ROUTE = new Set(['none']);

function ownAddresses(): Set<string> {
	const out = new Set<string>();
	for (const list of Object.values(networkInterfaces())) {
		for (const a of list ?? []) if (!a.internal) out.add(a.address);
	}
	return out;
}

/**
 * Finds pg·modern's own container in a container list: by PGM_SELF_CONTAINER, by hostname
 * (Docker's default is the short container id), or by one of this process's addresses.
 */
export function findSelf(containers: ContainerNetworks[]): SelfNetworks {
	const named = config.selfContainer?.toLowerCase();
	if (!IN_CONTAINER && !named) return { inContainer: false, networks: [] };
	const host = hostname().toLowerCase();
	const addrs = ownAddresses();
	const self =
		(named ? containers.find((c) => c.name.toLowerCase() === named || c.id.toLowerCase().startsWith(named)) : undefined) ??
		containers.find((c) => host.length >= 12 && c.id.toLowerCase().startsWith(host)) ??
		containers.find((c) => Object.values(c.networks).some((ip) => ip && addrs.has(ip)));
	return self
		? { inContainer: true, container: self.name, networks: Object.keys(self.networks).filter((n) => !NO_ROUTE.has(n)).sort() }
		: { inContainer: true, networks: [] };
}

/**
 * How pg·modern can get to a database container: over a network both are attached to,
 * through a port published on the host, or not at all (and which network would fix that).
 */
export function networkPath(db: ContainerNetworks, self: SelfNetworks, internalPort: number): NetworkPath {
	const networks = Object.keys(db.networks).sort();
	const published = db.published;
	if (networks.includes('host')) return { networks, shared: [], published, via: 'host-network' };
	// Only meaningful when we found ourselves on the same Docker host.
	const shared = self.container ? networks.filter((n) => self.networks.includes(n) && !NO_ROUTE.has(n)) : [];
	if (shared.length) return { networks, shared, published, via: 'shared-network' };
	if (published.length) return { networks, shared, published, via: 'published-port' };
	const joinable = networks.filter((n) => !['bridge', 'host', 'none'].includes(n));
	return {
		networks,
		shared,
		published,
		via: 'none',
		// Joining a network only helps when pg·modern runs on the same Docker host.
		join: self.container ? joinable[0] : undefined,
		publish: internalPort
	};
}

type ComposeNetworkDef = { name?: string; external?: boolean | { name?: string } } | null;

/**
 * Real Docker network names a compose service ends up on: `<project>_default` unless it
 * lists networks, `<project>_<key>` for project networks, and `name:` / external names as-is.
 */
export function composeServiceNetworks(
	project: string,
	service: { networks?: string[] | Record<string, unknown> | null; network_mode?: string },
	topLevel: Record<string, ComposeNetworkDef> | undefined
): string[] {
	if (service.network_mode) {
		if (service.network_mode === 'host') return ['host'];
		return []; // service:/container: modes share another container's stack
	}
	const keys = Array.isArray(service.networks) ? service.networks : service.networks ? Object.keys(service.networks) : ['default'];
	const slug = project.toLowerCase().replace(/[^a-z0-9_-]/g, '');
	return keys.map((k) => {
		const def = topLevel?.[k];
		const ext = def?.external;
		if (typeof ext === 'object' && ext?.name) return ext.name;
		if (def?.name) return def.name;
		if (ext) return k;
		return `${slug}_${k}`;
	});
}
