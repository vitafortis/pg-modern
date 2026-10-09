/**
 * Scheduled database backups: types and pure helpers shared by the server, the
 * browser and the tests (no server-only imports).
 */
import type { Engine } from './types.ts';

// --- destinations --------------------------------------------------------------

export type DestinationKind = 'local' | 'sftp' | 's3';

export interface LocalConfig {
	/** Absolute folder inside the container, e.g. /backups (an NFS/CIFS volume). */
	path: string;
}

export interface SftpConfig {
	host: string;
	port: number;
	user: string;
	/** Folder on the server; created if missing. */
	path: string;
	/** Optional pinned host key, `SHA256:…` as printed by `ssh-keygen -lf`. Empty = trust on any key. */
	hostKey: string;
}

export interface S3Config {
	/** https://minio.lan:9000, https://s3.eu-central-1.amazonaws.com, … */
	endpoint: string;
	region: string;
	bucket: string;
	/** Key prefix ("folder"), e.g. `pg-modern/`. */
	prefix: string;
	accessKeyId: string;
	/** Path-style URLs (endpoint/bucket/key): needed by MinIO, Garage and most NAS servers. */
	pathStyle: boolean;
}

export type DestinationConfig =
	| { kind: 'local'; config: LocalConfig }
	| { kind: 'sftp'; config: SftpConfig }
	| { kind: 's3'; config: S3Config };

/** Secrets never leave the server; the browser only sees which are set. */
export interface DestinationSecrets {
	password?: string;
	privateKey?: string;
	passphrase?: string;
	secretAccessKey?: string;
}

export type BackupDestination = DestinationConfig & {
	id: string;
	name: string;
	hasPassword: boolean;
	hasPrivateKey: boolean;
	hasPassphrase: boolean;
	hasSecretKey: boolean;
	createdAt: string;
	updatedAt: string;
};

/** Where a destination writes, for display. */
export function describeDestination(d: DestinationConfig): string {
	if (d.kind === 'local') return d.config.path;
	if (d.kind === 'sftp') {
		const port = d.config.port && d.config.port !== 22 ? `:${d.config.port}` : '';
		return `sftp://${d.config.user}@${d.config.host}${port}/${d.config.path.replace(/^\/+/, '')}`;
	}
	return `s3://${d.config.bucket}/${d.config.prefix.replace(/^\/+/, '')}`;
}

// --- schedules -----------------------------------------------------------------

export type Frequency = 'hourly' | 'daily' | 'weekly';

export interface ScheduleTiming {
	frequency: Frequency;
	/** 0–59 */
	minute: number;
	/** 0–23 (daily, weekly) */
	hour: number;
	/** 0 = Sunday … 6 = Saturday (weekly) */
	weekday: number;
}

export interface RetentionPolicy {
	/** Keep the newest N successful backups. */
	keepLast: number | null;
	/** Keep successful backups younger than N days. */
	keepDays: number | null;
}

export interface BackupSchedule extends ScheduleTiming, RetentionPolicy {
	id: string;
	name: string;
	/** null = every connection that supports backups */
	connectionId: string | null;
	destinationId: string;
	/** gzip for MySQL/MariaDB; Postgres custom-format dumps are always compressed by pg_dump unless this is off. */
	compress: boolean;
	enabled: boolean;
	lastRunAt: string | null;
	nextRunAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export type ScheduleInput = Omit<BackupSchedule, 'id' | 'lastRunAt' | 'nextRunAt' | 'createdAt' | 'updatedAt'>;

// --- runs ----------------------------------------------------------------------

export type RunStatus = 'running' | 'success' | 'failed';
export type RunKind = 'backup' | 'restore';
/** `pg-custom`: pg_dump -Fc; `mysql-sql(.gz)`: mysqldump output. */
export type DumpFormat = 'pg-custom' | 'mysql-sql' | 'mysql-sql-gz';

export interface BackupRun {
	id: string;
	kind: RunKind;
	status: RunStatus;
	trigger: 'schedule' | 'manual';
	scheduleId: string | null;
	scheduleName: string | null;
	connectionId: string | null;
	connectionName: string;
	engine: Engine;
	/** The database(s) dumped, or the target database of a restore. */
	databases: string[];
	/** A MySQL dump of every database (`--databases`), which recreates and selects each one itself. */
	allDatabases: boolean;
	destinationId: string | null;
	destinationName: string;
	/** Object key / path relative to the destination's folder. */
	fileName: string | null;
	format: DumpFormat | null;
	sizeBytes: number | null;
	startedAt: string;
	finishedAt: string | null;
	durationMs: number | null;
	error: string | null;
	/** Non-fatal output, e.g. pg_restore's "errors ignored on restore". */
	warnings: string | null;
	/** For restores: the backup run that was restored. */
	sourceRunId: string | null;
	/** Set once retention or a user deleted the file; the record stays for history. */
	deletedAt: string | null;
	createdBy: string | null;
}

// --- schedule timing -------------------------------------------------------------

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (n: number) => String(n).padStart(2, '0');

export function describeTiming(t: ScheduleTiming): string {
	if (t.frequency === 'hourly') return t.minute === 0 ? 'Every hour, on the hour' : `Every hour at :${pad(t.minute)}`;
	const time = `${pad(t.hour)}:${pad(t.minute)}`;
	if (t.frequency === 'daily') return `Daily at ${time}`;
	return `${WEEKDAYS[t.weekday] ?? '?'}s at ${time}`;
}

export function describeRetention(r: RetentionPolicy): string {
	const parts: string[] = [];
	if (r.keepLast) parts.push(`last ${r.keepLast}`);
	if (r.keepDays) parts.push(`${r.keepDays} day${r.keepDays === 1 ? '' : 's'}`);
	return parts.length ? `Keep ${parts.join(' + ')}` : 'Keep everything';
}

/**
 * The first time strictly after `after` that matches the schedule, in the server's
 * local time zone (set TZ on the container). Across a DST change, a time that
 * doesn't exist that day runs at the shifted wall-clock time instead of being skipped.
 */
export function nextRunAt(t: ScheduleTiming, after: Date): Date {
	const d = new Date(after.getTime());
	d.setSeconds(0, 0);
	if (t.frequency === 'hourly') {
		d.setMinutes(t.minute);
		while (d.getTime() <= after.getTime()) d.setHours(d.getHours() + 1, t.minute, 0, 0);
		return d;
	}
	d.setHours(t.hour, t.minute, 0, 0);
	if (t.frequency === 'daily') {
		while (d.getTime() <= after.getTime()) {
			d.setDate(d.getDate() + 1);
			d.setHours(t.hour, t.minute, 0, 0);
		}
		return d;
	}
	// weekly
	const days = (t.weekday - d.getDay() + 7) % 7;
	d.setDate(d.getDate() + days);
	d.setHours(t.hour, t.minute, 0, 0);
	while (d.getTime() <= after.getTime()) {
		d.setDate(d.getDate() + 7);
		d.setHours(t.hour, t.minute, 0, 0);
	}
	return d;
}

/** Whether a schedule should fire now: enabled and its next run time has passed (missed runs fire once). */
export function isDue(s: Pick<BackupSchedule, 'enabled' | 'nextRunAt'>, now: Date): boolean {
	return s.enabled && !!s.nextRunAt && new Date(s.nextRunAt).getTime() <= now.getTime();
}

// --- retention -------------------------------------------------------------------

/**
 * The successful backups retention removes. A backup is kept if *any* rule keeps it
 * (newest `keepLast`, or younger than `keepDays`); with no rules everything is kept.
 * The newest successful backup is always kept, so a long outage never prunes the last good copy.
 */
export function selectForPruning<R extends Pick<BackupRun, 'id' | 'status' | 'startedAt'>>(
	runs: R[],
	policy: RetentionPolicy,
	now: Date
): R[] {
	const keepLast = policy.keepLast && policy.keepLast > 0 ? policy.keepLast : null;
	const keepDays = policy.keepDays && policy.keepDays > 0 ? policy.keepDays : null;
	if (!keepLast && !keepDays) return [];
	const ok = runs.filter((r) => r.status === 'success').sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	const cutoff = keepDays ? now.getTime() - keepDays * 86_400_000 : null;
	return ok.filter((r, i) => {
		if (i === 0) return false;
		if (keepLast && i < keepLast) return false;
		if (cutoff !== null && new Date(r.startedAt).getTime() >= cutoff) return false;
		return true;
	});
}

/** What the person must type to confirm a restore: the database it overwrites (the connection name for every-database dumps). */
export function restoreConfirmation(run: Pick<BackupRun, 'allDatabases'>, target: { database: string; name: string }): string {
	return (!run.allDatabases && target.database) || target.name;
}

// --- file names ------------------------------------------------------------------

/** A file-name-safe version of a connection name. */
export function slug(name: string): string {
	const s = name
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^[-.]+|[-.]+$/g, '')
		.slice(0, 60);
	return s || 'connection';
}

export function dumpExtension(format: DumpFormat): string {
	return format === 'pg-custom' ? '.dump' : format === 'mysql-sql-gz' ? '.sql.gz' : '.sql';
}

/** `nextcloud-db/nextcloud-db-20261009-030000.sql.gz`, one folder per connection. */
export function dumpFileName(connectionName: string, format: DumpFormat, at: Date): string {
	const s = slug(connectionName);
	const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
	return `${s}/${s}-${stamp}${dumpExtension(format)}`;
}

/** Relative keys we generate: folder/file of safe characters, no `..`. */
export function isSafeKey(key: string): boolean {
	return /^[a-z0-9._-]+(\/[a-z0-9._-]+)*$/i.test(key) && !key.split('/').some((p) => p === '.' || p === '..');
}
