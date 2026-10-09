/**
 * Runs backups and restores: dumps a connection with its stored credentials, streams
 * the output (gzipped for MySQL) to a destination, records the run and applies the
 * schedule's retention. Restores stream a stored dump back into pg_restore / mysql.
 */
import { createGunzip, createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { PassThrough, type Duplex, type Readable } from 'node:stream';
import { getConnection, getPassword, listConnections } from '../store.ts';
import { dumpFileName, isDue, restoreConfirmation, nextRunAt, selectForPruning, type BackupRun, type BackupSchedule, type DumpFormat } from '#lib/backups.ts';
import type { Connection } from '#lib/types.ts';
import { driverFor, type Driver } from './destinations.ts';
import * as store from './store.ts';
import {
	MissingTool,
	mysqlDumpCommand,
	mysqlPreflight,
	mysqlRestoreCommand,
	pgDumpCommand,
	pgRestoreCommand,
	requireTool,
	start,
	stripDefiners,
	toolStatus,
	type Command
} from './tools.ts';

/** Engines pg_dump / mysqldump can back up. */
export function supportsBackup(conn: Pick<Connection, 'engine'>): boolean {
	return conn.engine === 'postgres' || conn.engine === 'mysql';
}

// --- concurrency -------------------------------------------------------------------

/** At most two dumps or restores at once, so a schedule over many connections doesn't swamp the host. */
const MAX_PARALLEL = 2;
let active = 0;
const waiting: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
	if (active >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
	active++;
	try {
		return await fn();
	} finally {
		active--;
		waiting.shift()?.();
	}
}

function driverForId(destinationId: string): { driver: Driver; name: string } {
	const dest = store.getDestination(destinationId);
	if (!dest) throw new Error('The backup destination no longer exists');
	return { driver: driverFor(dest, store.getDestinationSecrets(destinationId)), name: dest.name };
}

function hint(engine: Connection['engine'], stderr: string): string {
	if (engine === 'postgres' && /server version mismatch|aborting because of server version mismatch/i.test(stderr)) {
		return `${stderr}\npg_dump must be at least as new as the server. Update the image, or install a newer PostgreSQL client.`;
	}
	if (engine === 'mysql' && /Access denied.*(EVENT|PROCESS|LOCK TABLES|SHOW VIEW|TRIGGER)/i.test(stderr)) {
		return `${stderr}\nThe connection's user needs SELECT, SHOW VIEW, TRIGGER, EVENT and LOCK TABLES on the database(s) to dump them.`;
	}
	return stderr;
}

// --- backup ------------------------------------------------------------------------

export interface BackupRequest {
	connectionId: string;
	destinationId: string;
	compress: boolean;
	schedule?: Pick<BackupSchedule, 'id' | 'name' | 'keepLast' | 'keepDays'>;
	createdBy: string | null;
}

/**
 * Starts a backup and returns its run record right away; the dump continues in the
 * background (`finished` settles when it's done, and never rejects).
 */
export function startBackup(req: BackupRequest): { run: BackupRun; finished: Promise<BackupRun> } {
	const conn = getConnection(req.connectionId);
	if (!conn) throw new Error('Connection not found');
	const dest = store.getDestination(req.destinationId);
	if (!dest) throw new Error('Destination not found');
	const format: DumpFormat = conn.engine === 'postgres' ? 'pg-custom' : req.compress ? 'mysql-sql-gz' : 'mysql-sql';
	const run = store.createRun({
		kind: 'backup',
		trigger: req.schedule ? 'schedule' : 'manual',
		scheduleId: req.schedule?.id ?? null,
		scheduleName: req.schedule?.name ?? null,
		connectionId: conn.id,
		connectionName: conn.name,
		engine: conn.engine,
		databases: conn.database ? [conn.database] : [],
		allDatabases: conn.engine === 'mysql' && !conn.database,
		destinationId: dest.id,
		destinationName: dest.name,
		fileName: dumpFileName(conn.name, format, new Date()),
		format,
		sourceRunId: null,
		createdBy: req.createdBy
	});
	const finished = slot(() => executeBackup(run, conn, req)).then(() => store.getRun(run.id)!);
	return { run, finished };
}

async function executeBackup(run: BackupRun, conn: Connection, req: BackupRequest): Promise<void> {
	let databases = run.databases;
	try {
		if (!supportsBackup(conn)) throw new Error(`Backups aren't supported for ${conn.engine} connections`);
		const tools = await toolStatus();
		const { driver } = driverForId(req.destinationId);
		const target = { ...conn, password: getPassword(conn.id) };
		let cmd: Command;
		if (conn.engine === 'postgres') {
			cmd = pgDumpCommand(requireTool(tools.pgDump, 'pg_dump'), target, req.compress);
		} else {
			const dump = requireTool(tools.mysqlDump, 'mysqldump (mariadb-dump)');
			const client = requireTool(tools.mysqlClient, 'The mysql client (mariadb)');
			const pre = await mysqlPreflight(client, target);
			if (!conn.database) {
				if (!pre.databases.length) throw new Error('The login sees no databases to back up');
				databases = pre.databases;
			}
			cmd = mysqlDumpCommand(dump, target, databases, pre.plain);
		}

		const proc = start(cmd, 'ignore');
		// Pipe stdout right away: Node drains (and drops) unread child output once the
		// process exits, which a quick dump can do before the destination has connected.
		const output = run.format === 'mysql-sql-gz' ? createGzip() : new PassThrough();
		proc.child.stdout!.pipe(output);
		let size = 0;
		let uploadError: unknown = null;
		try {
			size = await driver.put(run.fileName!, output);
		} catch (err) {
			uploadError = err;
			proc.child.kill();
		}
		const exit = await proc.done;
		if (exit.code !== 0 && !uploadError) {
			await driver.delete(run.fileName!).catch(() => {});
			throw new Error(hint(conn.engine, exit.stderr) || `${cmd.bin} exited with code ${exit.code ?? exit.signal}`);
		}
		if (uploadError) throw uploadError;
		if (!size) {
			await driver.delete(run.fileName!).catch(() => {});
			throw new Error(`${cmd.bin} produced no output${exit.stderr ? `: ${exit.stderr}` : ''}`);
		}
		store.finishRun(run.id, { status: 'success', sizeBytes: size, databases, warnings: exit.stderr || null });
	} catch (err) {
		store.finishRun(run.id, { status: 'failed', error: (err as Error).message, databases });
		console.error(`[backups] ${conn.name}: ${(err as Error).message}`);
		return;
	}
	if (req.schedule) await prune(req.schedule, conn.id);
}

/** Deletes backups the schedule's retention no longer keeps (files first, then marks the runs). */
export async function prune(schedule: Pick<BackupSchedule, 'id' | 'keepLast' | 'keepDays'>, connectionId: string): Promise<number> {
	const doomed = selectForPruning(store.retentionCandidates(schedule.id, connectionId), schedule, new Date());
	let removed = 0;
	for (const run of doomed) {
		try {
			await deleteRunFile(run);
			removed++;
		} catch (err) {
			console.error(`[backups] retention couldn't delete ${run.fileName}: ${(err as Error).message}`);
		}
	}
	store.trimRunLog();
	return removed;
}

export async function deleteRunFile(run: BackupRun): Promise<void> {
	if (run.kind === 'backup' && run.fileName && !run.deletedAt && run.destinationId && store.getDestination(run.destinationId)) {
		await driverForId(run.destinationId).driver.delete(run.fileName);
	}
	store.markRunDeleted(run.id);
}

/** Streams a stored dump. */
export async function openRunFile(run: BackupRun): Promise<{ stream: Readable; size: number | null }> {
	if (run.kind !== 'backup' || run.status !== 'success' || !run.fileName) throw new Error('This run has no backup file');
	if (run.deletedAt) throw new Error('This backup file was deleted');
	if (!run.destinationId) throw new Error('The backup destination no longer exists');
	return driverForId(run.destinationId).driver.get(run.fileName);
}

// --- schedules -----------------------------------------------------------------------

/** Backs up every connection a schedule covers, one after another (within the shared limit). */
export function runSchedule(schedule: BackupSchedule, createdBy: string | null): BackupRun[] {
	const conns = schedule.connectionId ? [getConnection(schedule.connectionId)].filter((c) => !!c) : listConnections().filter(supportsBackup);
	return conns.map(
		(c) => startBackup({ connectionId: c.id, destinationId: schedule.destinationId, compress: schedule.compress, schedule, createdBy }).run
	);
}

/** Called every minute: fires due schedules and moves their next run time on. */
export function fireDueSchedules(now = new Date()): BackupRun[] {
	const runs: BackupRun[] = [];
	for (const s of store.listSchedules()) {
		if (!isDue(s, now)) continue;
		store.markScheduleRan(s.id, now, nextRunAt(s, now));
		try {
			runs.push(...runSchedule(s, null));
		} catch (err) {
			console.error(`[backups] schedule ${s.name}: ${(err as Error).message}`);
		}
	}
	return runs;
}

// --- restore -------------------------------------------------------------------------

export interface RestoreRequest {
	run: BackupRun;
	target: Connection;
	createdBy: string | null;
}

/** Starts a restore in the background and returns its run record (kind "restore"). */
export function startRestore(req: RestoreRequest): { run: BackupRun; finished: Promise<BackupRun> } {
	const { run: source, target } = req;
	const restore = store.createRun({
		kind: 'restore',
		trigger: 'manual',
		scheduleId: null,
		scheduleName: null,
		connectionId: target.id,
		connectionName: target.name,
		engine: target.engine,
		databases: source.allDatabases ? source.databases : [target.database],
		allDatabases: source.allDatabases,
		destinationId: source.destinationId,
		destinationName: source.destinationName,
		fileName: source.fileName,
		format: source.format,
		sourceRunId: source.id,
		createdBy: req.createdBy
	});
	const finished = slot(() => executeRestore(restore, source, target)).then(() => store.getRun(restore.id)!);
	return { run: restore, finished };
}

async function executeRestore(restore: BackupRun, source: BackupRun, target: Connection): Promise<void> {
	try {
		const tools = await toolStatus();
		const creds = { ...target, password: getPassword(target.id) };
		let cmd: Command;
		if (target.engine === 'postgres') {
			cmd = pgRestoreCommand(requireTool(tools.pgRestore, 'pg_restore'), creds);
		} else {
			const client = requireTool(tools.mysqlClient, 'The mysql client (mariadb)');
			const pre = await mysqlPreflight(client, creds);
			cmd = mysqlRestoreCommand(client, creds, pre.plain);
		}
		const { stream } = await openRunFile(source);
		const proc = start(cmd, 'pipe');
		const stages: Duplex[] = [];
		if (source.format === 'mysql-sql-gz') stages.push(createGunzip());
		if (target.engine === 'mysql') stages.push(stripDefiners());
		let sourceComplete = false;
		(stages.at(-1) ?? stream).once('end', () => (sourceComplete = true));
		let streamError: unknown = null;
		await pipeline([stream, ...stages, proc.child.stdin!]).catch((err) => {
			streamError = err;
			stream.destroy();
		});
		const exit = await proc.done;
		if (target.engine === 'postgres' && exit.code === 1 && /errors ignored on restore/i.test(exit.stderr)) {
			// pg_restore keeps going past individual errors (missing roles, extensions): restored, with warnings.
			store.finishRun(restore.id, { status: 'success', warnings: exit.stderr });
			return;
		}
		if (exit.code !== 0) throw new Error(exit.stderr || `${cmd.bin} exited with code ${exit.code ?? exit.signal}`);
		// pg_restore may stop reading once it has what it needs, and validates its archive, so
		// a clean exit is enough. The mysql client must have been fed the whole dump.
		if (streamError && !(target.engine === 'postgres' || sourceComplete)) throw streamError;
		store.finishRun(restore.id, { status: 'success', warnings: exit.stderr || null });
	} catch (err) {
		store.finishRun(restore.id, { status: 'failed', error: (err as Error).message });
		console.error(`[backups] restore into ${target.name}: ${(err as Error).message}`);
	}
}

/** Problems that make a restore impossible regardless of who asks. */
export function restoreProblem(run: BackupRun, target: Connection): string | null {
	if (run.kind !== 'backup' || run.status !== 'success' || !run.fileName) return 'Only successful backups can be restored';
	if (run.deletedAt) return 'This backup file was deleted';
	if (run.engine !== target.engine) return `A ${run.engine} backup can't be restored into a ${target.engine} connection`;
	if (run.format !== 'pg-custom' && target.engine === 'postgres') return 'Unsupported backup format';
	// A single-database MySQL dump doesn't say which database to use.
	if (target.engine === 'mysql' && !run.allDatabases && !target.database) {
		return 'Set a default database on the target connection, so the dump knows where to go';
	}
	return null;
}

export { MissingTool, restoreConfirmation };
