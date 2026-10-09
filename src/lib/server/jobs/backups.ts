import { defineJob } from '../jobs.ts';
import { fireDueSchedules } from '../backups/runner.ts';

/** Checks backup schedules every minute; due ones start in the background, so a long dump never delays the next check. */
defineJob({
	name: 'backups',
	everyMs: 60_000,
	initialDelayMs: 20_000,
	run: async () => {
		fireDueSchedules();
	}
});
