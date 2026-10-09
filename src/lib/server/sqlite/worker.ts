/**
 * The code each SQLite worker thread runs. node:sqlite is synchronous, so queries run
 * off the main thread: a slow query or a lock wait (busy_timeout) never stalls the
 * app, and cancelling or timing out terminates the worker.
 *
 * It's plain JavaScript, run either as a worker thread (`new Worker(src, { eval: true })`,
 * for introspection) or as a child process (`node -e src`, for user queries: killing a
 * process stops a statement mid-step, which terminating a thread can't). Either way it
 * works the same under Vite, the adapter-node build and the test runner.
 *
 * workerData: { location, readOnly, busyTimeoutMs }
 * request:  { id, op: 'run', sql, params?, maxRows }                one statement, arrays
 *           { id, op: 'all', queries: [{ sql, params? }], soft? }   object rows, several reads
 *           { id, op: 'exec', sql }                                 no result
 * response: { id, ok: true, result } | { id, ok: false, error: { message, code, errcode, errstr } }
 */
export const WORKER_SOURCE = String.raw`
const { parentPort, workerData: threadData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
// A worker thread (introspection) or a child process (user queries, killable mid-step).
const workerData = parentPort ? threadData : JSON.parse(process.env.PGM_SQLITE_WORKER);
const post = parentPort ? (m) => parentPort.postMessage(m) : (m) => process.send(m);
if (!parentPort) process.on('disconnect', () => process.exit(0));

let db;
function open() {
	if (db) return db;
	db = new DatabaseSync(workerData.location, {
		readOnly: workerData.readOnly,
		timeout: workerData.busyTimeoutMs,
		enableForeignKeyConstraints: true,
		allowExtension: false
	});
	if (workerData.readOnly) db.exec('PRAGMA query_only = ON');
	return db;
}

function value(v) {
	if (typeof v === 'bigint') return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
	if (v instanceof Uint8Array) return '0x' + Buffer.from(v).toString('hex');
	return v;
}

function run(req) {
	const stmt = open().prepare(req.sql);
	stmt.setReadBigInts(true);
	const columns = stmt.columns();
	if (!columns.length) {
		const r = stmt.run(...(req.params || []));
		return { columns: [], rows: [], truncated: false, changes: Number(r.changes) };
	}
	stmt.setReturnArrays(true);
	const rows = [];
	let truncated = false;
	for (const row of stmt.iterate(...(req.params || []))) {
		if (rows.length >= req.maxRows) {
			truncated = true;
			break;
		}
		rows.push(row.map(value));
	}
	return {
		columns: columns.map((c) => ({ name: c.name || c.column || '?', type: c.type || '' })),
		rows,
		truncated,
		changes: null
	};
}

function all(req) {
	const d = open();
	return req.queries.map((q) => {
		try {
			const stmt = d.prepare(q.sql);
			stmt.setReadBigInts(true);
			return stmt.all(...(q.params || [])).map((r) => {
				const o = {};
				for (const k of Object.keys(r)) o[k] = value(r[k]);
				return o;
			});
		} catch (err) {
			// Optional reads (dbstat, sqlite_stat1) may be missing; the caller decides.
			if (req.soft) return { error: String(err && err.message) };
			throw err;
		}
	});
}

(parentPort || process).on('message', (req) => {
	try {
		let result;
		if (req.op === 'run') result = run(req);
		else if (req.op === 'all') result = all(req);
		else if (req.op === 'exec') {
			try {
				open().exec(req.sql);
			} catch (err) {
				if (!req.ignoreErrors) throw err;
			}
			result = null;
		} else if (req.op === 'close') {
			if (db) db.close();
			db = undefined;
			result = null;
		} else throw new Error('unknown op ' + req.op);
		post({ id: req.id, ok: true, result });
	} catch (err) {
		post({
			id: req.id,
			ok: false,
			error: { message: String((err && err.message) || err), code: err && err.code, errcode: err && err.errcode, errstr: err && err.errstr }
		});
	}
});
`;
