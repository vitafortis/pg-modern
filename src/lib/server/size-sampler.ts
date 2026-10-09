/**
 * The size-history job: once per hour per connection, records the database size and
 * its 50 largest tables, then rolls old samples up. It ticks every 15 minutes and
 * skips connections already sampled this hour, so restarts don't add extra samples.
 */
import { defineJob } from './jobs.ts';
import { listConnections } from './store.ts';
import { monitorable, sampleSizes } from './monitor.ts';
import { recordSample, rollup, sampledThisHour } from './size-history.ts';

export const SIZE_JOB = 'size-history';
const CONCURRENCY = 2;

/** Samples one connection now (replacing this hour's sample, if any). */
export async function sampleConnection(id: string, now = Date.now()) {
	const { dbBytes, tables } = await sampleSizes(id);
	recordSample(id, dbBytes, tables, now);
}

export async function sampleAll(now = Date.now()) {
	const due = listConnections().filter((c) => monitorable(c) && !sampledThisHour(c.id, now));
	let i = 0;
	const failures: string[] = [];
	const worker = async () => {
		while (i < due.length) {
			const c = due[i++];
			try {
				await sampleConnection(c.id, now);
			} catch (err) {
				// Unreachable databases simply have a gap in their history.
				failures.push(`${c.name}: ${(err as Error).message}`);
			}
		}
	};
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));
	rollup(now);
	if (failures.length) console.warn(`[size-history] ${failures.length} connection(s) not sampled:`, failures.join('; '));
}

defineJob({ name: SIZE_JOB, everyMs: 15 * 60_000, initialDelayMs: 90_000, run: () => sampleAll() });
