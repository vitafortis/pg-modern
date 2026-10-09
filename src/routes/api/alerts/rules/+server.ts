import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { getConnection } from '#lib/server/store.ts';
import { audit } from '#lib/server/permissions.ts';
import { createRule, listRules } from '#lib/server/alerts/store.ts';
import { parseRuleInput } from '#lib/server/alerts/input.ts';
import { RULES } from '#lib/alerts.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = handler(() => json(listRules()));

export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const rule = createRule(parseRuleInput(await request.json().catch(() => null)));
	const conn = rule.connectionId ? getConnection(rule.connectionId) : undefined;
	audit(locals, 'alerts.rule.create', {
		connection: conn,
		detail: `${RULES[rule.kind].label} ${JSON.stringify(rule.params)}${rule.enabled ? '' : ' (disabled)'}`
	});
	return json(rule, { status: 201 });
});
