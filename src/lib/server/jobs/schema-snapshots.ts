/**
 * Auto snapshots: every 6 hours, each connection with auto-snapshot on has its schema
 * captured and hashed. Only when the hash differs from the latest snapshot is a new
 * one stored, so an app upgrade that migrates its database shows up in the history.
 */
import { defineJob } from '../jobs.ts';
import { autoSnapshotConnections, checkForChanges } from '../schema-snapshots.ts';
import { getConnection } from '../store.ts';

export const SCHEMA_SNAPSHOT_JOB = 'schema-snapshots';

defineJob({
	name: SCHEMA_SNAPSHOT_JOB,
	everyMs: 6 * 60 * 60 * 1000,
	initialDelayMs: 2 * 60 * 1000,
	async run() {
		const failures: string[] = [];
		for (const id of autoSnapshotConnections()) {
			const conn = getConnection(id);
			if (!conn) continue;
			try {
				const r = await checkForChanges(id);
				if (r.changed) console.log(`[pg-modern] Schema of "${conn.name}" changed; stored snapshot ${r.snapshot.id}`);
			} catch (err) {
				failures.push(`${conn.name}: ${(err as Error).message}`);
			}
		}
		if (failures.length) throw new Error(`Schema check failed for ${failures.join('; ')}`);
	}
});
