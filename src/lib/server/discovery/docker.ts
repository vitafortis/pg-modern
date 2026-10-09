import { request } from 'node:http';
import { config, IN_CONTAINER } from '../config.ts';
import { getSettings } from '../store.ts';
import { extractCandidates, fingerprint } from './env.ts';
import { detectServer, postgresLogins, serverLogins, type ServerKind } from './detect.ts';
import { mapLimit, probe } from './probe.ts';
import { findSelf, networkPath, type ContainerNetworks } from './network.ts';
import type { Candidate, DockerCandidateGroup, NetworkPath, SelfNetworks } from '#lib/types.ts';



interface ContainerSummary {
	Id: string;
	Names: string[];
	Image: string;
	State: string;
	Status: string;
	NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> | null } | null;
}

function summaryNetworks(c: ContainerSummary): ContainerNetworks {
	return {
		id: c.Id,
		name: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''),
		networks: Object.fromEntries(Object.entries(c.NetworkSettings?.Networks ?? {}).map(([n, v]) => [n, v.IPAddress ?? ''])),
		published: [],
		running: c.State === 'running'
	};
}

let selfCache: { at: number; value: SelfNetworks } | undefined;

/** pg·modern's own networks, looked up on the configured Docker endpoints (cached briefly). */
export async function dockerSelf(): Promise<SelfNetworks> {
	if (selfCache && Date.now() - selfCache.at < 60_000) return selfCache.value;
	let value: SelfNetworks = { inContainer: IN_CONTAINER, networks: [] };
	for (const endpoint of dockerEndpoints()) {
		try {
			const found = findSelf((await dockerGet<ContainerSummary[]>(endpoint, '/containers/json')).map(summaryNetworks));
			if (found.container) {
				value = found;
				break;
			}
		} catch {}
	}
	selfCache = { at: Date.now(), value };
	return value;
}

interface ContainerInspect {
	Id: string;
	Name: string;
	Config: { Env: string[] | null; Image: string; Labels: Record<string, string> | null; ExposedPorts?: Record<string, object> };
	NetworkSettings: {
		Ports: Record<string, { HostIp: string; HostPort: string }[] | null> | null;
		Networks: Record<string, { IPAddress: string; Aliases: string[] | null }> | null;
	};
}

/** Turns socket/HTTP failures into a fix the user can apply. */
function explainDockerError(endpoint: string, err: unknown): string {
	const e = err as NodeJS.ErrnoException;
	if (e.code === 'EACCES') {
		return `Permission denied on ${endpoint}. The container runs as a non-root user: add group_add with the socket's group id, or use the read-only docker-socket-proxy from the default compose file.`;
	}
	if (e.code === 'ENOENT') return `${endpoint} doesn't exist inside this container — mount /var/run/docker.sock or point PGM_DOCKER_HOSTS at a proxy.`;
	if (e.code === 'ECONNREFUSED') return `Connection refused at ${endpoint} — is the Docker API / socket proxy running?`;
	if (/403/.test(e.message ?? '')) return `${endpoint} refused the request (403). If it's docker-socket-proxy, set CONTAINERS=1.`;
	return e.message ?? String(err);
}

export function dockerEndpoints(): string[] {
	return [...new Set([...config.dockerHosts, ...getSettings().dockerHosts])];
}

function dockerGet<T>(endpoint: string, path: string): Promise<T> {
	const url = endpoint.startsWith('unix://')
		? { socketPath: endpoint.slice('unix://'.length), path }
		: (() => {
				const u = new URL(endpoint.replace(/^tcp:/, 'http:'));
				return { host: u.hostname, port: Number(u.port) || 2375, path };
			})();
	return new Promise((resolve, reject) => {
		const req = request({ ...url, method: 'GET', timeout: 5000, headers: { Host: 'docker' } }, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => {
				const body = Buffer.concat(chunks).toString('utf8');
				if ((res.statusCode ?? 500) >= 400) reject(new Error(`Docker API ${res.statusCode}: ${body.slice(0, 200)}`));
				else {
					try {
						resolve(JSON.parse(body));
					} catch (err) {
						reject(err);
					}
				}
			});
		});
		req.on('timeout', () => req.destroy(new Error('Docker API timed out')));
		req.on('error', reject);
		req.end();
	});
}

export function envMap(env: string[] | null): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of env ?? []) {
		const i = line.indexOf('=');
		if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
	}
	return out;
}

/** Host that reaches ports published on this Docker endpoint. */
function publishedHost(endpoint: string, hostIp: string): string {
	const wildcard = !hostIp || hostIp === '0.0.0.0' || hostIp === '::';
	const loopback = /^(127\.|::1$)/.test(hostIp);
	if (!wildcard && !loopback) return hostIp;
	if (endpoint.startsWith('unix://')) {
		// Inside a container, loopback is the container itself; the host is reached via host-gateway.
		return IN_CONTAINER ? 'host.docker.internal' : '127.0.0.1';
	}
	return new URL(endpoint.replace(/^tcp:/, 'http:')).hostname;
}

export function uniqueAddresses<T extends { host: string; port: number }>(list: T[]): T[] {
	const seen = new Set<string>();
	return list.filter((a) => {
		const k = `${a.host.toLowerCase()}:${a.port}`;
		return seen.has(k) ? false : (seen.add(k), true);
	});
}

export type Address = { host: string; port: number; label: string };

function addressesFor(endpoint: string, c: ContainerInspect, internalPort: number): Address[] {
	const out: Address[] = [];
	const bindings = c.NetworkSettings.Ports?.[`${internalPort}/tcp`] ?? [];
	const seen = new Set<string>();
	for (const b of bindings) {
		const host = publishedHost(endpoint, b.HostIp);
		const key = `${host}:${b.HostPort}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ host, port: Number(b.HostPort), label: 'published port' });
	}
	const name = c.Name.replace(/^\//, '');
	const networks = Object.entries(c.NetworkSettings.Networks ?? {});
	// Container names resolve only for peers on a shared user-defined network.
	if (IN_CONTAINER) out.push({ host: name, port: internalPort, label: 'container name' });
	for (const [net, info] of networks) {
		if (info.IPAddress) out.push({ host: info.IPAddress, port: internalPort, label: `${net} network` });
	}
	return out;
}

export async function pickReachable(addresses: Address[]): Promise<{ primary: Address; alternates: Address[]; reachable: boolean }> {
	const results = await Promise.all(addresses.map((a) => probe(a.host, a.port)));
	const idx = results.findIndex(Boolean);
	const primary = addresses[idx === -1 ? 0 : idx];
	return { primary, alternates: uniqueAddresses(addresses.filter((a) => a !== primary)), reachable: idx !== -1 };
}

/**
 * Probes a candidate's address and its alternates, and makes the first reachable one
 * primary. Compose files and .env files say where a database *should* be; this picks
 * the address that actually answers from where pg·modern runs.
 */
export async function settleAddress(c: Candidate): Promise<Candidate> {
	const addresses = uniqueAddresses<Address>([{ host: c.host, port: c.port, label: 'as configured' }, ...(c.alternates ?? [])]);
	const { primary, alternates, reachable } = await pickReachable(addresses);
	c.reachable = reachable;
	if (primary.host !== c.host || primary.port !== c.port) {
		c.host = primary.host;
		c.port = primary.port;
		c.alternates = alternates;
		c.fingerprint = fingerprint(c);
	}
	return c;
}

export function postgresCredentials(env: Record<string, string>) {
	return postgresLogins(env)[0];
}

/** A database server container found by a scan, so app containers that point at it can be resolved. */
export interface KnownServer {
	addresses: Address[];
	kind: ServerKind;
	/** Login an app pointing at the server most likely uses (for its default database). */
	database: string;
	user: string;
}

/** An app's candidate takes the engine of the server container it points at. */
export function adoptServer(cand: Candidate, server: KnownServer) {
	if (cand.engine !== server.kind.engine) {
		cand.engine = server.kind.engine;
		if (cand.database === cand.user && server.kind.engine === 'mysql') cand.database = server.database;
	}
	if (server.kind.engine === 'mysql') cand.flavor = server.kind.flavor;
}

export async function discoverDocker(): Promise<{ groups: DockerCandidateGroup[]; candidates: Candidate[] }> {
	const endpoints = dockerEndpoints();
	const all: Candidate[] = [];

	const groups = await Promise.all(
		endpoints.map(async (endpoint): Promise<DockerCandidateGroup> => {
			try {
				const list = await dockerGet<ContainerSummary[]>(endpoint, '/containers/json?all=1');
				// One container failing to inspect (e.g. removed mid-scan) shouldn't hide the rest.
				const results = await mapLimit(list, 8, (c) =>
					dockerGet<ContainerInspect>(endpoint, `/containers/${c.Id}/json`).catch(() => null)
				);
				const kept = list.map((summary, i) => ({ summary, inspect: results[i] })).filter((x) => x.inspect !== null);
				const self = findSelf(list.map(summaryNetworks));
				if (self.container) selfCache = { at: Date.now(), value: self };
				const inspected = kept.map((x) => x.inspect!);
				const summaries = kept.map((x) => x.summary);

				// Database servers first, so app containers can point at them by name.
				const servers = new Map<string, KnownServer>();
				const paths = new Map<string, NetworkPath>();
				const containers: DockerCandidateGroup['containers'] = [];

				const serverKind = (c: ContainerInspect) => detectServer(c.Config.Image, envMap(c.Config.Env), Object.keys(c.Config.ExposedPorts ?? {}));

				for (const pass of ['servers', 'apps'] as const) {
					for (let i = 0; i < inspected.length; i++) {
						const c = inspected[i];
						const summary = summaries[i];
						const kind = serverKind(c);
						if ((pass === 'servers') !== !!kind) continue;
						const env = envMap(c.Config.Env);
						const name = c.Name.replace(/^\//, '');
						const labels = c.Config.Labels ?? {};
						const project = labels['com.docker.compose.project'];
						const service = labels['com.docker.compose.service'];
						const label = project ? `${project}/${service}` : name;
						const source = { kind: 'docker' as const, ref: `${endpoint}#${name}` };
						const candidates: Candidate[] = [];

						if (kind) {
							const internalPort = kind.port;
							const addresses = addressesFor(endpoint, c, internalPort);
							const path = networkPath(
								{
									id: c.Id,
									name,
									networks: Object.fromEntries(Object.entries(c.NetworkSettings.Networks ?? {}).map(([n, v]) => [n, v.IPAddress ?? ''])),
									published: addresses.filter((a) => a.label === 'published port').map(({ host, port }) => ({ host, port })),
									running: summary.State === 'running'
								},
								self,
								internalPort
							);
							const logins = serverLogins(kind, env);
							// Service names ("db", "postgres") repeat across stacks, so scope them to the compose project.
							const known: KnownServer = { addresses, kind, database: logins[0].database, user: logins[0].user };
							servers.set(name.toLowerCase(), known);
							paths.set(name.toLowerCase(), path);
							if (project && service) {
								servers.set(`${project}::${service}`.toLowerCase(), known);
								paths.set(`${project}::${service}`.toLowerCase(), path);
							}
							const { primary, alternates, reachable } = addresses.length
								? await pickReachable(addresses)
								: { primary: { host: name, port: internalPort, label: 'container name' }, alternates: [], reachable: false };
							// MySQL servers offer the app user and root, when both are set.
							for (const login of logins) {
								const notes = [...login.notes];
								if (summary.State !== 'running') notes.push(`Container is ${summary.State}.`);
								const base = { engine: kind.engine, host: primary.host, port: primary.port, database: login.database, user: login.user };
								candidates.push({
									...base,
									...(kind.engine === 'mysql' ? { flavor: kind.flavor } : {}),
									fingerprint: fingerprint(base),
									name: logins.length > 1 ? `${label} (${login.user})` : label,
									password: login.password,
									hasPassword: !!login.password,
									sslMode: 'prefer',
									source,
									alternates,
									notes,
									reachable,
									network: path
								});
							}
						} else {
							for (const cand of extractCandidates(env, { label, source })) {
								const host = cand.host.toLowerCase();
								const target = (project && servers.get(`${project}::${host}`.toLowerCase())) || servers.get(host);
								cand.network = (project && paths.get(`${project}::${host}`.toLowerCase())) || paths.get(host);
								if (/^(localhost|127\.0\.0\.1|::1)$/.test(host)) {
									cand.notes.push('Configured as localhost inside the container, which may not be this host.');
								}
								if (target?.addresses.length) {
									adoptServer(cand, target);
									// The app talks to a sibling container; offer the addresses we can actually reach.
									const { primary, alternates, reachable } = await pickReachable(target.addresses);
									cand.alternates = uniqueAddresses([{ host: cand.host, port: cand.port, label: 'as configured' }, ...alternates]).filter(
										(a) => a.host !== primary.host || a.port !== primary.port
									);
									cand.host = primary.host;
									cand.port = primary.port;
									cand.reachable = reachable;
									cand.fingerprint = fingerprint(cand);
								} else {
									await settleAddress(cand);
								}
								candidates.push(cand);
							}
						}

						if (candidates.length) {
							const unique = candidates.filter((c, i) => candidates.findIndex((x) => x.fingerprint === c.fingerprint) === i);
							candidates.splice(0, candidates.length, ...unique);
							all.push(...candidates);
							containers.push({ id: c.Id.slice(0, 12), name, image: c.Config.Image, state: summary.State, status: summary.Status, candidates });
						}
					}
				}
				// Everything else, so the UI can show what was looked at and why it was skipped.
				const listed = new Set(containers.map((c) => c.id));
				const skipped = inspected
					.map((c, i) => ({ id: c.Id.slice(0, 12), name: c.Name.replace(/^\//, ''), image: c.Config.Image, state: summaries[i].State }))
					.filter((c) => !listed.has(c.id))
					.sort((a, b) => a.name.localeCompare(b.name));
				return { endpoint, self, inspected: inspected.length, containers, skipped };
			} catch (err) {
				return { endpoint, error: explainDockerError(endpoint, err), containers: [] };
			}
		})
	);

	return { groups, candidates: all };
}
