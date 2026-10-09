import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { addDefaultRules, listRules } from '#lib/server/alerts/store.ts';
import type { RequestHandler } from './$types';

/** Adds any missing default (all-connections) rules. */
export const POST: RequestHandler = handler(({ locals }) => {
	const added = addDefaultRules();
	if (added.length) audit(locals, 'alerts.rule.create', { detail: `added ${added.length} default rules` });
	return json({ added: added.length, rules: listRules() });
});
