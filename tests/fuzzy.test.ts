import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyMatch, fuzzyRank } from '../src/lib/fuzzy.ts';

const rank = (q: string, items: string[]) => fuzzyRank(q, items, (s) => [s]).map((r) => r.item);

test('every character must match in order', () => {
	assert.ok(fuzzyMatch('usr', 'users'));
	assert.equal(fuzzyMatch('usx', 'users'), null);
	assert.equal(fuzzyMatch('sru', 'users'), null);
	assert.deepEqual(fuzzyMatch('', 'anything'), { score: 0, indexes: [] });
});

test('exact beats prefix beats word start beats scattered', () => {
	assert.deepEqual(rank('order', ['reorder_log', 'order_items', 'orders', 'order', 'owner_reader']), ['order', 'orders', 'order_items', 'reorder_log', 'owner_reader']);
});

test('word starts and acronyms', () => {
	assert.deepEqual(rank('oi', ['position', 'order_items', 'ion']), ['order_items', 'position'], "'ion' has no i after its o");
	assert.equal(rank('ui', ['public.user_invites', 'public.audit'])[0], 'public.user_invites');
	assert.equal(rank('sq', ['SavedQuery', 'squash'])[0], 'squash', 'prefix still wins');
	assert.equal(rank('sq', ['SavedQuery', 'misquote'])[0], 'SavedQuery', 'camelCase humps count as word starts');
});

test('substring matches at a boundary rank above mid-word ones', () => {
	assert.equal(rank('log', ['catalog', 'audit_log', 'blogger'])[0], 'audit_log');
	assert.deepEqual(rank('log', ['blog_settings', 'catalog']), ['catalog', 'blog_settings'], 'the shorter of two mid-word matches');
});

test('shorter targets win ties', () => {
	assert.deepEqual(rank('acc', ['accounts_archive_2024', 'accounts']), ['accounts', 'accounts_archive_2024']);
});

test('boost reorders matches but never adds non-matches', () => {
	const items = [{ name: 'orders', recent: 0 }, { name: 'order_items', recent: 1 }, { name: 'users', recent: 5 }];
	const ranked = fuzzyRank('ord', items, (i) => [i.name], (i) => i.recent * 200).map((r) => r.item.name);
	assert.deepEqual(ranked, ['order_items', 'orders']);
});

test('secondary fields match with less weight', () => {
	const items = [{ name: 'Prod DB', host: 'pg.lan' }, { name: 'pg staging', host: 'stage.lan' }];
	const ranked = fuzzyRank('pg', items, (i) => [i.name, i.host]).map((r) => r.item.name);
	assert.deepEqual(ranked, ['pg staging', 'Prod DB']);
	// A scattered subsequence in a secondary field doesn't count ("posts" in "Postgres").
	const noise = fuzzyRank('posts', [{ name: 'dead', sub: 'Postgres · x' }, { name: 'posts', sub: 'public' }], (i) => [i.name, i.sub]);
	assert.deepEqual(noise.map((r) => r.item.name), ['posts']);
});

test('highlight indexes point at the matched characters', () => {
	const m = fuzzyMatch('ui', 'user_invites')!;
	assert.deepEqual(m.indexes, [0, 5]);
	const sub = fuzzyMatch('vite', 'user_invites')!;
	assert.deepEqual(sub.indexes, [7, 8, 9, 10]);
});
