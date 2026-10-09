/**
 * Storage for backup destinations, schedules and runs (tables created in store.ts).
 * Destination secrets are sealed with the master key, bound to the destination id.
 */
import { randomUUID } from 'node:crypto';
import { sqlite } from '../store.ts';
import { decrypt, encrypt } from '../crypto.ts';
import { nextRunAt } from '#lib/backups.ts';
import type {
	BackupDestination,
	BackupRun,
	BackupSchedule,
	DestinationConfig,
	DestinationSecrets,
	ScheduleInput
} from '#lib/backups.ts';

type Row = Record<string, unknown>;
const db = () => sqlite();
const now = () => new Date().toISOString();

// --- destinations --------------------------------------------------------------

function secretContext(id: string) {
	return `backup-destination:${id}`;
}

function readSecrets(id: string, sealed: unknown): DestinationSecrets {
	if (typeof sealed !== 'string' || !sealed) return {};
	return JSON.parse(decrypt(sealed, secretContext(id))) as DestinationSecrets;
}

function toDestination(r: Row): BackupDestination {
	let secrets: DestinationSecrets = {};
	try {
		secrets = readSecrets(r.id as string, r.secret);
	} catch {
		// A changed master key: show the destination without secrets rather than failing the list.
	}
	return {
		id: r.id as string,
		name: r.name as string,
		kind: r.kind as BackupDestination['kind'],
		config: JSON.parse(r.config as string),
		hasPassword: !!secrets.password,
		hasPrivateKey: !!secrets.privateKey,
		hasPassphrase: !!secrets.passphrase,
		hasSecretKey: !!secrets.secretAccessKey,
		createdAt: r.created_at as string,
		updatedAt: r.updated_at as string
	} as BackupDestination;
}

export function listDestinations(): BackupDestination[] {
	return (db().prepare('SELECT * FROM backup_destinations ORDER BY name COLLATE NOCASE').all() as Row[]).map(toDestination);
}

export function getDestination(id: string): BackupDestination | undefined {
	const r = db().prepare('SELECT * FROM backup_destinations WHERE id = ?').get(id) as Row | undefined;
	return r && toDestination(r);
}

export function getDestinationSecrets(id: string): DestinationSecrets {
	const r = db().prepare('SELECT secret FROM backup_destinations WHERE id = ?').get(id) as Row | undefined;
	return readSecrets(id, r?.secret);
}

/**
 * Merges a secrets patch into the stored ones: `undefined` keeps a value, an empty
 * string clears it, anything else replaces it.
 */
export function mergeSecrets(current: DestinationSecrets, patch: DestinationSecrets): DestinationSecrets {
	const out: DestinationSecrets = { ...current };
	for (const k of ['password', 'privateKey', 'passphrase', 'secretAccessKey'] as const) {
		const v = patch[k];
		if (v === undefined) continue;
		if (v === '') delete out[k];
		else out[k] = v;
	}
	return out;
}

function seal(id: string, secrets: DestinationSecrets): string | null {
	const clean = Object.fromEntries(Object.entries(secrets).filter(([, v]) => typeof v === 'string' && v));
	return Object.keys(clean).length ? encrypt(JSON.stringify(clean), secretContext(id)) : null;
}

export function createDestination(name: string, dest: DestinationConfig, secrets: DestinationSecrets): BackupDestination {
	const id = randomUUID();
	const t = now();
	db()
		.prepare('INSERT INTO backup_destinations (id, name, kind, config, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
		.run(id, name, dest.kind, JSON.stringify(dest.config), seal(id, mergeSecrets({}, secrets)), t, t);
	return getDestination(id)!;
}

export function updateDestination(id: string, name: string, dest: DestinationConfig, secretsPatch: DestinationSecrets): BackupDestination | undefined {
	if (!getDestination(id)) return undefined;
	const secrets = mergeSecrets(getDestinationSecrets(id), secretsPatch);
	db()
		.prepare('UPDATE backup_destinations SET name = ?, kind = ?, config = ?, secret = ?, updated_at = ? WHERE id = ?')
		.run(name, dest.kind, JSON.stringify(dest.config), seal(id, secrets), now(), id);
	return getDestination(id);
}

export function deleteDestination(id: string): boolean {
	return Number(db().prepare('DELETE FROM backup_destinations WHERE id = ?').run(id).changes) > 0;
}

export function schedulesUsingDestination(id: string): number {
	return (db().prepare('SELECT count(*) AS n FROM backup_schedules WHERE destination_id = ?').get(id) as { n: number }).n;
}

// --- schedules -----------------------------------------------------------------

function toSchedule(r: Row): BackupSchedule {
	return {
		id: r.id as string,
		name: r.name as string,
		connectionId: (r.connection_id as string) ?? null,
		destinationId: r.destination_id as string,
		frequency: r.frequency as BackupSchedule['frequency'],
		minute: r.minute as number,
		hour: r.hour as number,
		weekday: r.weekday as number,
		keepLast: (r.keep_last as number) ?? null,
		keepDays: (r.keep_days as number) ?? null,
		compress: r.compress === 1,
		enabled: r.enabled === 1,
		lastRunAt: (r.last_run_at as string) ?? null,
		nextRunAt: (r.next_run_at as string) ?? null,
		createdAt: r.created_at as string,
		updatedAt: r.updated_at as string
	};
}

export function listSchedules(): BackupSchedule[] {
	return (db().prepare('SELECT * FROM backup_schedules ORDER BY name COLLATE NOCASE').all() as Row[]).map(toSchedule);
}

export function getSchedule(id: string): BackupSchedule | undefined {
	const r = db().prepare('SELECT * FROM backup_schedules WHERE id = ?').get(id) as Row | undefined;
	return r && toSchedule(r);
}

function scheduleValues(s: ScheduleInput) {
	return [
		s.name,
		s.connectionId,
		s.destinationId,
		s.frequency,
		s.minute,
		s.hour,
		s.weekday,
		s.keepLast,
		s.keepDays,
		s.compress ? 1 : 0,
		s.enabled ? 1 : 0,
		s.enabled ? nextRunAt(s, new Date()).toISOString() : null
	];
}

export function createSchedule(s: ScheduleInput): BackupSchedule {
	const id = randomUUID();
	const t = now();
	db()
		.prepare(
			`INSERT INTO backup_schedules (name, connection_id, destination_id, frequency, minute, hour, weekday, keep_last, keep_days, compress, enabled, next_run_at, id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(...scheduleValues(s), id, t, t);
	return getSchedule(id)!;
}

export function updateSchedule(id: string, s: ScheduleInput): BackupSchedule | undefined {
	db()
		.prepare(
			`UPDATE backup_schedules SET name = ?, connection_id = ?, destination_id = ?, frequency = ?, minute = ?, hour = ?, weekday = ?,
				keep_last = ?, keep_days = ?, compress = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?`
		)
		.run(...scheduleValues(s), now(), id);
	return getSchedule(id);
}

export function deleteSchedule(id: string): boolean {
	return Number(db().prepare('DELETE FROM backup_schedules WHERE id = ?').run(id).changes) > 0;
}

export function markScheduleRan(id: string, at: Date, next: Date | null) {
	db()
		.prepare('UPDATE backup_schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?')
		.run(at.toISOString(), next ? next.toISOString() : null, id);
}

// --- runs ----------------------------------------------------------------------

function toRun(r: Row): BackupRun {
	return {
		id: r.id as string,
		kind: r.kind as BackupRun['kind'],
		status: r.status as BackupRun['status'],
		trigger: r.trigger as BackupRun['trigger'],
		scheduleId: (r.schedule_id as string) ?? null,
		scheduleName: (r.schedule_name as string) ?? null,
		connectionId: (r.connection_id as string) ?? null,
		connectionName: r.connection_name as string,
		engine: r.engine as BackupRun['engine'],
		databases: JSON.parse((r.databases as string) || '[]'),
		allDatabases: r.all_databases === 1,
		destinationId: (r.destination_id as string) ?? null,
		destinationName: r.destination_name as string,
		fileName: (r.file_name as string) ?? null,
		format: (r.format as BackupRun['format']) ?? null,
		sizeBytes: (r.size_bytes as number) ?? null,
		startedAt: r.started_at as string,
		finishedAt: (r.finished_at as string) ?? null,
		durationMs: (r.duration_ms as number) ?? null,
		error: (r.error as string) ?? null,
		warnings: (r.warnings as string) ?? null,
		sourceRunId: (r.source_run_id as string) ?? null,
		deletedAt: (r.deleted_at as string) ?? null,
		createdBy: (r.created_by as string) ?? null
	};
}

export type NewRun = Pick<
	BackupRun,
	'kind' | 'trigger' | 'scheduleId' | 'scheduleName' | 'connectionId' | 'connectionName' | 'engine' | 'databases' | 'allDatabases' | 'destinationId' | 'destinationName' | 'fileName' | 'format' | 'sourceRunId' | 'createdBy'
>;

export function createRun(r: NewRun): BackupRun {
	const id = randomUUID();
	db()
		.prepare(
			`INSERT INTO backup_runs (id, kind, status, trigger, schedule_id, schedule_name, connection_id, connection_name, engine, databases, all_databases,
				destination_id, destination_name, file_name, format, source_run_id, created_by, started_at)
			 VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			id,
			r.kind,
			r.trigger,
			r.scheduleId,
			r.scheduleName,
			r.connectionId,
			r.connectionName,
			r.engine,
			JSON.stringify(r.databases),
			r.allDatabases ? 1 : 0,
			r.destinationId,
			r.destinationName,
			r.fileName,
			r.format,
			r.sourceRunId,
			r.createdBy,
			now()
		);
	return getRun(id)!;
}

export function finishRun(id: string, patch: { status: 'success' | 'failed'; sizeBytes?: number | null; error?: string | null; warnings?: string | null; databases?: string[] }) {
	const run = getRun(id);
	if (!run) return;
	const finished = new Date();
	db()
		.prepare(
			`UPDATE backup_runs SET status = ?, size_bytes = ?, error = ?, warnings = ?, finished_at = ?, duration_ms = ?, databases = ? WHERE id = ?`
		)
		.run(
			patch.status,
			patch.sizeBytes ?? null,
			patch.error ?? null,
			patch.warnings ?? null,
			finished.toISOString(),
			finished.getTime() - new Date(run.startedAt).getTime(),
			JSON.stringify(patch.databases ?? run.databases),
			id
		);
}

export function getRun(id: string): BackupRun | undefined {
	const r = db().prepare('SELECT * FROM backup_runs WHERE id = ?').get(id) as Row | undefined;
	return r && toRun(r);
}

export function listRuns(f: { connectionId?: string; limit?: number } = {}): BackupRun[] {
	const limit = Math.min(Math.max(f.limit ?? 200, 1), 1000);
	const rows = f.connectionId
		? db().prepare('SELECT * FROM backup_runs WHERE connection_id = ? ORDER BY started_at DESC LIMIT ?').all(f.connectionId, limit)
		: db().prepare('SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT ?').all(limit);
	return (rows as Row[]).map(toRun);
}

/** Successful backups of one connection made by one schedule (or ad hoc to one destination), for retention. */
export function retentionCandidates(scheduleId: string, connectionId: string): BackupRun[] {
	return (
		db()
			.prepare(
				`SELECT * FROM backup_runs WHERE kind = 'backup' AND status = 'success' AND deleted_at IS NULL
				 AND schedule_id = ? AND connection_id = ? ORDER BY started_at DESC`
			)
			.all(scheduleId, connectionId) as Row[]
	).map(toRun);
}

export function markRunDeleted(id: string) {
	db().prepare('UPDATE backup_runs SET deleted_at = ? WHERE id = ?').run(now(), id);
}

export function deleteRunRecord(id: string): boolean {
	return Number(db().prepare('DELETE FROM backup_runs WHERE id = ?').run(id).changes) > 0;
}

/** The newest successful backup per connection, for the overview cards. */
export function latestBackups(): Record<string, { at: string; sizeBytes: number | null; destinationName: string }> {
	const rows = db()
		.prepare(
			`SELECT connection_id, max(started_at) AS at, size_bytes, destination_name FROM backup_runs
			 WHERE kind = 'backup' AND status = 'success' AND deleted_at IS NULL AND connection_id IS NOT NULL GROUP BY connection_id`
		)
		.all() as Row[];
	return Object.fromEntries(
		rows.map((r) => [r.connection_id as string, { at: r.at as string, sizeBytes: (r.size_bytes as number) ?? null, destinationName: r.destination_name as string }])
	);
}

/** Keeps the run log bounded: failed runs and records of deleted files older than 90 days go. */
export function trimRunLog() {
	const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
	db().prepare(`DELETE FROM backup_runs WHERE started_at < ? AND (status = 'failed' OR deleted_at IS NOT NULL)`).run(cutoff);
}
