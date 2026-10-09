/**
 * A small fuzzy matcher for the command palette: every query character must appear in
 * order. Scores favour, in order: exact match, prefix, matches at word starts
 * (after space, `.`, `_`, `-`, `/` or a camelCase hump), consecutive runs, and
 * shorter targets. Pure; shared by the browser and tests.
 */

export interface FuzzyMatch {
	score: number;
	/** Indexes in the target that matched, for highlighting. */
	indexes: number[];
}

const BOUNDARY = /[\s._\-/:()·]/;

function isWordStart(target: string, i: number): boolean {
	if (i === 0) return true;
	const prev = target[i - 1];
	if (BOUNDARY.test(prev)) return true;
	return prev === prev.toLowerCase() && target[i] !== target[i].toLowerCase();
}

/**
 * Walks the query through the target left to right. With `preferWordStarts`, each
 * character jumps to its next word-start occurrence when there is one (unless it can
 * continue a run); that can skip past characters a later one needs, so the caller
 * retries without it.
 */
function subsequence(q: string, t: string, target: string, preferWordStarts: boolean): { indexes: number[]; score: number; allWordStarts: boolean } | null {
	const indexes: number[] = [];
	let score = 0;
	let ti = 0;
	let prevMatch = -2;
	let allWordStarts = true;
	for (const ch of q) {
		if (ch === ' ') continue;
		let found = -1;
		if (ti < t.length && t[ti] === ch && prevMatch === ti - 1) found = ti;
		else if (preferWordStarts) {
			for (let k = ti; k < t.length; k++) {
				if (t[k] === ch && isWordStart(target, k)) {
					found = k;
					break;
				}
			}
		}
		if (found === -1) found = t.indexOf(ch, ti);
		if (found === -1) return null;
		const start = isWordStart(target, found);
		if (found === prevMatch + 1) score += 15;
		else if (!start) allWordStarts = false;
		if (start) score += 30;
		score -= Math.min(found - ti, 10);
		indexes.push(found);
		prevMatch = found;
		ti = found + 1;
	}
	return { indexes, score, allWordStarts };
}

/**
 * Best match of `query` in `target`, or null when not every character matches in order.
 * Tiers: exact (1000), prefix (900), substring at a word start (700), every character
 * at a word start or continuing a run, like `oi` → `order_items` (500), substring
 * mid-word (300), anything else (≤ 250). Shorter targets win within a tier.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
	const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
	if (!q) return { score: 0, indexes: [] };
	const t = target.toLowerCase();
	const lengthPenalty = Math.min(target.length * 0.5, 60);
	const run = (from: number) => [...q].map((_, i) => from + i);

	if (t === q) return { score: 1000, indexes: run(0) };
	const sub = t.indexOf(q);
	if (sub === 0) return { score: 900 - lengthPenalty, indexes: run(0) };
	if (sub > 0) {
		// Prefer an occurrence at a word start, if any.
		let at = sub;
		while (at !== -1 && !isWordStart(target, at)) at = t.indexOf(q, at + 1);
		if (at !== -1) return { score: 700 - lengthPenalty - Math.min(at, 40) * 0.5, indexes: run(at) };
	}
	const m = subsequence(q, t, target, true) ?? subsequence(q, t, target, false);
	if (m?.allWordStarts) return { score: 500 + m.score * 0.1 - lengthPenalty, indexes: m.indexes };
	if (sub > 0) return { score: 300 - lengthPenalty - Math.min(sub, 40) * 0.5, indexes: run(sub) };
	if (!m) return null;
	return { score: Math.min(m.score, 250) - lengthPenalty, indexes: m.indexes };
}

/**
 * Ranks items by their best-matching field. `boost` adds to the score (recency, kind);
 * it only reorders matches, it never makes a non-match appear.
 */
export function fuzzyRank<T>(query: string, items: T[], fields: (item: T) => string[], boost: (item: T) => number = () => 0): { item: T; score: number; indexes: number[] }[] {
	const out: { item: T; score: number; indexes: number[] }[] = [];
	for (const item of items) {
		let best: FuzzyMatch | null = null;
		let first = true;
		for (const f of fields(item)) {
			const m = fuzzyMatch(query, f);
			const primary = first;
			first = false;
			// Secondary fields (descriptions, hosts) only count for substring or word-start
			// matches, and for less: a scattered subsequence there ("posts" in "Postgres") is noise.
			if (!m || (!primary && m.score < 250)) continue;
			if (!primary) m.score -= 50;
			if (!best || m.score > best.score) best = primary ? m : { score: m.score, indexes: [] };
		}
		if (best) out.push({ item, score: best.score + boost(item), indexes: best.indexes });
	}
	return out.sort((a, b) => b.score - a.score);
}
