import { connect } from 'node:net';

const cache = new Map<string, { ok: boolean; at: number }>();

/** TCP reachability check, cached briefly so repeated scans stay fast. */
export function probe(host: string, port: number, timeoutMs = 1200): Promise<boolean> {
	const key = `${host}:${port}`;
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < 30_000) return Promise.resolve(hit.ok);
	return new Promise((resolve) => {
		const socket = connect({ host, port });
		const done = (ok: boolean) => {
			socket.destroy();
			cache.set(key, { ok, at: Date.now() });
			resolve(ok);
		};
		socket.setTimeout(timeoutMs, () => done(false));
		socket.once('connect', () => done(true));
		socket.once('error', () => done(false));
	});
}

/** Runs `fn` over `items` with bounded concurrency. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i]);
			}
		})
	);
	return out;
}
