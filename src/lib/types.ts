export type SslMode = 'disable' | 'prefer' | 'require' | 'verify-full';

/** Wire protocol / driver: `mysql` covers MySQL, MariaDB and Percona. */
export type Engine = 'postgres' | 'mysql';

/** The server product, when known: MariaDB speaks the MySQL protocol but differs in places. */
export type Flavor = 'postgres' | 'mysql' | 'mariadb';

export type SourceKind = 'manual' | 'docker' | 'env' | 'arcane' | 'terraform';

export interface ConnectionSource {
	kind: SourceKind;
	/** Container name, or the file path a credential came from. */
	ref?: string;
}

export interface ConnectionInput {
	/** Defaults to `postgres`. */
	engine?: Engine;
	name: string;
	host: string;
	port: number;
	database: string;
	user: string;
	/** Omit to keep the existing password on update; empty string clears it. */
	password?: string;
	sslMode: SslMode;
	readOnly: boolean;
	color?: string;
	source?: ConnectionSource;
}

/** A stored connection as exposed to the browser — never includes the secret. */
export interface Connection {
	id: string;
	engine: Engine;
	/** Detected from the server version the last time pg·modern connected (MariaDB vs MySQL). */
	flavor: Flavor | null;
	name: string;
	host: string;
	port: number;
	database: string;
	user: string;
	hasPassword: boolean;
	sslMode: SslMode;
	readOnly: boolean;
	color: string;
	source: ConnectionSource;
	createdAt: string;
	updatedAt: string;
	lastConnectedAt: string | null;
	/** What the signed-in user may do here (set on responses to the browser). */
	access?: ConnectionAccess;
}

/** A connection proposed by Docker or .env discovery. */
export interface Candidate {
	/** Stable fingerprint of engine/host/port/db/user, used to spot duplicates. */
	fingerprint: string;
	engine: Engine;
	/** Known from the image or variables (e.g. a mariadb container). */
	flavor?: Flavor;
	/** Unique per source + fingerprint; assigned when a scan is cached and used to import. */
	key?: string;
	name: string;
	host: string;
	port: number;
	database: string;
	user: string;
	/** Present only server-side until import; the browser sees `hasPassword`. */
	password?: string;
	hasPassword: boolean;
	sslMode: SslMode;
	source: ConnectionSource;
	/** Other addresses that may reach the same server (e.g. container IP vs. published port). */
	alternates?: { host: string; port: number; label: string }[];
	/** Free-form hints shown in the UI, e.g. "password is in a *_FILE secret". */
	notes: string[];
	/**
	 * The saved connection this candidate corresponds to: same address, or the same
	 * container/file with the same user and database. `addressChanged` means the saved
	 * copy points at an address this scan no longer reports (e.g. the port changed).
	 */
	saved?: { id: string; name: string; host: string; port: number; addressChanged: boolean };
	reachable?: boolean;
	/** For containers: which networks the database is on and how pg·modern gets to it. */
	network?: NetworkPath;
}

/** pg·modern's own container and the Docker networks it's attached to. */
export interface SelfNetworks {
	inContainer: boolean;
	/** Our container's name, when we found it in this Docker host's container list. */
	container?: string;
	networks: string[];
}

export interface NetworkPath {
	/** Networks the database container is attached to. */
	networks: string[];
	/** Of those, the ones pg·modern is attached to as well. */
	shared: string[];
	/** Ports published on the host for the database port. */
	published: { host: string; port: number }[];
	via: 'shared-network' | 'published-port' | 'host-network' | 'none';
	/** A network that pg·modern could join to reach it. */
	join?: string;
	/** The container port that could be published instead. */
	publish?: number;
}

export interface DockerCandidateGroup {
	endpoint: string;
	self?: SelfNetworks;
	error?: string;
	/** How many containers were inspected on this endpoint. */
	inspected?: number;
	/** Containers with no database server or credentials found. */
	skipped?: { id: string; name: string; image: string; state: string }[];
	containers: {
		id: string;
		name: string;
		image: string;
		state: string;
		status: string;
		candidates: Candidate[];
	}[];
}

export interface EnvScanResult {
	self?: SelfNetworks;
	roots: string[];
	filesScanned: number;
	durationMs: number;
	errors: string[];
	files: { path: string; candidates: Candidate[] }[];
}

export interface ColumnInfo {
	name: string;
	type: string;
	nullable: boolean;
	default: string | null;
	isPrimaryKey: boolean;
	comment: string | null;
}

export interface RelationSummary {
	name: string;
	kind: 'table' | 'view' | 'matview' | 'foreign' | 'partitioned';
	estimatedRows: number;
	sizeBytes: number | null;
}

export interface SchemaTree {
	schemas: { name: string; relations: RelationSummary[]; functions: number }[];
}

export interface DiagramColumn {
	name: string;
	type: string;
	nullable: boolean;
	isPrimaryKey: boolean;
}

export interface DiagramTable {
	schema: string;
	name: string;
	kind: RelationSummary['kind'];
	columns: DiagramColumn[];
	/** Lives in another schema and is only shown because a foreign key points at it (key columns only). */
	external?: boolean;
}

export interface DiagramForeignKey {
	name: string;
	fromSchema: string;
	fromTable: string;
	fromColumns: string[];
	toSchema: string;
	toTable: string;
	toColumns: string[];
}

/** Tables and foreign keys of one schema, for the ER diagram. */
export interface SchemaDiagram {
	schema: string;
	tables: DiagramTable[];
	foreignKeys: DiagramForeignKey[];
	/** More relations exist than were returned. */
	truncated: boolean;
}

export interface QueryField {
	name: string;
	dataTypeID: number;
	type: string;
}

export interface QueryResult {
	command: string;
	rowCount: number | null;
	fields: QueryField[];
	rows: unknown[][];
	truncated: boolean;
	durationMs: number;
	readOnly: boolean;
}

export interface QueryError {
	message: string;
	code?: string;
	/** MySQL's SQLSTATE (Postgres reports it as `code`). */
	sqlState?: string;
	position?: number;
	detail?: string;
	hint?: string;
}

export interface HistoryEntry {
	id: number;
	connectionId: string;
	/** Filled in by audit searches. */
	connectionName?: string;
	userId: string | null;
	userEmail: string | null;
	/** False when the statement ran with write access. */
	readOnly: boolean;
	sql: string;
	ok: boolean;
	rowCount: number | null;
	durationMs: number;
	error: string | null;
	createdAt: string;
}

export type ManagerKind = 'arcane';

/** A Docker management UI whose API can list stacks (compose + .env) across hosts. */
export interface Manager {
	id: string;
	kind: ManagerKind;
	name: string;
	url: string;
	hasKey: boolean;
	/** Set via environment variables; can't be edited in the UI. */
	fromEnv?: boolean;
}

export interface ManagerScan {
	manager: Manager;
	error?: string;
	environments: {
		id: string;
		name: string;
		host: string;
		error?: string;
		/** Non-fatal problem, e.g. the API key can't list containers. */
		warning?: string;
		/** Diagnostics so a missing database can be explained. */
		projectsRead?: number;
		containersInspected?: number;
		/** Containers with no database server or credentials found. */
		skipped?: { name: string; image: string; state: string }[];
		self?: SelfNetworks;
		/** Compose files that didn't parse cleanly (results are best-effort). */
		parseErrors?: { project: string; message: string }[];
		projects: { id: string; name: string; status: string; candidates: Candidate[] }[];
	}[];
}

export interface Settings {
	scanPaths: string[];
	dockerHosts: string[];
	managers?: Omit<Manager, 'hasKey' | 'fromEnv'>[];
}

export type Role = 'admin' | 'viewer';

export interface User {
	id: string;
	email: string;
	name: string | null;
	role: Role;
	/** Has a local password (can use the password form). */
	hasPassword: boolean;
	/** Linked to an SSO identity. */
	sso: boolean;
	disabled: boolean;
	/** Must set a real email/name before using the app (upgraded installs). */
	needsProfile: boolean;
	/** Viewers: every connection (read-only), or only those granted. Admins see everything. */
	connectionAccess: 'all' | 'selected';
	createdAt: string;
	lastLoginAt: string | null;
}

/** What the browser knows about the current session. */
export interface Viewer {
	email: string;
	name: string | null;
	role: Role;
	hasPassword: boolean;
	sso: boolean;
}

export interface Grant {
	connectionId: string;
	/** May unlock temporary write access. */
	canWrite: boolean;
}

/** What the current user may do on one connection. */
export interface ConnectionAccess {
	/** `always`: writes are allowed; `unlock`: may unlock temporarily; `never`: read-only. */
	write: 'always' | 'unlock' | 'never';
	/** Epoch ms when temporary write access ends, if it's active. */
	unlockedUntil: number | null;
	/** Whether queries run read-only right now. */
	readOnly: boolean;
}

export interface AuditEvent {
	id: number;
	at: string;
	userId: string | null;
	userEmail: string | null;
	action: string;
	connectionId: string | null;
	connectionName: string | null;
	detail: string | null;
	ip: string | null;
}

/** A named query; `connectionId` null means it can be used on any connection. */
export interface SavedQuery {
	id: string;
	name: string;
	description: string | null;
	sql: string;
	connectionId: string | null;
	ownerId: string;
	ownerEmail: string;
	/** Visible to everyone who can see the connection. */
	shared: boolean;
	createdAt: string;
	updatedAt: string;
	/** Set on responses: the signed-in user's own query. */
	mine?: boolean;
	/** Set on responses: the signed-in user may edit or delete it (owner or admin). */
	canEdit?: boolean;
}
