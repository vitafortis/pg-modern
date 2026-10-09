import type { Candidate, Connection } from '#lib/types.ts';
import { listConnections } from '../store.ts';

/**
 * Discovered candidates (with passwords) stay server-side. The browser only receives
 * redacted copies and imports by fingerprint, so secrets never leave the server until
 * they're encrypted into the store.
 */
const pending = new Map<string, { candidate: Candidate; at: number }>();
const TTL_MS = 30 * 60_000;

export function remember(candidates: Candidate[]) {
	const now = Date.now();
	for (const [k, v] of pending) if (now - v.at > TTL_MS) pending.delete(k);
	for (const c of candidates) {
		c.key = `${c.source.kind}:${c.source.ref ?? ''}:${c.fingerprint}`;
		pending.set(c.key, { candidate: c, at: now });
	}
}

export function recall(key: string): Candidate | undefined {
	return pending.get(key)?.candidate;
}

/** Strips secrets and marks candidates that correspond to an already-saved connection. */
export function redact(candidates: Candidate[]): Candidate[] {
	const saved = listConnections();
	return candidates.map(({ password: _password, ...c }) => {
		const addresses = [{ host: c.host, port: c.port }, ...(c.alternates ?? [])];
		const sameLogin = (s: Connection) => s.engine === c.engine && s.user === c.user && s.database === c.database;
		const atAddress = saved.find(
			(s) => sameLogin(s) && addresses.some((a) => a.host.toLowerCase() === s.host.toLowerCase() && a.port === s.port)
		);
		// Imported from the same container or file, but the address has since moved.
		const moved =
			!atAddress && c.source.ref
				? saved.find((s) => sameLogin(s) && s.source.kind === c.source.kind && s.source.ref === c.source.ref)
				: undefined;
		// A SQLite snapshot is saved under its local copy's path; match it by container and path.
		const snapshot =
			c.sqlite?.via === 'archive'
				? saved.find((s) => s.snapshot?.container === c.sqlite!.container && s.snapshot?.containerPath === c.sqlite!.containerPath && s.snapshot?.endpoint === c.sqlite!.endpoint)
				: undefined;
		if (snapshot) return { ...c, saved: { id: snapshot.id, name: snapshot.name, host: snapshot.host, port: snapshot.port, addressChanged: false } };
		const match = atAddress ?? moved;
		// Saved on an address this scan found unreachable, while another one answers.
		const better = !!atAddress && c.reachable === true && (atAddress.host.toLowerCase() !== c.host.toLowerCase() || atAddress.port !== c.port);
		return {
			...c,
			saved: match && { id: match.id, name: match.name, host: match.host, port: match.port, addressChanged: !atAddress || better }
		};
	});
}
