/**
 * Turns `EXPLAIN (FORMAT JSON, …)` output into a tree the plan view can render:
 * readable labels, per-node exclusive ("self") time and cost, row misestimates,
 * and each node's share of the whole. Pure, so it runs in the browser and in tests.
 */

/** One node of Postgres' JSON plan; only the keys we read are typed. */
export interface RawPlanNode {
	'Node Type': string;
	Plans?: RawPlanNode[];
	[key: string]: unknown;
}

export interface RawExplain {
	Plan: RawPlanNode;
	'Planning Time'?: number;
	'Execution Time'?: number;
	Triggers?: { 'Trigger Name': string; Relation?: string; Time?: number; Calls?: number }[];
	JIT?: { Functions?: number; Timing?: Record<string, unknown> };
	Settings?: Record<string, string>;
	[key: string]: unknown;
}

export interface PlanDetail {
	label: string;
	value: string;
}

export interface PlanNode {
	id: number;
	depth: number;
	parentId: number | null;
	children: PlanNode[];
	nodeType: string;
	/** What the node works on, e.g. `public.media m` or `using media_pkey on public.media`. */
	target: string | null;
	/** Join type, scan direction, aggregate strategy, partial mode… */
	tags: string[];
	/** How the node hangs off its parent: Outer, Inner, InitPlan, SubPlan… */
	relationship: string | null;
	subplanName: string | null;
	startupCost: number;
	totalCost: number;
	planRows: number;
	/** Present only with ANALYZE. Rows and times are per loop, as Postgres reports them. */
	actualRows: number | null;
	loops: number | null;
	actualStartupMs: number | null;
	actualTotalMs: number | null;
	/** Wall time spent in this node and below, over every loop. */
	inclusiveMs: number | null;
	/** Wall time spent in this node alone. */
	exclusiveMs: number | null;
	/** Total cost minus the children's total cost. */
	exclusiveCost: number;
	neverExecuted: boolean;
	/** How far off the row estimate was (≥ 1), and in which direction. */
	estimateFactor: number | null;
	estimateDirection: 'over' | 'under' | null;
	misestimated: boolean;
	sharedHit: number | null;
	sharedRead: number | null;
	rowsRemovedByFilter: number | null;
	rowsRemovedByJoinFilter: number | null;
	rowsRemovedByRecheck: number | null;
	/** Conditions, keys and the like, shown as monospace lines. */
	details: PlanDetail[];
	/** Short extra facts: sort method, hash buckets, workers… */
	notes: string[];
	/** Share (0–1) of total exclusive time (analyzed) or exclusive cost (plain). */
	share: number;
	slowest: boolean;
	raw: RawPlanNode;
}

export interface PlanSummary {
	analyzed: boolean;
	root: PlanNode;
	/** Every node, depth first (the order they're shown in). */
	nodes: PlanNode[];
	planningMs: number | null;
	executionMs: number | null;
	totalCost: number;
	/** Rows the top node returned (or is estimated to). */
	totalRows: number;
	triggers: { name: string; relation: string | null; ms: number | null; calls: number | null }[];
	jit: { functions: number | null; totalMs: number | null } | null;
	/** Non-default planner settings, from the SETTINGS option. */
	settings: Record<string, string>;
	slowestId: number | null;
	misestimates: number;
}

/** Row estimates this many times off (either way) are flagged. */
export const MISESTIMATE_FACTOR = 10;

const DETAIL_KEYS: [string, string][] = [
	['Index Cond', 'Index Cond'],
	['Recheck Cond', 'Recheck Cond'],
	['Hash Cond', 'Hash Cond'],
	['Merge Cond', 'Merge Cond'],
	['Join Filter', 'Join Filter'],
	['Filter', 'Filter'],
	['One-Time Filter', 'One-Time Filter'],
	['TID Cond', 'TID Cond'],
	['Sort Key', 'Sort Key'],
	['Presorted Key', 'Presorted Key'],
	['Group Key', 'Group Key'],
	['Cache Key', 'Cache Key'],
	['Hash Key', 'Hash Key'],
	['Function Call', 'Function Call'],
	['Output', 'Output']
];

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function detailValue(v: unknown): string | null {
	if (Array.isArray(v)) return v.length ? v.map(String).join(', ') : null;
	if (typeof v === 'string') return v || null;
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	return null;
}

/** Accepts the JSON array EXPLAIN returns, a single element of it, or its text. */
export function normalizeExplain(input: unknown): RawExplain {
	let v = input;
	if (typeof v === 'string') v = JSON.parse(v);
	if (Array.isArray(v)) v = v[0];
	// Some drivers hand back the row ({ "QUERY PLAN": [...] }).
	if (v && typeof v === 'object' && 'QUERY PLAN' in v) return normalizeExplain((v as Record<string, unknown>)['QUERY PLAN']);
	if (!v || typeof v !== 'object' || !('Plan' in v)) throw new Error('Not an EXPLAIN (FORMAT JSON) result');
	return v as RawExplain;
}

function target(raw: RawPlanNode): string | null {
	const rel = str(raw['Relation Name']);
	const schema = str(raw.Schema);
	const alias = str(raw.Alias);
	const index = str(raw['Index Name']);
	const parts: string[] = [];
	if (index) parts.push(`using ${index}`);
	if (rel) {
		const qualified = schema ? `${schema}.${rel}` : rel;
		parts.push(`${index ? 'on ' : ''}${qualified}${alias && alias !== rel ? ` ${alias}` : ''}`);
	} else if (str(raw['CTE Name'])) {
		parts.push(`${raw['CTE Name']}${alias && alias !== raw['CTE Name'] ? ` ${alias}` : ''}`);
	} else if (str(raw['Function Name'])) {
		parts.push(`${raw['Function Name']}()${alias ? ` ${alias}` : ''}`);
	} else if (alias && !index) {
		parts.push(alias);
	}
	return parts.length ? parts.join(' ') : null;
}

function nodeTypeLabel(raw: RawPlanNode): string {
	const type = raw['Node Type'];
	if (type === 'Aggregate') {
		const strategy = str(raw.Strategy);
		const prefix = strategy === 'Sorted' ? 'Group' : strategy === 'Hashed' ? 'Hash' : strategy === 'Mixed' ? 'Mixed' : '';
		return `${prefix}Aggregate`;
	}
	if (type === 'ModifyTable' && str(raw.Operation)) return String(raw.Operation);
	if (type === 'SetOp' && str(raw.Command)) return `${raw.Strategy === 'Hashed' ? 'HashSetOp' : 'SetOp'} ${raw.Command}`;
	return type;
}

function tags(raw: RawPlanNode): string[] {
	const out: string[] = [];
	const join = str(raw['Join Type']);
	if (join && join !== 'Inner') out.push(join);
	else if (join) out.push('Inner');
	if (str(raw['Partial Mode']) && raw['Partial Mode'] !== 'Simple') out.push(String(raw['Partial Mode']));
	if (raw['Scan Direction'] === 'Backward') out.push('Backward');
	if (raw['Parallel Aware'] === true) out.push('Parallel');
	return out;
}

function notes(raw: RawPlanNode): string[] {
	const out: string[] = [];
	if (str(raw['Sort Method'])) {
		const space = num(raw['Sort Space Used']);
		out.push(`${raw['Sort Method']}${space != null ? ` · ${space} kB ${String(raw['Sort Space Type'] ?? '').toLowerCase()}` : ''}`.trim());
	}
	if (num(raw['Hash Buckets']) != null) {
		const peak = num(raw['Peak Memory Usage']);
		out.push(`${raw['Hash Buckets']} buckets · ${raw['Hash Batches'] ?? 1} batch${raw['Hash Batches'] === 1 ? '' : 'es'}${peak != null ? ` · ${peak} kB` : ''}`);
	}
	if (num(raw['Workers Planned']) != null) {
		const launched = num(raw['Workers Launched']);
		out.push(`${launched != null ? `${launched} of ` : ''}${raw['Workers Planned']} workers`);
	}
	if (num(raw['Heap Fetches']) != null) out.push(`${raw['Heap Fetches']} heap fetches`);
	if (num(raw['Exact Heap Blocks']) != null || num(raw['Lossy Heap Blocks']) != null) {
		out.push(`heap blocks exact ${raw['Exact Heap Blocks'] ?? 0} · lossy ${raw['Lossy Heap Blocks'] ?? 0}`);
	}
	if (num(raw['Cache Hits']) != null) out.push(`cache hits ${raw['Cache Hits']} · misses ${raw['Cache Misses'] ?? 0}`);
	const tempRead = num(raw['Temp Read Blocks']);
	const tempWritten = num(raw['Temp Written Blocks']);
	if ((tempRead ?? 0) > 0 || (tempWritten ?? 0) > 0) out.push(`temp read ${tempRead ?? 0} · written ${tempWritten ?? 0}`);
	return out;
}

/**
 * Parallel workers each report their own loop, and Postgres averages times over
 * them, so time × loops would count work done side by side several times over.
 * Inside a Gather, divide by the processes involved (workers + leader).
 */
function parallelDivisor(raw: RawPlanNode, inherited: number): number {
	const launched = num(raw['Workers Launched']) ?? num(raw['Workers Planned']);
	if ((raw['Node Type'] === 'Gather' || raw['Node Type'] === 'Gather Merge') && launched != null) {
		// The leader may not participate (parallel_leader_participation = off); loops tells us.
		return launched + 1;
	}
	return inherited;
}

export function parsePlan(input: unknown): PlanSummary {
	const explain = normalizeExplain(input);
	const analyzed = num(explain.Plan['Actual Loops']) != null || num(explain['Execution Time']) != null;
	const nodes: PlanNode[] = [];

	const build = (raw: RawPlanNode, depth: number, parentId: number | null, divisor: number): PlanNode => {
		const loops = num(raw['Actual Loops']);
		const actualTotalMs = num(raw['Actual Total Time']);
		const planRows = num(raw['Plan Rows']) ?? 0;
		const actualRows = num(raw['Actual Rows']);
		const neverExecuted = analyzed && loops === 0;
		const node: PlanNode = {
			id: nodes.length,
			depth,
			parentId,
			children: [],
			nodeType: nodeTypeLabel(raw),
			target: target(raw),
			tags: tags(raw),
			relationship: str(raw['Parent Relationship']),
			subplanName: str(raw['Subplan Name']),
			startupCost: num(raw['Startup Cost']) ?? 0,
			totalCost: num(raw['Total Cost']) ?? 0,
			planRows,
			actualRows,
			loops,
			actualStartupMs: num(raw['Actual Startup Time']),
			actualTotalMs,
			inclusiveMs: null,
			exclusiveMs: null,
			exclusiveCost: 0,
			neverExecuted,
			estimateFactor: null,
			estimateDirection: null,
			misestimated: false,
			sharedHit: num(raw['Shared Hit Blocks']),
			sharedRead: num(raw['Shared Read Blocks']),
			rowsRemovedByFilter: num(raw['Rows Removed by Filter']),
			rowsRemovedByJoinFilter: num(raw['Rows Removed by Join Filter']),
			rowsRemovedByRecheck: num(raw['Rows Removed by Index Recheck']),
			details: [],
			notes: notes(raw),
			share: 0,
			slowest: false,
			raw
		};
		for (const [key, label] of DETAIL_KEYS) {
			const value = detailValue(raw[key]);
			if (value) node.details.push({ label, value });
		}
		if (analyzed && actualTotalMs != null && loops != null) {
			node.inclusiveMs = (actualTotalMs * loops) / (loops > 1 ? Math.min(divisor, loops) : 1);
		}
		if (analyzed && actualRows != null && !neverExecuted) {
			const est = Math.max(planRows, 1);
			const act = Math.max(actualRows, 1);
			node.estimateFactor = Math.max(est, act) / Math.min(est, act);
			node.estimateDirection = node.estimateFactor === 1 ? null : est > act ? 'over' : 'under';
			node.misestimated = node.estimateFactor >= MISESTIMATE_FACTOR;
		}
		nodes.push(node);

		const childDivisor = parallelDivisor(raw, divisor);
		node.children = (raw.Plans ?? []).map((child) => build(child, depth + 1, node.id, childDivisor));

		node.exclusiveCost = Math.max(0, node.totalCost - node.children.reduce((s, c) => s + c.totalCost, 0));
		if (node.inclusiveMs != null) {
			// InitPlans and SubPlans run inside their parent, so their time is in its total too.
			const below = node.children.reduce((s, c) => s + (c.inclusiveMs ?? 0), 0);
			node.exclusiveMs = Math.max(0, node.inclusiveMs - below);
		}
		return node;
	};

	const root = build(explain.Plan, 0, null, 1);

	const weight = (n: PlanNode) => (analyzed ? (n.exclusiveMs ?? 0) : n.exclusiveCost);
	const total = nodes.reduce((s, n) => s + weight(n), 0);
	let slowest: PlanNode | null = null;
	for (const n of nodes) {
		n.share = total > 0 ? weight(n) / total : 0;
		if (!slowest || weight(n) > weight(slowest)) slowest = n;
	}
	if (slowest && weight(slowest) > 0) slowest.slowest = true;

	const jit = explain.JIT;
	const jitTotal = jit?.Timing ? num(jit.Timing.Total) : null;

	return {
		analyzed,
		root,
		nodes,
		planningMs: num(explain['Planning Time']),
		executionMs: num(explain['Execution Time']),
		totalCost: root.totalCost,
		totalRows: analyzed && root.actualRows != null ? root.actualRows * (root.loops ?? 1) : root.planRows,
		triggers: (explain.Triggers ?? []).map((t) => ({
			name: t['Trigger Name'],
			relation: t.Relation ?? null,
			ms: num(t.Time),
			calls: num(t.Calls)
		})),
		jit: jit ? { functions: num(jit.Functions), totalMs: jitTotal } : null,
		settings: explain.Settings && typeof explain.Settings === 'object' ? explain.Settings : {},
		slowestId: slowest && slowest.slowest ? slowest.id : null,
		misestimates: nodes.filter((n) => n.misestimated).length
	};
}

/** Flattens the tree depth first, skipping the children of collapsed nodes. */
export function visibleNodes(summary: PlanSummary, collapsed: ReadonlySet<number>): PlanNode[] {
	const out: PlanNode[] = [];
	const walk = (n: PlanNode) => {
		out.push(n);
		if (!collapsed.has(n.id)) n.children.forEach(walk);
	};
	walk(summary.root);
	return out;
}

/** A plain-text rendering, close to EXPLAIN's own text format, for copying. */
export function planText(summary: PlanSummary): string {
	const lines: string[] = [];
	const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
	for (const n of summary.nodes) {
		const pad = '  '.repeat(n.depth);
		const head = [n.subplanName, `${n.depth ? '->  ' : ''}${n.nodeType}${n.tags.length ? ` [${n.tags.join(', ')}]` : ''}${n.target ? ` ${n.target}` : ''}`]
			.filter(Boolean)
			.join(' ');
		let line = `${pad}${head}  (cost=${fmt(n.startupCost)}..${fmt(n.totalCost)} rows=${n.planRows})`;
		if (summary.analyzed) {
			line += n.neverExecuted
				? ' (never executed)'
				: ` (actual time=${fmt(n.actualStartupMs ?? 0)}..${fmt(n.actualTotalMs ?? 0)} rows=${n.actualRows} loops=${n.loops})`;
		}
		lines.push(line);
		for (const d of n.details) if (d.label !== 'Output') lines.push(`${pad}      ${d.label}: ${d.value}`);
		if (n.rowsRemovedByFilter) lines.push(`${pad}      Rows Removed by Filter: ${n.rowsRemovedByFilter}`);
		if (n.rowsRemovedByJoinFilter) lines.push(`${pad}      Rows Removed by Join Filter: ${n.rowsRemovedByJoinFilter}`);
	}
	if (summary.planningMs != null) lines.push(`Planning Time: ${summary.planningMs.toFixed(3)} ms`);
	if (summary.executionMs != null) lines.push(`Execution Time: ${summary.executionMs.toFixed(3)} ms`);
	return lines.join('\n');
}
