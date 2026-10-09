/**
 * Recognising SQLite database files: by name, by the 16-byte header, and which app a
 * path most likely belongs to. Pure, so discovery and tests share it.
 */
import { basename } from 'node:path';

/** Every SQLite 3 database starts with these 16 bytes. */
export const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

export function isSqliteHeader(buf: Uint8Array | null | undefined): boolean {
	if (!buf || buf.length < 16) return false;
	for (let i = 0; i < 16; i++) if (buf[i] !== SQLITE_MAGIC[i]) return false;
	return true;
}

/** WAL mode is recorded in the header's file format version bytes (18, 19). */
export function headerSaysWal(buf: Uint8Array | null | undefined): boolean {
	return !!buf && buf.length >= 20 && (buf[18] === 2 || buf[19] === 2);
}

const SQLITE_EXT = /\.(db|sqlite|sqlite3|db3)$/i;
/** Well-known database file names without one of those extensions. */
const KNOWN_NAMES = new Set(['absdatabase.sqlite', 'database.sqlite', 'db.sqlite3', 'home-assistant_v2.db', 'kuma.db', 'gitea.db', 'grafana.db']);
/** Journals, WAL and shared memory belong to a database next to them; backups and temp copies are noise. */
const SIDECAR = /-(wal|shm|journal)$|\.(bak|backup|old|tmp|orig)$|\.db\.\d+$/i;

/** Whether a file name is worth reading the header of. */
export function isSqliteCandidateName(name: string): boolean {
	if (SIDECAR.test(name)) return false;
	return SQLITE_EXT.test(name) || KNOWN_NAMES.has(name.toLowerCase());
}

export function isSidecar(name: string): boolean {
	return /-(wal|shm|journal)$/i.test(name);
}

/**
 * Files to skip even though their name fits: thumbnail caches, browser profiles and
 * the like, which are SQLite but not something anyone browses.
 */
export function isNoiseDatabase(path: string): boolean {
	if (/(^|\/)(thumbs?\.db|\.DS_Store)$/i.test(path) || /\/(cache|caches|\.cache|Cache)\//.test(path)) return true;
	// Browser profiles (Firefox / Chromium in a "browser in a container" app) are dozens of small SQLite files.
	if (/\/(\.mozilla|firefox|chromium|google-chrome|profiles?)\//i.test(path)) return true;
	return /(^|\/)(places|cookies|favicons|webappsstore|formhistory|permissions|content-prefs|storage|bounce-tracking-protection|domain_to_categories)\.sqlite$|(^|\/)(cert9|key4|logins)\.db$/i.test(path);
}

const APPS: [RegExp, string][] = [
	[/jellyfin|\/(jellyfin|library)\.db$/i, 'Jellyfin'],
	[/emby/i, 'Emby'],
	[/plex|com\.plexapp/i, 'Plex'],
	[/vaultwarden|bitwarden/i, 'Vaultwarden'],
	[/sonarr/i, 'Sonarr'],
	[/radarr/i, 'Radarr'],
	[/prowlarr/i, 'Prowlarr'],
	[/lidarr/i, 'Lidarr'],
	[/readarr/i, 'Readarr'],
	[/whisparr/i, 'Whisparr'],
	[/bazarr/i, 'Bazarr'],
	[/jellyseerr/i, 'Jellyseerr'],
	[/overseerr/i, 'Overseerr'],
	[/tautulli/i, 'Tautulli'],
	[/home-?assistant|home-assistant_v2\.db$/i, 'Home Assistant'],
	[/uptime-?kuma|\/kuma\.db$/i, 'Uptime Kuma'],
	[/gitea|forgejo/i, 'Gitea / Forgejo'],
	[/grafana/i, 'Grafana'],
	[/pihole|pi-hole|gravity\.db$|pihole-FTL\.db$/i, 'Pi-hole'],
	[/audiobookshelf|absdatabase/i, 'Audiobookshelf'],
	[/nginx-?proxy-?manager|\/npm\//i, 'Nginx Proxy Manager'],
	[/authelia/i, 'Authelia'],
	[/n8n/i, 'n8n'],
	[/homarr/i, 'Homarr'],
	[/paperless/i, 'Paperless-ngx'],
	[/immich/i, 'Immich'],
	[/navidrome/i, 'Navidrome'],
	[/calibre|metadata\.db$/i, 'Calibre'],
	[/actual-?(budget|server|data)/i, 'Actual Budget'],
	[/mealie/i, 'Mealie'],
	[/freshrss/i, 'FreshRSS'],
	[/syncthing/i, 'Syncthing'],
	[/qbittorrent/i, 'qBittorrent'],
	[/changedetection/i, 'changedetection.io'],
	[/semaphore/i, 'Semaphore'],
	[/linkding/i, 'linkding'],
	[/memos/i, 'Memos'],
	[/stirling/i, 'Stirling PDF'],
	[/headscale/i, 'Headscale'],
	[/adguard/i, 'AdGuard Home'],
	[/zigbee2mqtt/i, 'Zigbee2MQTT'],
	[/node-?red/i, 'Node-RED']
];

/** The app a database path most likely belongs to, from folder and file names. */
export function guessApp(path: string): string | undefined {
	for (const [re, app] of APPS) if (re.test(path)) return app;
	return undefined;
}

/** A readable name for a discovered database: `Sonarr · sonarr.db`. */
export function candidateLabel(path: string, context?: string): string {
	const app = guessApp(`${context ?? ''}/${path}`);
	const file = basename(path);
	return app ? `${app} · ${file}` : context ? `${context} · ${file}` : file;
}

/**
 * Where well-known apps keep their database inside their container. Discovery asks
 * Docker for these paths directly (cheap HEAD requests) before listing any folder.
 */
export const KNOWN_CONTAINER_PATHS = [
	'/config/data/jellyfin.db',
	'/config/data/library.db',
	'/config/data/data/jellyfin.db',
	'/config/data/data/library.db',
	'/data/data/jellyfin.db',
	'/data/db.sqlite3',
	'/config/sonarr.db',
	'/config/radarr.db',
	'/config/prowlarr.db',
	'/config/lidarr.db',
	'/config/readarr.db',
	'/config/whisparr.db',
	'/config/db/bazarr.db',
	'/config/tautulli.db',
	'/config/home-assistant_v2.db',
	'/app/data/kuma.db',
	'/app/config/db/db.sqlite3',
	'/data/gitea/gitea.db',
	'/var/lib/gitea/data/gitea.db',
	'/var/lib/grafana/grafana.db',
	'/etc/pihole/pihole-FTL.db',
	'/etc/pihole/gravity.db',
	'/config/absdatabase.sqlite',
	'/data/database.sqlite',
	'/config/db.sqlite3',
	'/home/node/.n8n/database.sqlite',
	'/appdata/db/db.sqlite',
	'/data/navidrome.db',
	'/data/headscale/db.sqlite',
	'/var/lib/headscale/db.sqlite',
	'/data/memos_prod.db',
	'/var/opt/memos/memos_prod.db',
	'/data/db.sqlite',
	'/app/data/db.sqlite3'
];

/** Mount destinations that hold media or bulk data rather than app state; never listed. */
export function isBulkMount(destination: string): boolean {
	return /^\/(media|movies|tv|music|photos|pictures|downloads|books|audiobooks|podcasts|video|videos|data\/media|mnt|srv\/media|backups?|var\/run|run|dev|proc|sys)(\/|$)/i.test(destination) || /docker\.sock$/.test(destination);
}
