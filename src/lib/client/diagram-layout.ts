import dagre from '@dagrejs/dagre';
import type { DiagramColumn, DiagramForeignKey, DiagramTable, SchemaDiagram } from '#lib/types.ts';

export const HEADER = 34;
export const ROW = 22;
export const PAD_X = 12;
export const PAD_BOTTOM = 6;
const ICON = 14;
const MIN_W = 170;
const MAX_W = 380;
const GAP = 48;

/** Width in px of `text`, in the bold sans header font, the sans column font or the mono type font. */
export type Measure = (text: string, font: 'header' | 'name' | 'type') => number;

/** Rough metrics for when no canvas is available (tests, SSR). */
export const estimate: Measure = (text, font) => text.length * (font === 'header' ? 7.4 : font === 'name' ? 6.8 : 6.6);

export interface DiagramRow extends DiagramColumn {
	/** Display text, shortened if very long. */
	label: string;
	typeLabel: string;
	isForeignKey: boolean;
	/** Center of the row, relative to the node's top. */
	cy: number;
}

export interface DiagramNode {
	key: string;
	table: DiagramTable;
	title: string;
	x: number;
	y: number;
	width: number;
	height: number;
	rows: DiagramRow[];
	/** Columns not shown in compact mode. */
	hidden: number;
	/** Not connected to anything; placed in the grid. */
	isolated: boolean;
}

export interface DiagramEdge {
	key: string;
	fk: DiagramForeignKey;
	from: string;
	to: string;
	/** The connecting curve. */
	path: string;
	/** Crow's foot at the referencing ("many") end and a bar at the referenced ("one") end. */
	ends: string;
}

export interface DiagramLayout {
	nodes: DiagramNode[];
	edges: DiagramEdge[];
	bounds: { x: number; y: number; width: number; height: number };
}

export const tableKey = (schema: string, name: string) => `${schema}.${name}`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function layoutDiagram(d: SchemaDiagram, { compact = false, measure = estimate }: { compact?: boolean; measure?: Measure } = {}): DiagramLayout {
	// Columns taking part in a foreign key, on either end.
	const fkCols = new Map<string, Set<string>>();
	const refCols = new Map<string, Set<string>>();
	const add = (m: Map<string, Set<string>>, k: string, cols: string[]) => {
		let s = m.get(k);
		if (!s) m.set(k, (s = new Set()));
		for (const c of cols) s.add(c);
	};
	for (const fk of d.foreignKeys) {
		add(fkCols, tableKey(fk.fromSchema, fk.fromTable), fk.fromColumns);
		add(refCols, tableKey(fk.toSchema, fk.toTable), fk.toColumns);
	}

	const nodes = new Map<string, DiagramNode>();
	for (const t of d.tables) {
		const key = tableKey(t.schema, t.name);
		const fks = fkCols.get(key);
		const refs = refCols.get(key);
		const shown = compact ? t.columns.filter((c) => c.isPrimaryKey || fks?.has(c.name) || refs?.has(c.name)) : t.columns;
		const rows: DiagramRow[] = shown.map((c, i) => ({
			...c,
			label: clip(c.name, 30),
			typeLabel: clip(c.type, 24),
			isForeignKey: !!fks?.has(c.name),
			cy: HEADER + i * ROW + ROW / 2
		}));
		const title = t.external ? `${t.schema}.${t.name}` : t.name;
		const nameW = Math.max(0, ...rows.map((r) => measure(r.label, 'name')));
		const typeW = Math.max(0, ...rows.map((r) => measure(r.typeLabel, 'type')));
		const width = Math.min(
			MAX_W,
			Math.max(MIN_W, PAD_X * 2 + ICON + 6 + measure(title, 'header') + 8, PAD_X * 2 + ICON + 6 + nameW + 20 + typeW)
		);
		nodes.set(key, {
			key,
			table: t,
			title,
			x: 0,
			y: 0,
			width: Math.ceil(width),
			height: HEADER + rows.length * ROW + (rows.length ? PAD_BOTTOM : 0),
			rows,
			hidden: t.columns.length - rows.length,
			isolated: true
		});
	}

	const fks = d.foreignKeys.filter(
		(fk) => nodes.has(tableKey(fk.fromSchema, fk.fromTable)) && nodes.has(tableKey(fk.toSchema, fk.toTable))
	);

	// Layered layout for everything with a relation; referenced tables to the left.
	const g = new dagre.graphlib.Graph({ multigraph: true });
	g.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 110, edgesep: 14, marginx: 0, marginy: 0 });
	g.setDefaultEdgeLabel(() => ({}));
	for (const fk of fks) {
		const from = tableKey(fk.fromSchema, fk.fromTable);
		const to = tableKey(fk.toSchema, fk.toTable);
		if (from === to) continue;
		for (const k of [from, to]) {
			const n = nodes.get(k)!;
			n.isolated = false;
			if (!g.hasNode(k)) g.setNode(k, { width: n.width, height: n.height });
		}
		g.setEdge(to, from, {}, fk.name);
	}
	let graphW = 0;
	let graphH = 0;
	if (g.nodeCount()) {
		dagre.layout(g);
		for (const k of g.nodes()) {
			const p = g.node(k);
			const n = nodes.get(k)!;
			n.x = Math.round(p.x - n.width / 2);
			n.y = Math.round(p.y - n.height / 2);
			graphW = Math.max(graphW, n.x + n.width);
			graphH = Math.max(graphH, n.y + n.height);
		}
	}

	// Unrelated tables go in a grid next to the graph instead of spreading it out.
	const isolated = [...nodes.values()].filter((n) => n.isolated).sort((a, b) => a.title.localeCompare(b.title));
	if (isolated.length) {
		const area = isolated.reduce((s, n) => s + (n.width + GAP) * (n.height + GAP), 0);
		const side = g.nodeCount() && graphH > graphW * 1.2 ? 'right' : 'below';
		const maxRow = side === 'below' && graphW ? Math.max(graphW, Math.sqrt(area)) : Math.max(Math.sqrt(area * 1.6), MAX_W);
		const ox = side === 'right' ? graphW + GAP * 2 : 0;
		const oy = side === 'below' && g.nodeCount() ? graphH + GAP * 2 : 0;
		let x = 0;
		let y = 0;
		let rowH = 0;
		for (const n of isolated) {
			if (x > 0 && x + n.width > maxRow) {
				x = 0;
				y += rowH + GAP;
				rowH = 0;
			}
			n.x = ox + x;
			n.y = oy + y;
			x += n.width + GAP;
			rowH = Math.max(rowH, n.height);
		}
	}

	const edges = fks.map((fk, i) => {
		const from = nodes.get(tableKey(fk.fromSchema, fk.fromTable))!;
		const to = nodes.get(tableKey(fk.toSchema, fk.toTable))!;
		return { key: `${i}:${fk.name}`, fk, from: from.key, to: to.key, ...route(from, fk.fromColumns[0], to, fk.toColumns[0]) };
	});

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const n of nodes.values()) {
		minX = Math.min(minX, n.x);
		minY = Math.min(minY, n.y);
		maxX = Math.max(maxX, n.x + n.width);
		maxY = Math.max(maxY, n.y + n.height);
	}
	if (!nodes.size) minX = minY = maxX = maxY = 0;
	// Self references loop out to the right.
	if (edges.some((e) => e.from === e.to)) maxX += 40;

	return { nodes: [...nodes.values()], edges, bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
}

function anchorY(n: DiagramNode, column: string | undefined) {
	const row = n.rows.find((r) => r.name === column);
	return n.y + (row ? row.cy : HEADER / 2);
}

/** A smooth curve from the referencing column's row to the referenced column's row. */
function route(from: DiagramNode, fromCol: string | undefined, to: DiagramNode, toCol: string | undefined) {
	const y1 = anchorY(from, fromCol);
	const y2 = anchorY(to, toCol);
	let x1: number, x2: number, d1: number, d2: number;
	if (from.x >= to.x + to.width) [x1, d1, x2, d2] = [from.x, -1, to.x + to.width, 1];
	else if (from.x + from.width <= to.x) [x1, d1, x2, d2] = [from.x + from.width, 1, to.x, -1];
	else {
		// Overlapping columns (or a self reference): leave and enter on the right.
		[x1, d1, x2, d2] = [from.x + from.width, 1, to.x + to.width, 1];
	}
	const sx = x1 + d1 * 12;
	const ex = x2 + d2 * 10;
	const c = d1 === d2 ? Math.max(40, Math.abs(y2 - y1) / 3, Math.abs(ex - sx) / 2 + 30) : Math.max(30, Math.abs(ex - sx) / 2);
	const f = (n: number) => Math.round(n * 10) / 10;
	const path = `M${f(x1)},${f(y1)} H${f(sx)} C${f(sx + d1 * c)},${f(y1)} ${f(ex + d2 * c)},${f(y2)} ${f(ex)},${f(y2)} H${f(x2)}`;
	// Many: three prongs fanning into the referencing table. One: a bar near the referenced table.
	const ends =
		`M${f(x1 + d1 * 10)},${f(y1)} L${f(x1)},${f(y1 - 5)} M${f(x1 + d1 * 10)},${f(y1)} L${f(x1)},${f(y1 + 5)}` +
		` M${f(x2 + d2 * 6)},${f(y2 - 5)} V${f(y2 + 5)}`;
	return { path, ends };
}
