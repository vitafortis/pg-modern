<p align="center">
  <img src="docs/logo.svg" width="64" height="64" alt="" />
</p>

<h1 align="center">pg·modern</h1>

<p align="center">
  A modern, self-hosted database console for the homelab — Postgres, MySQL, MariaDB and SQLite.<br />
  It finds your databases in Docker and <code>.env</code> files, keeps the credentials encrypted, and opens everything read-only.
</p>

<p align="center">
  <img src="docs/screenshots/overview.png" alt="pg·modern overview" />
</p>

## Features

- **Postgres, MySQL and MariaDB**: one console for both protocols, so the databases behind Nextcloud, Ghost, BookStack, Firefly III, PhotoPrism or WordPress sit next to your Postgres ones. MariaDB is told apart from MySQL by its version string.
- **SQLite**: open the database files behind Jellyfin, Sonarr/Radarr/Prowlarr, Vaultwarden, Home Assistant, Uptime Kuma and friends — found in your scan folders and container mounts, read-only by default, or (opt-in) copied out of containers as read-only snapshots. See [SQLite](#sqlite).
- **Discover**: finds database containers on your Docker hosts, connection strings in app containers, credentials in `.env`, `compose.yaml` and Terraform files, and every project managed by [Arcane](https://getarcane.app) through its API. Import them in one click.
- **Encrypted storage**: connection passwords are sealed with AES-256-GCM. Discovered secrets never reach the browser.
- **Read-only by default**: every query runs in a `READ ONLY` transaction that is always rolled back (on MySQL/MariaDB only reads get through at all). Writes are opt-in per connection or unlocked for a few minutes at a time, and destructive statements still ask first.
- **Access control and audit**: give viewers every connection or only selected ones, let specific people unlock writes temporarily, and see every query and change in the audit log.
- **Browse**: schema tree; filter, sort, page and export tables; inspect JSON cells; view columns, indexes, constraints, foreign keys and triggers.
- **Edit rows**: with write access, double-click a cell to edit it (text, numbers, true/false, NULL, JSON, enums), add rows and select rows to delete. Changes are staged and highlighted until you review the exact SQL and apply it in one transaction. Rows are matched on their full primary key (or a unique key on NOT NULL columns), and the old values of the edited columns are checked, so a row someone else changed in the meantime is reported instead of overwritten. Tables without a key only accept new rows.
- **CSV import**: upload a file (up to 50 MB), check the detected delimiter and header, preview the first rows, map CSV columns to table columns, then insert in batches inside one transaction: all rows or none, with the failing row and line reported. Choose what happens to existing keys (stop, skip or update), empty the table first (type its name to confirm), or create a new table from the file with inferred, editable column types.
- **Query**: SQL editor with schema-aware autocomplete. Run the statement under the cursor (`⌘↵`) or the whole script (`⇧⌘↵`), cancel long queries, keep a per-connection history, and export results to CSV or JSON.
- **Saved queries**: name, describe and share queries per connection or for every connection; open them from the workspace header.
- **EXPLAIN**: on Postgres, a visual plan tree with self time, misestimated row counts, buffers and the slowest node highlighted; `EXPLAIN ANALYZE` of a write runs inside a transaction that's rolled back. On MySQL the tree plan (`EXPLAIN ANALYZE` for reads on 8.0.18+), on MariaDB the JSON plan (`ANALYZE FORMAT=JSON` for reads).
- **Server overview and activity**: version, size, cache hit ratio, extensions (storage engines and grants on MySQL); live sessions with lock chains, waiting and idle-in-transaction sessions, database and table sizes, dead tuples and unused indexes (Postgres) or the process list, InnoDB lock waits and index sizes (MySQL/MariaDB). Cancel or terminate a session (`KILL QUERY` / `KILL` on MySQL) once writes are unlocked.
- **Alerts**: background checks for unreachable databases, connections near `max_connections`, long-running queries, database size and growth, transaction ID wraparound and replication lag, sent to ntfy, Gotify, Discord, Slack-compatible webhooks, a generic JSON webhook or Apprise.
- **Size history**: hourly database and table sizes, kept for a year, with a growth chart and the fastest-growing tables in each connection's overview.
- **Health checks**: a Health tab with unused, duplicate and invalid indexes, missing foreign key indexes, bloat, vacuum, wraparound, sequences, long transactions, cache and connection usage, each with a plain-language explanation and a suggested fix to open in the editor (never run for you). See [Health checks](#health-checks).
- **Read-only user helper**: generates the SQL for a dedicated least-privilege login, applies it if you choose, and switches the connection to it. See [A read-only user for pg·modern](#a-read-only-user-for-pgmodern).
- **Database backups**: scheduled `pg_dump` / `mariadb-dump` dumps (hourly, daily or weekly, with retention) to a folder, an NFS/SMB share, an SFTP server or S3-compatible storage such as MinIO. Download, restore and test destinations from the UI.
- **Backup & restore**: an encrypted, passphrase-protected file with connections, users and settings that restores on a fresh install.
- **Users and SSO**: sign in with any OIDC provider (Authentik, Authelia, Keycloak, Pocket ID, Google, …). Accounts can be created automatically for matching emails. *Admins* manage everything; *viewers* browse and query read-only.
- **Schema diagram**: an ER view of each schema (each database, on MySQL) built from its foreign keys.
- **Schema history and diff**: snapshot a schema (tables, columns, keys, indexes, views, functions, triggers, types, extensions) before an upgrade, then compare any two of: a snapshot, the live schema, or another connection's schema on the same engine. Changes are grouped by object type, with column-level detail, text diffs of view and function definitions, and a best-effort draft migration. Optionally, pg·modern checks the schema every 6 hours and stores a snapshot when it changed, so app upgrades show up in the timeline.
- **Command palette**: `⌘K` (`Ctrl+K` on Linux/Windows) searches connections, tables and views, pages, saved queries and actions from anywhere.
- **Status API for dashboards**: read-only API tokens for Homepage, Glance, Uptime Kuma and Home Assistant (see [Dashboards and monitoring](#dashboards-and-monitoring)).
- **Light and dark** themes, and multi-arch images (`amd64`, `arm64`).

## Getting started

### Docker Compose (recommended)

```sh
mkdir pg-modern && cd pg-modern
curl -fsSLO https://raw.githubusercontent.com/vitafortis/pg-modern/main/compose.yaml
# edit the /opt/stacks volume to point at where your stacks live
docker compose up -d
```

Open `http://<your-host>:3030`. A short setup wizard creates the admin account (name, email, password) and optionally connects Arcane and your stacks folders. Then go to **Discover**:

1. **Containers** lists every Postgres, MySQL and MariaDB server (and app credentials) it found through the Docker API. Use **Running only** and **Reachable only** to cut the noise.
2. **Files** scans the mounted stacks folder. You can add more folders right there.
3. Tick what you want, rename anything you like, and **Import**. New connections are read-only.

The default [`compose.yaml`](compose.yaml) runs pg·modern next to a [read-only Docker socket proxy](https://github.com/Tecnativa/docker-socket-proxy), so it never gets the raw socket.

### `docker run`

```sh
docker run -d --name pg-modern \
  -p 3030:3000 \
  -v pg-modern-data:/data \
  -v /opt/stacks:/stacks:ro -e PGM_SCAN_PATHS=/stacks \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  --group-add "$(stat -c %g /var/run/docker.sock)" \
  --add-host host.docker.internal:host-gateway \
  ghcr.io/vitafortis/pg-modern:latest
```

The container runs as an unprivileged user. `--group-add` gives it read access to the Docker socket. Leave the socket mount out if you don't want container discovery.

### Using Arcane?

If [Arcane](https://getarcane.app) manages your stacks, you don't need to mount anything. Through Arcane's API, pg·modern reads every container (environment variables, published ports, networks) and every project's compose file and `.env`, across every environment (host) Arcane manages. That includes databases that aren't Arcane projects.

1. In Arcane, go to **Settings → API Keys** and create a key with only these read-only permissions: `environments:list`, `projects:list`, `projects:read`, `containers:list` and `containers:read`. Without the two container permissions, only Arcane projects are scanned.
2. In pg·modern, open **Integrations → Arcane**, enter your Arcane URL (e.g. `http://arcane.lan:3552`) and the key, then **Test** and **Connect**. Or set `PGM_ARCANE_URL` and `PGM_ARCANE_API_KEY`.
3. Open **Discover → Arcane**.

Published ports resolve to each environment's host address. The API key is stored encrypted, like database passwords.

If you'd rather scan the files directly, run pg·modern on the Arcane host and mount the projects folder at the same path, e.g. `- /opt/projects:/opt/projects:ro`. If Arcane writes `.env` files readable only by root, the container's non-root user can't read them; that's another reason to prefer the API.

### Reaching your databases

pg·modern connects from inside its own container, so for each database it needs a route.

- **Published ports** (`5432:5432`) work out of the box through `host.docker.internal`.
- **Unpublished databases** need pg·modern on the same Docker network. Add the network to the `pg-modern` service (see the comments in `compose.yaml`).
- **Remote hosts** just need the host and port.

Discovery probes every address it knows for a server and preselects the first one that answers. It also shows which Docker networks each database is on, which of them pg·modern shares, and for databases it can't reach, the compose change that attaches pg·modern to the right network. pg·modern finds its own container by hostname or IP; set `PGM_SELF_CONTAINER` if you gave it a custom hostname.

When a saved connection's address changes (a new port, a moved container), Discover flags it and can update the saved connection in place.

## Users and SSO

pg·modern has two roles:

| | Admin | Viewer |
| --- | --- | --- |
| Browse tables, run queries | ✓ | ✓ (all connections, or only the ones you pick) |
| Write (queries, row editing, CSV import) | ✓ on read/write connections; unlock read-only ones for 5–60 min | only by unlocking, on connections you allow |
| Add, edit and delete connections | ✓ | |
| Discover, Settings, Users, Audit log, Backups | ✓ | |

Set a viewer's access from **Users → Connections**. Every unlock is time-limited, needs no restart, and is recorded with its reason. The **Audit log** lists every query (who, where, whether it wrote, how it ended), every row edit and CSV import (`rows.edit`, `rows.import`, with counts; the generated SQL is in the query history), and every sign-in, connection, user, access and settings change.

The first admin is created by the setup wizard, or headlessly with `PGM_ADMIN_EMAIL` and `PGM_ADMIN_PASSWORD`, which create it on first start and skip the wizard. Add more people from the **Users** page, or let them sign in through SSO. Everyone can change their name, email and password under **My account** (click your name in the sidebar).

**Upgrading from a version without accounts?** Your old password still works. Sign in as **`admin`**, and pg·modern asks once for your name and email; after that, sign in with your email.

### OIDC

Create an OIDC client in your identity provider (confidential, authorization code flow) with this redirect URI:

```
https://<your pg-modern host>/auth/oidc/callback
```

Then open **Integrations → Single sign-on** in pg·modern:

1. Pick your provider, then fill in the issuer URL, client ID and secret.
2. Click **Test**, then **Enable single sign-on**.
3. Optionally set who gets an account automatically and who becomes an admin.
4. Once SSO works, you can turn off password sign-in on the same card.

The redirect URI to register is shown there, with a copy button. Or configure it with environment variables, which then lock the UI fields:

```yaml
environment:
  PGM_OIDC_ISSUER: https://auth.example.com/application/o/pg-modern/
  PGM_OIDC_CLIENT_ID: pg-modern
  PGM_OIDC_CLIENT_SECRET: ${PGM_OIDC_CLIENT_SECRET}
  PGM_OIDC_NAME: Authentik                       # login button label
  PGM_OIDC_AUTO_CREATE: "*@example.com,friend@gmail.com"
  PGM_OIDC_ADMIN_EMAILS: you@example.com
  # PGM_LOCAL_LOGIN: disabled                    # SSO only, once it works
```

If SSO breaks while password sign-in is off, start pg·modern with `PGM_LOCAL_LOGIN=enabled` to get the password form back.

When someone signs in:

1. If their SSO identity is already linked to an account, they're in.
2. Otherwise, if an admin added their email on the Users page, that account is linked on first login.
3. Otherwise, if their email matches `PGM_OIDC_AUTO_CREATE`, an account is created: admin when they also match `PGM_OIDC_ADMIN_EMAILS`, otherwise `PGM_OIDC_DEFAULT_ROLE` (viewer).
4. Anyone else is turned away.

Emails the provider marks as unverified are rejected. An email that's already linked to one SSO identity can't be claimed by another. The flow uses PKCE, state and nonce. Disabling a user or changing their role signs them out immediately.

Behind a reverse proxy, set `PROTOCOL_HEADER` and `HOST_HEADER` so the callback URL is built with your public address, or set a redirect URI override under **Advanced**.

## Schema history

Open a connection and click **Schema** (or `⌘K` → *Schema history*).

- **Snapshot** stores the current schema with a label and an optional note. Anyone who can see the connection can take one; the author or an admin can delete it. Snapshots are capped at 5 MB (function bodies are dropped first, keeping their hashes) and the last 50 per connection are kept.
- **Compare** any two sides: a snapshot or the live schema, of this connection or another connection on the same engine (e.g. staging vs production). Renames show up as a removal plus an addition.
- **Draft migration SQL** covers the simple cases (new tables, added columns, nullability, defaults, indexes, views, functions). Drops are left commented out, and everything else is listed to handle by hand. It never runs on its own.
- **Auto snapshot on change** (admins, per connection): every 6 hours the schema is read and hashed; when the hash differs from the latest snapshot, a new snapshot is stored. **Check now** runs the check on demand.

Postgres snapshots skip objects owned by extensions (they're covered by the extension's version) and partitions. MySQL/MariaDB snapshots cover every database the account can see, except the system ones.

## Command palette

Press `⌘K` on macOS or `Ctrl+K` elsewhere. Type to fuzzy-search connections, pages, tables and views (from the open connection and recently opened ones; cached for 5 minutes), saved queries, and actions (new query, schema history, snapshot, new connection, theme, sidebar, lock writes, sign out). Recently used items come first. Use `↑`/`↓` and `↵`.

`⌘K` used to open a new query tab in a connection; now **New query** is the first item there, so `⌘K` `↵` does the same. The SQL editor doesn't bind `⌘K`; on macOS, `Ctrl+K` stays the editor's "delete to end of line".

## Dashboards and monitoring

Create a token under **Integrations → Status API tokens** (admins). It's shown once; only its SHA-256 is stored. Tokens can expire, can be revoked, and record when they were last used. They open these routes only, and only for `GET`. They're never accepted as a session anywhere else.

| Route | Returns |
| --- | --- |
| `GET /api/status` | `{ connections, online, offline, checkedAt, items: [...] }` |
| `GET /api/status/<id>` | one item; add `?strict=1` to get HTTP 503 while it's down |
| `GET /api/status/badge/<id>.svg` | a shields-style badge (`?label=` sets the left text) |

Each item has `id`, `name`, `engine`, `flavor`, `status` (`up` / `down`), `latencyMs`, `sizeBytes`, `version`, `lastCheckedAt` and, when down, a short `error` code such as `ECONNREFUSED`. Host, port and database name are included only if the token was created with **Include addresses**. Results are cached for 30 seconds, so frequent polling doesn't load your databases. Connection ids are in the `/api/status` output and in the URL of each connection (`/c/<id>`).

Send the token as `Authorization: Bearer pgm_…`. Widgets that can't set headers can use `?token=pgm_…`. URLs end up in reverse-proxy logs and browser history, so prefer the header, and give such a widget its own token that you can revoke on its own.

```sh
curl -H "Authorization: Bearer $PGM_TOKEN" http://pg-modern.lan:3030/api/status
```

**[Homepage](https://gethomepage.dev)** (`services.yaml`, customapi widget):

```yaml
- Databases:
    - pg·modern:
        href: http://pg-modern.lan:3030
        widget:
          type: customapi
          url: http://pg-modern.lan:3030/api/status
          refreshInterval: 60000
          headers:
            Authorization: Bearer pgm_xxxxxxxx
          mappings:
            - field: online
              label: Online
            - field: offline
              label: Offline
            - field: connections
              label: Total
```

**[Glance](https://github.com/glanceapp/glance)** (custom-api widget):

```yaml
- type: custom-api
  title: Databases
  cache: 1m
  url: http://pg-modern.lan:3030/api/status
  headers:
    Authorization: Bearer pgm_xxxxxxxx
  template: |
    <ul class="list list-gap-10">
    {{ range .JSON.Array "items" }}
      <li class="flex justify-between">
        <span>{{ .String "name" }}</span>
        {{ if eq (.String "status") "up" }}
          <span class="color-positive">up · {{ .Int "latencyMs" }} ms</span>
        {{ else }}
          <span class="color-negative">down</span>
        {{ end }}
      </li>
    {{ end }}
    </ul>
```

**[Uptime Kuma](https://github.com/louislam/uptime-kuma)**: add an *HTTP(s) - Json Query* monitor for `http://pg-modern.lan:3030/api/status/<id>` with the header `{"Authorization": "Bearer pgm_xxxxxxxx"}`, JSON query `status` and expected value `up`. Or use an *HTTP(s) - Keyword* monitor with keyword `"status":"up"`, or a plain *HTTP(s)* monitor on `…/api/status/<id>?strict=1`, which answers 503 while the database is down.

**[Home Assistant](https://www.home-assistant.io/integrations/rest/)** (`configuration.yaml`):

```yaml
rest:
  - resource: http://pg-modern.lan:3030/api/status
    scan_interval: 60
    headers:
      Authorization: !secret pgm_status_token   # "Bearer pgm_xxxxxxxx"
    sensor:
      - name: Databases online
        value_template: "{{ value_json.online }}"
        unit_of_measurement: databases
      - name: Databases offline
        value_template: "{{ value_json.offline }}"
        unit_of_measurement: databases
    binary_sensor:
      - name: Nextcloud database
        device_class: connectivity
        value_template: >
          {{ (value_json['items'] | selectattr('name', 'eq', 'Nextcloud') | map(attribute='status') | first) == 'up' }}
```

**Badge** in a wiki or dashboard (image tags can't send headers, so use a dedicated token): `![db](http://pg-modern.lan:3030/api/status/badge/<id>.svg?token=pgm_xxxxxxxx)`.

## Images

Images are published to the GitHub Container Registry for `linux/amd64` and `linux/arm64`:

| Tag | Tracks |
| --- | --- |
| `ghcr.io/vitafortis/pg-modern:latest` | the latest build of `main` |
| `ghcr.io/vitafortis/pg-modern:1`, `:1.2`, `:1.2.3` | releases (`v*` tags) |
| `ghcr.io/vitafortis/pg-modern:sha-abc1234` | a specific commit |

To build it yourself: `docker build -t pg-modern .`

## Screenshots

| | |
| --- | --- |
| ![Discover containers](docs/screenshots/discover.png) | ![Discover files](docs/screenshots/discover-files.png) |
| **Discover**: containers, with reachability and saved-state badges | **Discover**: `.env` and compose files |
| ![Discover via Arcane](docs/screenshots/discover-arcane.png) | ![Users](docs/screenshots/users.png) |
| **Discover**: Arcane projects across environments | **Users**: admins and read-only viewers |
| ![Table browser](docs/screenshots/table.png) | ![Query editor](docs/screenshots/query.png) |
| **Browse**: virtualized grid with a JSON cell inspector | **Query**: runs in a read-only transaction that is rolled back |
| ![Structure](docs/screenshots/structure.png) | ![Server overview](docs/screenshots/server.png) |
| **Structure**: columns, indexes, constraints | **Server overview** |
| ![Integrations](docs/screenshots/integrations.png) | ![Sign in](docs/screenshots/login.png) |
| **Integrations**: SSO, Arcane, Docker and folders | **Sign in**: SSO or password |
| ![Setup wizard](docs/screenshots/setup.png) | ![Light theme](docs/screenshots/overview-light.png) |
| **First run**: setup wizard | **Light theme** |

## SQLite

A SQLite connection is a database file, so there's no host, user or password: choose **SQLite** in the connection dialog and enter the path as pg·modern sees it (inside its container, mount the app's folder — `/opt/appdata:/appdata:ro` — and use `/appdata/sonarr/sonarr.db`). Browsing, the query editor, structure, the schema diagram, autocomplete, history, saved queries and the audit log work as for the other engines. The overview shows the file and `-wal` sizes, page size, journal mode, free pages and the largest tables (sizes from `dbstat` and exact row counts for files up to 1 GB, `sqlite_stat1` estimates above). Explain shows `EXPLAIN QUERY PLAN` as a tree; there's no `EXPLAIN ANALYZE` and no Activity tab, since there's no server.

- **Read-only** connections open the file with `SQLITE_OPEN_READONLY` and a `mode=ro` URI, turn on `PRAGMA query_only`, run each script in a transaction that is rolled back, and only let `SELECT`, `VALUES`, `EXPLAIN` and read-only pragmas through — a read-only handle would still run `VACUUM INTO '/somewhere'` (which writes a new file) and `ATTACH`, so those are refused, as are pragmas that change settings and `load_extension()`. Live databases are never opened `immutable`.
- **Writes** follow the usual permission model (a read/write connection or a temporary unlock; `DROP`, `DELETE`/`UPDATE` without `WHERE` ask first). They go straight into the file the app is using, so keep them small or stop the app first.
- **Locks**: statements wait up to 5 s (`PGM_SQLITE_BUSY_TIMEOUT_MS`) for the owning app's write lock instead of failing at once. Queries run off the main thread — introspection on worker threads, scripts in a short-lived child process — so a long query never blocks the UI, and **Cancel** or the statement timeout kills it outright.
- **WAL databases** (most apps use WAL) need their `-shm` and `-wal` files readable to be read, or a writable folder so SQLite can create them. A WAL database in a folder mounted `:ro` whose app isn't running (so there's no `-shm`) fails to open; pg·modern says so and suggests mounting the folder read-write (the file is still opened read-only) or using a snapshot.
- pg·modern's own data folder can't be opened as a connection.

**Discovery.** Scan folders are searched for `*.db`, `*.sqlite`, `*.sqlite3`, `*.db3` and well-known names (`home-assistant_v2.db`, `kuma.db`, `db.sqlite3`, …); a file only counts if its first 16 bytes are `SQLite format 3\0`. `-wal`, `-shm`, `-journal`, backups, caches and browser profiles are skipped. Each candidate is labelled with the app its path suggests (`Sonarr · sonarr.db`, `Vaultwarden · db.sqlite3`). On the **Containers** tab, a container's bind mounts that pg·modern can also see under one of its scan folders (the same host path mounted at the same place) are searched too, and opened in place.

### Reading SQLite from containers (opt-in)

Databases in named volumes or folders pg·modern can't mount are reachable through the Docker API's archive endpoint. Turn on **Integrations → SQLite in containers → Read SQLite files from containers via the Docker API**:

- Discovery `HEAD`s known app paths under each container mount (`/config/sonarr.db`, `/data/db.sqlite3`, `/app/data/kuma.db`, `/config/home-assistant_v2.db`, Jellyfin's `/config/data/jellyfin.db`, …; the `X-Docker-Container-Path-Stat` header gives the size), then streams a tar listing of each mount that isn't media or downloads, checking the header of every database-looking file, and stops after 64 MB / 5000 entries per mount.
- Importing one copies the database — and its `-wal` and a hot `-journal`, if present — with `GET /containers/{id}/archive` into `/data/sqlite-snapshots/`, merges the WAL into the copy and opens it read-only and `immutable`. The workspace shows **Snapshot of container:/path taken at …** with a **Refresh snapshot** button (anyone who can see the connection may refresh; it's audited). Snapshot connections are always read-only: writes would only change the copy, so they can't be unlocked.
- **Size cap**: database plus `-wal` up to 512 MB by default, configurable on the same card.
- **Consistency**: this copies a live database. The file is re-copied if it changed during the copy, and including the `-wal` makes the snapshot consistent in practice, but it isn't a transactional backup — refresh to see newer data.
- **Proxies**: these are `GET`/`HEAD` requests. [tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) allows them with the `CONTAINERS=1` it already needs (its rule `^(/v[\d.]+)?/containers` is a prefix match, and `POST=0` denies every method except GET/HEAD, so `PUT …/archive` — writing into a container — stays blocked). [linuxserver/socket-proxy](https://github.com/linuxserver/docker-socket-proxy) additionally needs `ALLOW_ARCHIVE=1`.
- **Security implications**: the archive endpoint can read *any* file in *any* container — secrets, keys, `.env` files — not just databases. With `CONTAINERS=1` the proxy already permits that to anything that can reach it; this setting only decides whether pg·modern uses it. Enable it only if you trust everyone who administers pg·modern (only admins can turn it on or import snapshots), and keep the proxy on a private network.
- **Arcane**: Arcane's API has no container file access; its volume "workspace" download works by starting a helper container and exec'ing into it, which isn't read-only from Docker's point of view, so pg·modern doesn't use it. Point pg·modern at the Docker endpoints (or socket proxies) of those hosts instead.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `PGM_DATA_DIR` | `./data` (`/data` in the image) | Encrypted SQLite store and key file |
| `PGM_SECRET_KEY` | — | Master secret. Unset means a random key is generated in `secret.key` |
| `PGM_SCAN_PATHS` | — | Comma-separated folders to scan (more can be added under Integrations) |
| `PGM_SCAN_DEPTH` | `6` | How deep to recurse into scan folders |
| `PGM_SELF_CONTAINER` | — | pg·modern's own container name, if Discover can't find it by hostname (used to show which databases share a network with it) |
| `PGM_DOCKER_HOSTS` | local socket | `unix://…` or `tcp://host:2375`, comma-separated |
| `PGM_ARCANE_URL`, `PGM_ARCANE_API_KEY` | — | An Arcane instance to read projects from (or add it under Integrations) |
| `PGM_STATEMENT_TIMEOUT_MS` | `30000` | Per-statement timeout |
| `PGM_MAX_ROWS` | `5000` | Rows returned per result; the rest are truncated |
| `PGM_IMPORT_MAX_MB` | `50` | Largest CSV file that can be imported. Outside the Docker image (which sets `BODY_SIZE_LIMIT=64M`), also raise the server's `BODY_SIZE_LIMIT` (default `512K`) |
| `TZ` | `UTC` | Time zone for backup schedules, e.g. `Europe/Berlin` |
| `PGM_SQLITE_BUSY_TIMEOUT_MS` | `5000` | How long a SQLite statement waits for another process's lock |
| `PGM_ADMIN_EMAIL`, `PGM_ADMIN_PASSWORD`, `PGM_ADMIN_NAME` | — | Create the first admin on start instead of using the setup wizard |
| `PGM_AUTH` | — | `disabled` skips the login screen (trusted networks only) |
| `PGM_LOCAL_LOGIN` | — | `disabled` hides the email/password form (SSO only); `enabled` forces it back on |
| `PGM_OIDC_ISSUER` | — | OIDC issuer URL; enables SSO (or configure it under Integrations) |
| `PGM_OIDC_CLIENT_ID`, `PGM_OIDC_CLIENT_SECRET` | — | Client credentials from your identity provider |
| `PGM_OIDC_NAME` | `SSO` | Login button label |
| `PGM_OIDC_SCOPES` | `openid email profile` | Requested scopes |
| `PGM_OIDC_AUTO_CREATE` | — | Emails that get an account on first login: `*@example.com`, `bob@gmail.com`, `*` |
| `PGM_OIDC_ADMIN_EMAILS` | — | Auto-created accounts matching these become admins |
| `PGM_OIDC_DEFAULT_ROLE` | `viewer` | Role for other auto-created accounts |
| `PGM_OIDC_REDIRECT_URI` | `<origin>/auth/oidc/callback` | Override when the public URL can't be inferred |
| `PROTOCOL_HEADER`, `HOST_HEADER` | — | Set to `x-forwarded-proto` / `x-forwarded-host` behind a TLS reverse proxy |

## How discovery works

**Containers.** Every container on each Docker endpoint is inspected.

- Postgres servers are recognized by image (`postgres`, `postgis`, `timescaledb`, `pgvector`, `bitnami/postgresql`, `immich-app/postgres`, …) or by `POSTGRES_PASSWORD` / `PGDATA` in their environment.
- MySQL and MariaDB servers by image (`mysql`, `mariadb`, `percona`, `mysql/mysql-server`, `linuxserver/mariadb`, `bitnami/mysql`, `bitnami/mariadb`, `yobasystems/alpine-mariadb`, …), by root-level variables only a server sets (`MYSQL_ROOT_PASSWORD`, `MARIADB_ROOT_PASSWORD`, `MYSQL_ALLOW_EMPTY_PASSWORD`, …) or an exposed `3306`. phpMyAdmin, Adminer, exporters, proxies and backup tools are skipped.
- Credentials come from `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB`, plus the Bitnami equivalents; for MySQL/MariaDB both the app user (`MYSQL_USER` / `MARIADB_USER` with its password and database) and `root` (when a root password is set or allowed empty) are offered. Passwords kept in `*_FILE` secrets are flagged so you can type them in.
- App containers are scanned for connection strings too. When an app points at a sibling container by service name, the candidate is rewritten to an address pg·modern can reach.

**Arcane.** For each environment, every container is inspected through the API, with the same detection as local Docker. Each project's compose and `.env` content also goes through the same parser as files on disk. Results are merged per compose project.

**Files.** Scan folders are walked for `.env`, `.env.*`, `*.env`, `compose.yaml` / `docker-compose.yml` and Terraform files (`*.tf`, `*.tfvars`, `terraform.tfstate`).

- `node_modules`, `.git`, `.terraform`, `*.example` and similar are skipped.
- From each file pg·modern picks up:
  - `postgres://`, `mysql://` and `mariadb://` URLs in any variable (`mysql+pymysql://` and `jdbc:` forms too)
  - grouped keys like `DB_HOST` / `DB_USER` / `DB_PASSWORD`, `PGHOST` / `PGUSER`, `PAPERLESS_DBHOST`, `POSTGRES_*`, `MYSQL_*` / `MARIADB_*` (Nextcloud), `WORDPRESS_DB_*`, Ghost's `database__client=mysql` + `database__connection__*`, PhotoPrism's `PHOTOPRISM_DATABASE_DRIVER=mysql` + `…_SERVER=host:port`, and anything with a `DB_CONNECTION` / `*_DB_TYPE` / `*_DRIVER` naming its engine (Laravel apps like Firefly III and BookStack, Gitea, …). Without an explicit engine, port `3306` or the server container the app points at decides.
  - Compose services, with `${VAR:-default}` interpolation from the neighbouring `.env`
  - Terraform modules (each folder read as a whole): the `postgresql` provider and its login roles, the `mysql` provider (`endpoint`, `username`, `password`), `docker_container` resources, and database URLs in any attribute. `var.*` comes from `*.auto.tfvars`, `terraform.tfvars`, other `*.tfvars` and variable defaults; `local.*` from `locals`. A local `terraform.tfstate` adds computed values (generated passwords) plus RDS / Aurora instances running Postgres, MySQL or MariaDB. Values that can't be resolved are flagged on the candidate.
- Groups that declare SQLite (`DB_CONNECTION=sqlite`, `database__client=sqlite3`) point at a path inside the app's container, so they're not turned into candidates; the database file itself is found by the SQLite file scan (see [SQLite](#sqlite)).

Scan results stay on the server, and an import refers to them by key, so a discovered password goes straight into the encrypted store.

## Alerts

**Alerts** (admins only) checks every connection in the background, once a minute by default, and notifies you when something needs attention.

**Channels.** Add one or more under **Alerts → Channels**, and use **Send test** to check it works. Every enabled channel gets every notification.

| Channel | What you enter |
| --- | --- |
| ntfy | Server URL (`https://ntfy.sh` or your own), topic, optional access token |
| Gotify | Server URL and an application token |
| Discord | A channel webhook URL |
| Slack-compatible | An incoming-webhook URL (Slack, Mattermost, Rocket.Chat, …) |
| Webhook (JSON) | Any URL, plus an optional `Authorization` header |
| Apprise API | A notify URL such as `http://apprise:8000/notify/<key>`, optional tag |

Tokens, webhook URLs and the authorization header are encrypted like connection passwords and never sent back to the browser (the UI only shows the host). Leave a secret field blank when editing to keep it.

The generic webhook receives a `POST` with `Content-Type: application/json`:

```json
{
  "source": "pg-modern",
  "version": 1,
  "event": "fired",
  "severity": "critical",
  "status": "firing",
  "title": "[FIRING] nextcloud-db: Database unreachable",
  "alert": "Database unreachable",
  "message": "Can’t connect: connect ECONNREFUSED 10.0.0.5:5432",
  "rule": { "id": "…", "kind": "unreachable" },
  "connection": { "id": "…", "name": "nextcloud-db", "engine": "postgres" },
  "value": null,
  "since": "2026-10-09T10:00:00.000Z",
  "at": "2026-10-09T10:01:00.000Z",
  "url": "https://pgm.example.com/c/…"
}
```

`event` is `fired`, `resolved`, `renotified` or `test`; `status` is `firing`, `resolved` or `test`; `severity` is `critical` or `warning`; `rule.kind` is one of the rule kinds below; `value` is the measured number when there is one (percent, seconds, bytes); `url` is set when a public URL is configured under **Rules**.

**Rules.** Adding the first channel turns on a default set, and **Add default rules** brings back any you deleted:

| Rule | Default | |
| --- | --- | --- |
| Database unreachable | 2 failed checks in a row | Notifies again when it recovers |
| Connections near the limit | > 80% of `max_connections` | Client connections only |
| Long-running query | > 15 min | Active queries only; idle sessions, replication and autovacuum are ignored |
| Database size above | > 50 GB | Off by default |
| Fast database growth | > 25% in 24 h | Needs a day of size history |
| Transaction ID wraparound | `age(datfrozenxid)` > 50% of 2³¹ | Postgres only |
| Replication lag | > 300 s | Replay lag of replicas (on a primary) or of this server (on a replica); skipped without replication |

A rule applies to all connections, or to one. A connection's own rule replaces the all-connections rule of the same kind, so you can raise a threshold for one database, or turn a check off for it by disabling its rule.

**State and notifications.** Each (rule, connection) pair has its own state: *ok → pending → firing → ok*. pg·modern only notifies on transitions: when an alert fires, when it resolves (unless "Notify resolved" is off for that rule) and, while it keeps firing, again after the re-notify interval (6 h by default, 0 for never). While a database is unreachable, its other alerts keep their state rather than resolving. Every transition is kept in **Active & history**, with whether it reached the channels. Firing alerts also show as a bell on the connection's card in the overview and in the sidebar, for anyone who can see that connection.

Checks are read-only, like everything else: each check uses one session per database through the normal read-only pool, with a 10 s statement timeout and a 2 s lock timeout. On MySQL/MariaDB, long queries and replication lag need the `PROCESS` and `REPLICATION CLIENT` privileges; without them, those rules stay quiet.

## Size history

Once an hour, pg·modern records each connection's database size (on a MySQL login without a default database: all user databases) and its 50 largest tables: `pg_total_relation_size` on Postgres (estimated from `relpages` for tables locked by a migration or `VACUUM FULL`, so sampling never waits behind a lock), `DATA_LENGTH + INDEX_LENGTH` from `information_schema.TABLES` on MySQL/MariaDB. Hourly samples are kept for 14 days, then rolled up to one per day (the day's last sample) and kept for a year. Removing a connection deletes its history.

Each connection's **Overview** has a **Growth** chart for 7 days (hourly), 30 days or a year (daily), and the tables that grew most over that range. Admins can **Sample** to take a reading right away. The data is also available at `GET /api/connections/<id>/growth?range=7d|30d|1y` to anyone who can see the connection.
## Database backups

**Backups** (admins only) dumps your databases on a schedule and keeps them on a NAS or in object storage.

- **Postgres** uses `pg_dump --format=custom`, which compresses on its own and restores with `pg_restore`. The image ships PostgreSQL 18's client, which dumps and restores servers from 9.2 to 18 (`pg_dump` must be at least as new as the server).
- **MySQL and MariaDB** use `mariadb-dump --single-transaction --routines --triggers --events --hex-blob`, gzipped. A connection with a default database dumps that database; one without (e.g. `root`) dumps every non-system database. The MariaDB client also backs up MySQL 5.7–8.4; MySQL-only features it doesn't know (some 8.x DDL) may not round-trip, so test a restore once.
- Passwords go to the tools through the environment (`PGPASSWORD`, `MYSQL_PWD`), never the command line. Dumps stream straight to the destination; nothing is staged on local disk. A dump only reads, so read-only connections can be backed up.
- The login needs read access to everything it dumps: on MySQL `SELECT`, `SHOW VIEW`, `TRIGGER`, `EVENT` and `LOCK TABLES`.

### Destinations

| Type | For | Notes |
| --- | --- | --- |
| **Folder** | A path inside the container, typically an NFS or SMB/CIFS share mounted as a Docker volume | The recommended NAS route; nothing to install on the NAS |
| **SFTP** | Synology, TrueNAS, Unraid, any SSH server | Password or private key. **Test** shows the server's host key; pin it to refuse anything else |
| **S3-compatible** | MinIO, Garage, TrueNAS, Synology C2, Backblaze B2, AWS | Endpoint, region, bucket, prefix, keys, path-style toggle. Uploads stream in 16 MiB multipart chunks, up to ~156 GiB per dump |

**Test** writes, reads back and deletes a small file. Destination passwords and keys are encrypted like connection passwords and never sent back to the browser.

To put backups on a NAS without mounting anything on the host, let Docker mount the share (also in [`compose.yaml`](compose.yaml)):

```yaml
services:
  pg-modern:
    volumes:
      - pg-modern-data:/data
      - nas-backups:/backups   # then add a Folder destination at /backups

volumes:
  nas-backups:
    driver: local
    driver_opts:               # NFS
      type: nfs
      o: addr=nas.lan,rw,nfsvers=4
      device: ":/volume1/backups/pg-modern"
  # or SMB / CIFS:
  # nas-backups:
  #   driver: local
  #   driver_opts:
  #     type: cifs
  #     o: addr=nas.lan,username=backup,password=${NAS_PASSWORD},uid=1000,gid=1000,vers=3.0
  #     device: //nas.lan/backups/pg-modern
```

The container runs as uid 1000, so the share must be writable by it (NFS: squash or own the export to 1000; CIFS: the `uid`/`gid` options above).

### Schedules, retention and restores

- A schedule backs up one connection or **all connections**, hourly (at a minute), daily (at `HH:MM`) or weekly, in the server's time zone (set `TZ`). If pg·modern was down at the scheduled time, the schedule runs once when it starts. **Run now** starts it immediately; **Back up now** on the Runs tab makes a one-off backup.
- **Retention** runs after every successful backup: keep the last *N*, and/or everything younger than *N* days. A backup survives if either rule keeps it, and the newest one is always kept. One-off backups are never pruned.
- **Runs** lists every backup and restore with its size, duration and errors. Backups can be downloaded (streamed from the folder, SFTP or S3) or deleted.
- **Restore** puts a backup back into the same connection or another one of the same engine. The connection must accept your writes (read/write, or unlocked for a few minutes from the dialog), and you type the database name to confirm. Postgres restores use `pg_restore --clean --if-exists --no-owner`; MySQL restores pipe the dump into the `mariadb` client, with `DEFINER` clauses removed so views, routines and triggers belong to the restoring user. Every backup, download, restore and change is in the audit log.
- Running from source (`pnpm dev`), backups need `pg_dump`/`pg_restore` and `mariadb-dump`/`mariadb` (or `mysqldump`/`mysql`) on `PATH`; the page says which ones are missing.

## Backup & restore

**Settings → Backup & restore** downloads a `.pgmbackup` file with pg·modern's own configuration: connections (with their passwords), saved queries, users (password hashes, SSO links, connection access and grants), and settings (discovery, Arcane managers and their API keys, single sign-on, the password sign-in toggle). Query history, the audit log, sessions and database backup destinations and schedules aren’t included.

The file is encrypted with a passphrase you choose (12+ characters), not the master key, so it also restores on a fresh install with a different `secret.key` or `PGM_SECRET_KEY`. Restoring first shows a preview of what would be added or updated, then merges the categories you pick: connections by id, users by email. Nothing is deleted, your own account is never changed, and settings are replaced as a whole. The API is `POST /api/backup` and `POST /api/backup/restore` (admins only).

## Health checks

**Health** in a connection's header runs a set of read-only checks and lists what they found by severity (critical, warning, info). Each finding says what's affected, why it matters, and suggests SQL to fix it. Copy the SQL, or **Open in query editor** to review and run it yourself; nothing is run for you. Every check is a catalog or statistics query on the read-only path with a short statement timeout (10 s) and lock timeout (1 s), and one that fails (say, permission denied on a `pg_stat` view) shows its error inline while the rest still run. **Re-run** checks again.

| Check | Postgres | MySQL / MariaDB |
| --- | :-: | :-: |
| Transaction ID wraparound: `age(datfrozenxid)` per database, oldest `relfrozenxid` tables | ✓ | |
| Sequences near exhaustion, counting the column type (an `integer` column fed by a `bigint` sequence) | ✓ | |
| Invalid indexes (`indisvalid = false`, left by a failed `CREATE INDEX CONCURRENTLY`) | ✓ | |
| Sessions idle in a transaction for 5+ minutes | ✓ | |
| Long-running transactions (`information_schema.innodb_trx`) | | ✓ |
| Connection usage vs `max_connections` | ✓ | ✓ |
| Cache hit ratio (shared buffers) / buffer pool hit rate | ✓ | ✓ |
| Dead tuple ratio, tables never or long not vacuumed / analyzed, autovacuum off | ✓ | |
| Table bloat: an **estimate** from statistics (the widely used pgstattuple-free estimation query), labelled as such | ✓ | |
| Fragmentation (`data_free`, per-table tablespaces only) | | ✓ |
| Unused indexes (no scans since the statistics reset; not unique/PK, 1 MB+) | ✓ | ✓ (needs `performance_schema`; skipped with a note when it's off) |
| Duplicate and overlapping indexes (same columns, or a leading prefix of another btree index) | ✓ | ✓ |
| Possibly missing indexes: big tables read mostly by sequential scans (a heuristic) | ✓ | |
| Foreign keys without a supporting index | ✓ | |
| Tables without a primary key | ✓ | ✓ |
| Non-InnoDB tables (MyISAM, Aria, MEMORY, …) | | ✓ |
| Settings sanity, e.g. default `shared_buffers` on a large database (gentle info only) | ✓ | |

Statistics-based checks are only as good as the statistics: usage counters are per server (check replicas before dropping an index) and reset on restart or `pg_stat_reset()`. A role without `pg_monitor` / `pg_read_all_stats` (or `PROCESS` on MySQL) sees only its own sessions. The tab is hidden for engines without checks. The API is `GET /api/connections/:id/health`.

## A read-only user for pg·modern

pg·modern only needs to read, so the safest setup is a login that can't write at all. Open a connection's settings (admins) and choose **Create a read-only user for pg·modern** — connection cards also show a small, dismissible hint when a connection uses a superuser (`rolsuper`) or MySQL `root` / an account with global `ALL` or `SUPER`.

The dialog generates the SQL, with a strong random password (28 letters and digits):

- **Postgres**: `CREATE ROLE … LOGIN PASSWORD …` with no special attributes and `default_transaction_read_only = on`; `GRANT CONNECT ON DATABASE`; for each selected schema `GRANT USAGE`, `GRANT SELECT ON ALL TABLES` and `ON ALL SEQUENCES`; and `ALTER DEFAULT PRIVILEGES FOR ROLE <owner> … GRANT SELECT` for every role that owns objects there. Default privileges apply per *creating* role, so tables a different role creates later still need a grant. On Postgres 14+ you can pick `pg_read_all_data` instead, which covers every schema now and later. Optionally `pg_monitor` (or just `pg_read_all_stats`) for the Activity and Health tabs. The password is sent as a SCRAM-SHA-256 hash by default, so the plain text never reaches the server or its statement log.
- **MySQL / MariaDB**: `CREATE USER 'name'@'host' IDENTIFIED BY …` (host pattern `%` by default), `GRANT SELECT, SHOW VIEW ON db.*` per selected database (with `_` and `%` escaped so names match literally) or on `*.*`, and optionally `PROCESS` and `SELECT` on `performance_schema`.

Nothing runs until you choose to. **Copy** the script to run it elsewhere, or **Apply** it here: that needs write access right now (a read/write connection or unlocked writes), asks for confirmation with the password masked, runs Postgres statements in one transaction, and is recorded in the audit log. **Switch this connection to the new user** tests the new credentials and, if they connect, stores them (encrypted) on the connection — also audited.

## Security model

- **Credentials** are sealed with AES-256-GCM, bound to their connection id. The SQLite file and key file are created with mode `0600`. Back up `secret.key`, or set `PGM_SECRET_KEY`. Without it, stored passwords can't be recovered.
- **Backup files** hold decrypted connection passwords, API keys and the SSO client secret, re-encrypted with AES-256-GCM under a key derived from your passphrase (scrypt), not the master key. Treat the file and its passphrase like a password manager export. Only admins can export or restore, and both are recorded in the audit log.
- **Read-only mode** on Postgres is enforced in four layers:
  1. The session sets `default_transaction_read_only=on`.
  2. Every request runs inside `BEGIN TRANSACTION READ ONLY … ROLLBACK`.
  3. Each statement goes through the extended protocol, so it can't smuggle in a `COMMIT`.
  4. Transaction and session control statements (`COMMIT`, `SET TRANSACTION`, `SET ROLE`, `RESET`, …) are rejected before they reach the server.

  For the strongest guarantee, also connect as a role that only has `pg_read_all_data`.
- **Read-only mode on MySQL / MariaDB** has the same layers, plus an allowlist, because DDL commits implicitly and a read-only transaction doesn't stop everything (MariaDB, for one, still runs `SELECT … INTO OUTFILE`):
  1. Read-only sessions set `transaction_read_only = ON` (`tx_read_only` on MariaDB < 11.1 and MySQL 5.7), in a pool separate from writable sessions.
  2. Every request runs inside `START TRANSACTION READ ONLY … ROLLBACK`.
  3. The driver sends one statement per call (`multipleStatements` off), so nothing can ride along behind a read.
  4. Only reads reach the server: `SELECT` / `WITH` / `TABLE` / `VALUES`, `SHOW`, `DESCRIBE`, `EXPLAIN` of a read, `HELP` and `USE` (the default database is reset afterwards). `SELECT … INTO OUTFILE / DUMPFILE / @var`, locking reads (`FOR UPDATE`), `SET`, `LOCK`, `CALL`, `HANDLER`, `LOAD`, `DO`, transaction control and all DDL/DML are refused, including inside `/*! … */` executable comments.

  For the strongest guarantee, connect as a user that only has `SELECT` (and `SHOW VIEW`) on the databases you browse; the overview warns when the account could change data. The `PROCESS` privilege lets the Activity tab see every connection and InnoDB lock waits.
- **Read-only mode on SQLite**: see [SQLite](#sqlite) — read-only open flags and `query_only`, a rolled-back transaction, and an allowlist that also blocks `VACUUM INTO` and `ATTACH`. Snapshots copied out of containers are always read-only.
- **Postgres-only features**: the visual EXPLAIN tree (MySQL/MariaDB show the server's text or JSON plan instead, and `EXPLAIN ANALYZE` there is limited to reads), and dead tuple / vacuum / per-index scan statistics and extensions in the overview and Activity tab.
- **Writes** need a read/write connection or a temporary unlock, which uses a separate session pool and expires on its own. `DROP`, `TRUNCATE`, and `DELETE` / `UPDATE` without a `WHERE` must be confirmed; the server enforces this, not just the UI.
- **Access** is checked on the server for every connection-scoped page and API call; connections a viewer wasn't given don't exist as far as they can tell.
- **API tokens** (`pgm_` + 32 random bytes, SHA-256 hashed at rest) only work on `GET /api/status…`; hooks.server.ts checks them there and nowhere else, they never become sessions, and repeated bad tokens from one address are throttled. Status responses omit hosts unless the token allows it, and report errors as codes only.
- **Sign-in** is by OIDC or by local accounts (scrypt-hashed passwords, login throttle). Sessions are httpOnly cookies tied to a user. Cross-origin API writes are rejected. Viewers are forced read-only on the server, not just hidden from buttons in the UI.

## Development

```sh
pnpm install
PGM_SCAN_PATHS=~/docker pnpm dev   # http://localhost:5173
pnpm check && pnpm test            # types + unit tests
pnpm screenshots                   # regenerate docs/screenshots (needs Docker)
```

Requires Node 24+. The store uses the built-in `node:sqlite`, so there are no native modules. `pnpm screenshots` runs a seeded demo Postgres and a fake Docker API, so the images only ever show demo data.

**Stack:** SvelteKit 3 · Svelte 5 · Tailwind CSS 4 · CodeMirror 6 · node-postgres · mysql2. The look follows [Arcane](https://getarcane.app).

## License

[Apache-2.0](LICENSE). Copyright 2026 vitafortis.

Also by the same author: [octo·modern](https://github.com/vitafortis/octo-modern), a self-hosted web UI for one or more OctoPrint servers, in the same style.
