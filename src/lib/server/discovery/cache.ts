import type { Candidate } from '#lib/types.ts';
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

/** Strips secrets and marks candidates that match an already-saved connection. */
export function redact(candidates: Candidate[]): Candidate[] {
	const saved = listConnections();
	return candidates.map(({ password: _password, ...c }) => {
		const addresses = [{ host: c.host, port: c.port }, ...(c.alternates ?? [])];
		const existing = saved.find(
			(s) =>
				s.user === c.user &&
				s.database === c.database &&
				addresses.some((a) => a.host.toLowerCase() === s.host.toLowerCase() && a.port === s.port)
		);
		return { ...c, existingId: existing?.id };
	});
}
