import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { NotFound } from '#lib/server/engine.ts';
import { getConnection } from '#lib/server/store.ts';
import { audit } from '#lib/server/permissions.ts';
import { deleteRule, getRule, updateRule } from '#lib/server/alerts/store.ts';
import { parseRuleInput } from '#lib/server/alerts/input.ts';
import { RULES } from '#lib/alerts.ts';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = handler(async ({ params, request, locals }) => {
	if (!getRule(params.id)) throw new NotFound('Rule not found');
	const rule = updateRule(params.id, parseRuleInput(await request.json().catch(() => null)))!;
	const conn = rule.connectionId ? getConnection(rule.connectionId) : undefined;
	audit(locals, 'alerts.rule.update', {
		connection: conn,
		detail: `${RULES[rule.kind].label} ${JSON.stringify(rule.params)}${rule.enabled ? '' : ' (disabled)'}`
	});
	return json(rule);
});

export const DELETE: RequestHandler = handler(({ params, locals }) => {
	const rule = getRule(params.id);
	if (!rule || !deleteRule(params.id)) throw new NotFound('Rule not found');
	const conn = rule.connectionId ? getConnection(rule.connectionId) : undefined;
	audit(locals, 'alerts.rule.delete', { connection: conn, detail: RULES[rule.kind].label });
	return json({ ok: true });
});
