import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { latestBackups } from '#lib/server/backups/store.ts';
import type { RequestHandler } from './$types';

/** The newest successful backup per connection id (for the overview cards). */
export const GET: RequestHandler = handler(() => json(latestBackups()));
