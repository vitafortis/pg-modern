/** Line-based diff (LCS) for view and function definitions. Pure; used by the diff view. */

export interface DiffLine {
	op: 'same' | 'add' | 'del';
	text: string;
}

/** Above this many cells the LCS table gets too big; fall back to "all removed, all added". */
const MAX_CELLS = 4_000_000;

export function lineDiff(before: string | null | undefined, after: string | null | undefined): DiffLine[] {
	const a = (before ?? '').split('\n');
	const b = (after ?? '').split('\n');
	if (before == null || before === '') return after ? b.map((text) => ({ op: 'add', text })) : [];
	if (after == null || after === '') return a.map((text) => ({ op: 'del', text }));

	// Trim the common head and tail so only the changed middle needs the quadratic table.
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;

	const head: DiffLine[] = a.slice(0, start).map((text) => ({ op: 'same', text }));
	const tail: DiffLine[] = a.slice(endA).map((text) => ({ op: 'same', text }));
	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);

	if ((midA.length + 1) * (midB.length + 1) > MAX_CELLS) {
		return [...head, ...midA.map((text) => ({ op: 'del' as const, text })), ...midB.map((text) => ({ op: 'add' as const, text })), ...tail];
	}

	const n = midA.length;
	const m = midB.length;
	const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}
	const mid: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (midA[i] === midB[j]) mid.push({ op: 'same', text: midA[i] }), i++, j++;
		else if (lcs[i + 1][j] >= lcs[i][j + 1]) mid.push({ op: 'del', text: midA[i++] });
		else mid.push({ op: 'add', text: midB[j++] });
	}
	while (i < n) mid.push({ op: 'del', text: midA[i++] });
	while (j < m) mid.push({ op: 'add', text: midB[j++] });
	return [...head, ...mid, ...tail];
}
