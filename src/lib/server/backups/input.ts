/** Validation of destination and schedule input from the API. */
import { isAbsolute } from 'node:path';
import { BadRequest } from '../http.ts';
import { getConnection } from '../store.ts';
import { getDestination } from './store.ts';
import { describeRetention, describeTiming } from '#lib/backups.ts';
import type { DestinationConfig, DestinationSecrets, Frequency, ScheduleInput } from '#lib/backups.ts';

type Body = Record<string, unknown>;

function obj(body: unknown): Body {
	if (!body || typeof body !== 'object') throw new BadRequest('Expected a JSON object');
	return body as Body;
}

const str = (b: Body, k: string, fallback = '') => (typeof b[k] === 'string' ? (b[k] as string).trim() : fallback);

function required(b: Body, k: string, label: string): string {
	const v = str(b, k);
	if (!v) throw new BadRequest(`${label} is required`);
	return v;
}

function int(v: unknown, label: string, min: number, max: number, fallback?: number): number {
	if ((v === undefined || v === null || v === '') && fallback !== undefined) return fallback;
	const n = Number(v);
	if (!Number.isInteger(n) || n < min || n > max) throw new BadRequest(`${label} must be ${min}–${max}`);
	return n;
}

function optionalInt(v: unknown, label: string, max: number): number | null {
	if (v === undefined || v === null || v === '' || v === 0) return null;
	return int(v, label, 1, max);
}

/** Secrets: absent keeps the stored value, '' clears it. */
function secret(b: Body, k: keyof DestinationSecrets): string | undefined {
	const v = b[k];
	return typeof v === 'string' ? v : undefined;
}

export function parseDestinationInput(body: unknown): { name: string; dest: DestinationConfig; secrets: DestinationSecrets } {
	const b = obj(body);
	const name = required(b, 'name', 'Name');
	const c = obj(b.config ?? {});
	let dest: DestinationConfig;
	switch (b.kind) {
		case 'local': {
			const path = required(c, 'path', 'Folder');
			if (!isAbsolute(path)) throw new BadRequest('The folder must be an absolute path inside the container, e.g. /backups');
			dest = { kind: 'local', config: { path } };
			break;
		}
		case 'sftp':
			dest = {
				kind: 'sftp',
				config: {
					host: required(c, 'host', 'Host'),
					port: int(c.port, 'Port', 1, 65535, 22),
					user: required(c, 'user', 'User'),
					path: str(c, 'path'),
					hostKey: str(c, 'hostKey')
				}
			};
			break;
		case 's3': {
			const endpoint = required(c, 'endpoint', 'Endpoint');
			try {
				const u = new URL(endpoint.includes('://') ? endpoint : `https://${endpoint}`);
				if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
			} catch {
				throw new BadRequest('The endpoint must be a URL like https://minio.lan:9000');
			}
			const bucket = required(c, 'bucket', 'Bucket');
			if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new BadRequest('Bucket names are 3–63 lowercase letters, digits, dots and dashes');
			dest = {
				kind: 's3',
				config: {
					endpoint,
					region: str(c, 'region') || 'us-east-1',
					bucket,
					prefix: str(c, 'prefix').replace(/^\/+/, ''),
					accessKeyId: required(c, 'accessKeyId', 'Access key'),
					pathStyle: c.pathStyle !== false
				}
			};
			break;
		}
		default:
			throw new BadRequest('Type must be local, sftp or s3');
	}
	const s = obj(b.secrets ?? {});
	return {
		name,
		dest,
		secrets: { password: secret(s, 'password'), privateKey: secret(s, 'privateKey'), passphrase: secret(s, 'passphrase'), secretAccessKey: secret(s, 'secretAccessKey') }
	};
}

const FREQUENCIES: Frequency[] = ['hourly', 'daily', 'weekly'];

export function parseScheduleInput(body: unknown): ScheduleInput {
	const b = obj(body);
	const frequency = b.frequency as Frequency;
	if (!FREQUENCIES.includes(frequency)) throw new BadRequest('Frequency must be hourly, daily or weekly');
	const keepLast = optionalInt(b.keepLast, 'Keep last', 10_000);
	const keepDays = optionalInt(b.keepDays, 'Keep days', 36_500);
	return {
		name: required(b, 'name', 'Name'),
		connectionId: typeof b.connectionId === 'string' && b.connectionId ? b.connectionId : null,
		destinationId: required(b, 'destinationId', 'Destination'),
		frequency,
		minute: int(b.minute, 'Minute', 0, 59, 0),
		hour: int(b.hour, 'Hour', 0, 23, 3),
		weekday: int(b.weekday, 'Weekday', 0, 6, 0),
		keepLast,
		keepDays,
		compress: b.compress !== false,
		enabled: b.enabled !== false
	};
}

/** Checks references and returns a one-line description for the audit log. */
export function checkSchedule(s: ScheduleInput): string {
	const dest = getDestination(s.destinationId);
	if (!dest) throw new BadRequest('Choose a destination');
	const conn = s.connectionId ? getConnection(s.connectionId) : null;
	if (s.connectionId && !conn) throw new BadRequest('Connection not found');
	return `${s.name}: ${conn?.name ?? 'all connections'} → ${dest.name}, ${describeTiming(s)}, ${describeRetention(s).toLowerCase()}${s.enabled ? '' : ', paused'}`;
}
