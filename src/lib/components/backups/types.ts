import type { BackupDestination, BackupRun, BackupSchedule } from '#lib/backups.ts';

export interface Tool {
	bin: string;
	version: string;
}

export interface BackupsData {
	tools: { pgDump: Tool | null; pgRestore: Tool | null; mysqlDump: Tool | null; mysqlClient: Tool | null };
	timeZone: string;
	destinations: (BackupDestination & { where: string })[];
	schedules: BackupSchedule[];
	runs: BackupRun[];
}
