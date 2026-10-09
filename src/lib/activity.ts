/**
 * Live server activity (pg_stat_activity, locks, sizes): the API shape plus pure
 * helpers shared by the server and the Activity tab.
 */

/** A section that loaded, or the error that stopped it; one failing never hides the others. */
export type Section<T> = { data: T; error: null } | { data: null; error: string };

export interface ActivitySession {
	pid: number;
	user: string | null;
	database: string | null;
	app: string | null;
	client: string | null;
	backendType: string | null;
	/** `active`, `idle`, `idle in transaction`, … or null for background processes. */
	state: string | null;
	waitEventType: string | null;
	waitEvent: string | null;
	backendStart: string | null;
	xactStart: string | null;
	queryStart: string | null;
	stateChange: string | null;
	/** Seconds since query_start, xact_start and state_change at fetch time. */
	querySeconds: number | null;
	xactSeconds: number | null;
	stateSeconds: number | null;
	/** Truncated to QUERY_LIMIT characters; `<insufficient privilege>` for other roles' sessions without pg_read_all_stats. */
	query: string | null;
	queryTruncated: boolean;
	xidAge: number | null;
	xminAge: number | null;
	blockedBy: number[];
	/** One of pg·modern's own pooled sessions. */
	pgModern: boolean;
	/** The backend that ran this very query. */
	self: boolean;
}

export interface ActivityLock {
	pid: number;
	locktype: string;
	mode: string;
	granted: boolean;
	relation: string | null;
	database: string | null;
	user: string | null;
	/** How long the holding transaction or the waiting query has been running. */
	seconds: number | null;
}

export interface DatabaseSize {
	name: string;
	/** Null when the role may not connect to it. */
	bytes: number | null;
	current: boolean;
	sessions: number;
}

export interface TableStat {
	schema: string;
	name: string;
	totalBytes: number;
	tableBytes: number;
	indexBytes: number;
	/** Locked exclusively right now, so the size is the planner's estimate rather than measured. */
	sizeEstimated: boolean;
	liveTuples: number;
	deadTuples: number;
	seqScans: number | null;
	idxScans: number | null;
	lastAutovacuum: string | null;
	lastVacuum: string | null;
	lastAutoanalyze: string | null;
	lastAnalyze: string | null;
	/** MySQL / MariaDB: storage engine, reclaimable space and last write. */
	storageEngine?: string | null;
	freeBytes?: number | null;
	updatedAt?: string | null;
}

export interface IndexStat {
	schema: string;
	table: string;
	name: string;
	bytes: number;
	scans: number | null;
	unique: boolean;
}

export interface ActivityServer {
	maxConnections: number;
	reservedConnections: number;
	currentDatabase: string;
	currentUser: string;
	superuser: boolean;
	/** Member of pg_read_all_stats (or superuser): can see every session's query. */
	readAllStats: boolean;
	canSignalOthers: boolean;
}

export interface Activity {
	fetchedAt: string;
	/** Absent for Postgres (older responses). */
	engine?: 'postgres' | 'mysql';
	server: Section<ActivityServer>;
	sessions: Section<ActivitySession[]>;
	locks: Section<ActivityLock[]>;
	databases: Section<DatabaseSize[]>;
	tables: Section<TableStat[]>;
	indexes: Section<IndexStat[]>;
}

export const QUERY_LIMIT = 2000;
/** Transactions open longer than this count as long-running. */
export const LONG_TXN_SECONDS = 300;

export type SessionTone = 'waiting' | 'active' | 'idle-txn' | 'idle' | 'background' | 'other';

export function sessionTone(s: Pick<ActivitySession, 'state' | 'blockedBy' | 'waitEventType'>): SessionTone {
	if (s.blockedBy.length || (s.state === 'active' && s.waitEventType === 'Lock')) return 'waiting';
	if (s.state === 'active') return 'active';
	if (s.state?.startsWith('idle in transaction')) return 'idle-txn';
	if (s.state === 'idle') return 'idle';
	if (s.state == null) return 'background';
	return 'other';
}

export interface ActivitySummary {
	active: number;
	idle: number;
	idleInTransaction: number;
	waiting: number;
	background: number;
	/** Client sessions, i.e. what counts against max_connections. */
	clients: number;
	total: number;
	oldestXactSeconds: number | null;
	oldestXactPid: number | null;
	longTransactions: number[];
}

export function summarize(sessions: ActivitySession[]): ActivitySummary {
	const out: ActivitySummary = {
		active: 0,
		idle: 0,
		idleInTransaction: 0,
		waiting: 0,
		background: 0,
		clients: 0,
		total: sessions.length,
		oldestXactSeconds: null,
		oldestXactPid: null,
		longTransactions: []
	};
	for (const s of sessions) {
		const tone = sessionTone(s);
		if (tone === 'waiting') out.waiting++;
		if (tone === 'active' || tone === 'waiting') out.active++;
		else if (tone === 'idle-txn') out.idleInTransaction++;
		else if (tone === 'idle') out.idle++;
		else if (tone === 'background') out.background++;
		if (s.backendType === 'client backend' || (s.backendType == null && s.state != null)) out.clients++;
		if (s.xactSeconds != null && !s.self) {
			if (out.oldestXactSeconds == null || s.xactSeconds > out.oldestXactSeconds) {
				out.oldestXactSeconds = s.xactSeconds;
				out.oldestXactPid = s.pid;
			}
			if (s.xactSeconds >= LONG_TXN_SECONDS && s.backendType !== 'autovacuum worker') out.longTransactions.push(s.pid);
		}
	}
	return out;
}

export interface LockNode {
	pid: number;
	depth: number;
	/** Pids this session directly blocks. */
	blocks: number[];
}

/**
 * Orders lock chains as a tree: each root blocker (blocks others, isn't blocked by
 * anyone present) followed depth-first by the sessions waiting on it. Sessions that
 * wait on several blockers appear under the first one only; cycles are cut.
 */
export function lockTree(sessions: Pick<ActivitySession, 'pid' | 'blockedBy'>[]): LockNode[] {
	const present = new Set(sessions.map((s) => s.pid));
	const blocks = new Map<number, number[]>();
	for (const s of sessions) {
		for (const b of s.blockedBy) {
			if (!present.has(b)) continue;
			if (!blocks.has(b)) blocks.set(b, []);
			blocks.get(b)!.push(s.pid);
		}
	}
	const blocked = new Set(sessions.filter((s) => s.blockedBy.some((b) => present.has(b))).map((s) => s.pid));
	const out: LockNode[] = [];
	const seen = new Set<number>();
	const visit = (pid: number, depth: number) => {
		if (seen.has(pid)) return;
		seen.add(pid);
		const children = [...(blocks.get(pid) ?? [])].sort((a, b) => a - b);
		out.push({ pid, depth, blocks: children });
		for (const c of children) visit(c, depth + 1);
	};
	const roots = [...blocks.keys()].filter((p) => !blocked.has(p)).sort((a, b) => a - b);
	for (const r of roots) visit(r, 0);
	// Pure cycles (every member is blocked by another) have no root; start anywhere.
	for (const p of [...blocks.keys()].sort((a, b) => a - b)) visit(p, 0);
	return out;
}

/**
 * Table order: lock chains first (tree order, with depth), then everything else in
 * the order given.
 */
export function arrangeSessions<T extends Pick<ActivitySession, 'pid' | 'blockedBy'>>(sessions: T[]): { session: T; depth: number; blocks: number[] }[] {
	const byPid = new Map(sessions.map((s) => [s.pid, s]));
	const tree = lockTree(sessions);
	const inTree = new Set(tree.map((n) => n.pid));
	return [
		...tree.map((n) => ({ session: byPid.get(n.pid)!, depth: n.depth, blocks: n.blocks })),
		...sessions.filter((s) => !inTree.has(s.pid)).map((s) => ({ session: s, depth: 0, blocks: [] }))
	];
}

/** Compact elapsed time: `850ms`, `42s`, `3m 07s`, `2h 05m`, `3d 4h`. */
export function formatAge(seconds: number | null | undefined): string {
	if (seconds == null || !Number.isFinite(seconds)) return '—';
	const s = Math.max(0, seconds);
	if (s < 1) return `${Math.round(s * 1000)}ms`;
	if (s < 60) return `${Math.floor(s)}s`;
	const pad = (n: number) => String(n).padStart(2, '0');
	if (s < 3600) return `${Math.floor(s / 60)}m ${pad(Math.floor(s % 60))}s`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
	return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** Share of dead tuples in percent, or null when the table is empty. */
export function deadRatio(live: number, dead: number): number | null {
	const total = live + dead;
	return total > 0 ? (dead / total) * 100 : null;
}

/** Dead tuples worth flagging: a meaningful share and enough rows to matter. */
export function deadIsHigh(live: number, dead: number): boolean {
	const r = deadRatio(live, dead);
	return r != null && r >= 20 && dead >= 1000;
}

/** Case-insensitive match against the columns people look for. */
export function matchesSearch(s: ActivitySession, term: string): boolean {
	const t = term.trim().toLowerCase();
	if (!t) return true;
	if (/^\d+$/.test(t) && String(s.pid).startsWith(t)) return true;
	return [s.user, s.database, s.app, s.client, s.state, s.query, s.waitEvent, s.backendType].some((v) => v?.toLowerCase().includes(t));
}
