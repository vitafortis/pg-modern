export type SslMode = 'disable' | 'prefer' | 'require' | 'verify-full';

export type SourceKind = 'manual' | 'docker' | 'env' | 'arcane';

export interface ConnectionSource {
	kind: SourceKind;
	/** Container name, or the file path a credential came from. */
	ref?: string;
}

export interface ConnectionInput {
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
}

/** A connection proposed by Docker or .env discovery. */
export interface Candidate {
	/** Stable fingerprint of host/port/db/user, used to spot duplicates. */
	fingerprint: string;
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
	/** Id of a saved connection with the same fingerprint, if any. */
	existingId?: string;
	reachable?: boolean;
}

export interface DockerCandidateGroup {
	endpoint: string;
	error?: string;
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
	position?: number;
	detail?: string;
	hint?: string;
}

export interface HistoryEntry {
	id: number;
	connectionId: string;
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
