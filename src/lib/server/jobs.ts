/**
 * In-process background jobs (scheduled backups, alert checks, size sampling).
 *
 * Each job runs on a fixed interval, never overlaps itself, and logs (rather than throws)
 * failures. Jobs register at module load with `defineJob`; `startJobs` is called once
 * from the server `init` hook so nothing runs during builds or tests.
 */

export interface Job {
	name: string;
	/** How often to run. Jobs that need wall-clock schedules (e.g. "03:00 daily") should run every minute and decide for themselves. */
	everyMs: number;
	/** Delay before the first run, so a restart doesn't hammer every database at once. */
	initialDelayMs?: number;
	run: () => Promise<void>;
}

export interface JobStatus {
	name: string;
	running: boolean;
	lastStartedAt: string | null;
	lastFinishedAt: string | null;
	lastError: string | null;
}

interface Entry {
	job: Job;
	status: JobStatus;
	timer?: ReturnType<typeof setTimeout>;
}

const jobs = new Map<string, Entry>();
let started = false;

export function defineJob(job: Job): void {
	const existing = jobs.get(job.name);
	if (existing?.timer) clearTimeout(existing.timer);
	const entry: Entry = {
		job,
		status: existing?.status ?? { name: job.name, running: false, lastStartedAt: null, lastFinishedAt: null, lastError: null }
	};
	jobs.set(job.name, entry);
	if (started) schedule(entry, job.initialDelayMs ?? 5_000);
}

function schedule(entry: Entry, delay: number) {
	entry.timer = setTimeout(() => void tick(entry), delay);
	entry.timer.unref?.();
}

async function tick(entry: Entry) {
	if (jobs.get(entry.job.name) !== entry) return; // replaced
	await runJob(entry);
	schedule(entry, entry.job.everyMs);
}

async function runJob(entry: Entry) {
	if (entry.status.running) return;
	entry.status.running = true;
	entry.status.lastStartedAt = new Date().toISOString();
	try {
		await entry.job.run();
		entry.status.lastError = null;
	} catch (err) {
		entry.status.lastError = (err as Error).message;
		console.error(`[job ${entry.job.name}]`, err);
	} finally {
		entry.status.running = false;
		entry.status.lastFinishedAt = new Date().toISOString();
	}
}

/** Starts every registered job. Safe to call more than once. */
export function startJobs(): void {
	if (started || process.env.PGM_DISABLE_JOBS === '1') return;
	started = true;
	for (const entry of jobs.values()) schedule(entry, entry.job.initialDelayMs ?? 5_000);
}

/** Runs a job now (e.g. a "Run backup now" button), waiting for it to finish. */
export async function runNow(name: string): Promise<JobStatus> {
	const entry = jobs.get(name);
	if (!entry) throw new Error(`Unknown job "${name}"`);
	await runJob(entry);
	return { ...entry.status };
}

export function jobStatuses(): JobStatus[] {
	return [...jobs.values()].map((e) => ({ ...e.status }));
}
