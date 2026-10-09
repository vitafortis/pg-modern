import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutDiagram } from '../src/lib/client/diagram-layout.ts';
import type { DiagramTable, SchemaDiagram } from '../src/lib/types.ts';

const table = (name: string, cols: string[], schema = 'public'): DiagramTable => ({
	schema,
	name,
	kind: 'table',
	columns: cols.map((c, i) => ({ name: c, type: i ? 'text' : 'bigint', nullable: i > 0, isPrimaryKey: i === 0 }))
});

const demo: SchemaDiagram = {
	schema: 'public',
	truncated: false,
	tables: [
		table('users', ['id', 'email', 'name']),
		table('orders', ['id', 'user_id', 'note']),
		table('items', ['id', 'order_id', 'sku', 'parent_id']),
		table('lonely', ['id', 'x']),
		table('also_lonely', ['id']),
		{ ...table('accounts', ['id'], 'auth'), external: true }
	],
	foreignKeys: [
		{ name: 'orders_user_fk', fromSchema: 'public', fromTable: 'orders', fromColumns: ['user_id'], toSchema: 'public', toTable: 'users', toColumns: ['id'] },
		{ name: 'items_order_fk', fromSchema: 'public', fromTable: 'items', fromColumns: ['order_id'], toSchema: 'public', toTable: 'orders', toColumns: ['id'] },
		{ name: 'items_parent_fk', fromSchema: 'public', fromTable: 'items', fromColumns: ['parent_id'], toSchema: 'public', toTable: 'items', toColumns: ['id'] },
		{ name: 'users_account_fk', fromSchema: 'public', fromTable: 'users', fromColumns: ['id'], toSchema: 'auth', toTable: 'accounts', toColumns: ['id'] }
	]
};

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
	a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('lays out related tables left to right, referenced tables first', () => {
	const { nodes, edges } = layoutDiagram(demo);
	const at = (n: string) => nodes.find((x) => x.table.name === n)!;
	assert.ok(at('accounts').x < at('users').x);
	assert.ok(at('users').x < at('orders').x);
	assert.ok(at('orders').x < at('items').x);
	assert.equal(edges.length, 4);
	assert.equal(at('accounts').title, 'auth.accounts');
	for (const a of nodes) for (const b of nodes) if (a !== b) assert.ok(!overlaps(a, b), `${a.key} overlaps ${b.key}`);
});

test('puts unrelated tables in a grid outside the graph', () => {
	const { nodes } = layoutDiagram(demo);
	const related = nodes.filter((n) => !n.isolated);
	const lonely = nodes.filter((n) => n.isolated).map((n) => n.table.name);
	assert.deepEqual(lonely.sort(), ['also_lonely', 'lonely']);
	const bottom = Math.max(...related.map((n) => n.y + n.height));
	const right = Math.max(...related.map((n) => n.x + n.width));
	for (const n of nodes.filter((n) => n.isolated)) assert.ok(n.y > bottom || n.x > right);
});

test('compact mode keeps only key columns', () => {
	const { nodes } = layoutDiagram(demo, { compact: true });
	const items = nodes.find((n) => n.table.name === 'items')!;
	assert.deepEqual(items.rows.map((r) => r.name), ['id', 'order_id', 'parent_id']);
	assert.equal(items.hidden, 1);
	assert.ok(items.rows.find((r) => r.name === 'order_id')!.isForeignKey);
});

test('handles an empty schema', () => {
	const l = layoutDiagram({ schema: 'x', tables: [], foreignKeys: [], truncated: false });
	assert.deepEqual(l.nodes, []);
	assert.equal(l.bounds.width, 0);
});
