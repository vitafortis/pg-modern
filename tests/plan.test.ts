import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlan, planText, visibleNodes, MISESTIMATE_FACTOR } from '../src/lib/plan.ts';

// Captured from Postgres 17 against scripts/screenshots/seed.sql.
const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'));
const analyzed = parsePlan(fixture('explain-analyze.json'));
const plain = parsePlan(fixture('explain-plain.json'));
const parallel = parsePlan(fixture('explain-parallel.json'));

const close = (a: number | null, b: number, msg?: string) => assert.ok(a != null && Math.abs(a - b) < 1e-6, `${msg ?? ''} expected ${b}, got ${a}`);

test('flattens the tree depth first with parents and depths', () => {
	assert.deepEqual(
		analyzed.nodes.map((n) => `${'  '.repeat(n.depth)}${n.nodeType}`),
		['Limit', '  Sort', '    GroupAggregate', '      Sort', '        Nested Loop', '          Seq Scan', '          Nested Loop', '            Seq Scan', '            Index Scan']
	);
	for (const n of analyzed.nodes.slice(1)) assert.equal(analyzed.nodes[n.parentId!].children.includes(n), true);
	assert.equal(analyzed.analyzed, true);
	assert.equal(plain.analyzed, false);
});

test('labels relations, aliases, indexes and join types', () => {
	const [, , , , loop, libraries, , media, index] = analyzed.nodes;
	assert.equal(libraries.target, 'public.libraries l');
	assert.equal(media.target, 'public.media m');
	assert.equal(index.target, 'using media_pkey on public.media');
	assert.deepEqual(loop.tags, ['Inner']);
	assert.equal(index.relationship, 'Inner');
	assert.ok(media.details.some((d) => d.label === 'Filter' && d.value.includes("kind = 'book'")));
	assert.ok(index.details.some((d) => d.label === 'Index Cond'));
	assert.ok(analyzed.nodes[1].details.some((d) => d.label === 'Sort Key' && d.value === '(count(*)) DESC'));
	assert.equal(media.rowsRemovedByFilter, 4560);
	assert.equal(media.sharedHit, 115);
});

test('exclusive time is node time × loops minus its children', () => {
	for (const n of analyzed.nodes) {
		const raw = n.raw as Record<string, number>;
		const inclusive = raw['Actual Total Time'] * raw['Actual Loops'];
		close(n.inclusiveMs, inclusive, n.nodeType);
		const children = n.children.reduce((s, c) => s + (c.inclusiveMs ?? 0), 0);
		close(n.exclusiveMs, Math.max(0, inclusive - children), n.nodeType);
	}
	// The index scan runs 240 times; its time counts every loop.
	const index = analyzed.nodes[8];
	assert.equal(index.loops, 240);
	close(index.inclusiveMs, (index.raw['Actual Total Time'] as number) * 240);
});

test('shares add up to one and the slowest node is flagged', () => {
	for (const s of [analyzed, plain, parallel]) {
		close(s.nodes.reduce((sum, n) => sum + n.share, 0), 1);
		assert.equal(s.nodes.filter((n) => n.slowest).length, 1);
		const top = s.nodes.reduce((a, b) => (b.share > a.share ? b : a));
		assert.equal(s.slowestId, top.id);
	}
	// Without ANALYZE the bars are cost-based.
	const seq = plain.nodes.find((n) => n.target === 'public.media m')!;
	close(seq.exclusiveCost, seq.totalCost);
	assert.equal(seq.exclusiveMs, null);
});

test('flags row estimates off by 10× or more', () => {
	const media = analyzed.nodes[7];
	assert.equal(media.planRows, 12);
	assert.equal(media.actualRows, 240);
	assert.equal(media.estimateFactor, 20);
	assert.equal(media.estimateDirection, 'under');
	assert.equal(media.misestimated, true);
	const libraries = analyzed.nodes[5];
	assert.equal(libraries.misestimated, false);
	assert.ok(analyzed.misestimates >= 1);
	assert.ok(analyzed.nodes.filter((n) => n.misestimated).every((n) => n.estimateFactor! >= MISESTIMATE_FACTOR));
	assert.equal(plain.misestimates, 0);
});

test('summary: timings, rows, settings', () => {
	assert.ok(analyzed.planningMs! > 0 && analyzed.executionMs! > 0);
	assert.equal(analyzed.totalRows, 1);
	assert.equal(analyzed.settings.enable_mergejoin, 'off');
	assert.equal(plain.executionMs, null);
	assert.equal(plain.totalCost, plain.root.totalCost);
});

test('parallel workers are not double counted; JIT is reported', () => {
	const gather = parallel.nodes.find((n) => n.nodeType === 'Gather Merge')!;
	const sort = gather.children[0];
	assert.equal(sort.loops, 3);
	// Three processes worked side by side: wall time is the per-loop average, not × 3.
	close(sort.inclusiveMs, sort.actualTotalMs!);
	assert.ok(gather.exclusiveMs! <= gather.inclusiveMs!);
	assert.ok(parallel.jit && parallel.jit.functions! > 0 && parallel.jit.totalMs! > 0);
	assert.ok(gather.notes.includes('2 of 2 workers'));
});

test('handles triggers, never-executed nodes, and text input', () => {
	const s = parsePlan(
		JSON.stringify([
			{
				Plan: {
					'Node Type': 'ModifyTable',
					Operation: 'Update',
					'Relation Name': 'libraries',
					Alias: 'libraries',
					'Startup Cost': 0,
					'Total Cost': 1.05,
					'Plan Rows': 0,
					'Actual Startup Time': 0.1,
					'Actual Total Time': 0.2,
					'Actual Rows': 0,
					'Actual Loops': 1,
					Plans: [
						{
							'Node Type': 'Seq Scan',
							'Parent Relationship': 'Outer',
							'Relation Name': 'libraries',
							Alias: 'libraries',
							'Startup Cost': 0,
							'Total Cost': 1.04,
							'Plan Rows': 4,
							'Actual Startup Time': 0,
							'Actual Total Time': 0,
							'Actual Rows': 0,
							'Actual Loops': 0
						}
					]
				},
				Triggers: [{ 'Trigger Name': 't', Relation: 'libraries', Time: 1.6, Calls: 4 }],
				'Execution Time': 2
			}
		])
	);
	assert.equal(s.root.nodeType, 'Update');
	assert.equal(s.root.target, 'libraries');
	assert.equal(s.nodes[1].neverExecuted, true);
	assert.equal(s.nodes[1].estimateFactor, null);
	assert.deepEqual(s.triggers, [{ name: 't', relation: 'libraries', ms: 1.6, calls: 4 }]);
	assert.throws(() => parsePlan({ nope: true }));
});

test('collapsing hides descendants; text export reads like EXPLAIN', () => {
	assert.equal(visibleNodes(analyzed, new Set()).length, analyzed.nodes.length);
	assert.deepEqual(
		visibleNodes(analyzed, new Set([2])).map((n) => n.nodeType),
		['Limit', 'Sort', 'GroupAggregate']
	);
	const text = planText(analyzed);
	assert.match(text, /^Limit {2}\(cost=/);
	assert.match(text, /->  Index Scan using media_pkey on public\.media .*loops=240\)/);
	assert.match(text, /Execution Time: /);
});
