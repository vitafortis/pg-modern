<p align="center">
  <img src="docs/logo.svg" width="64" height="64" alt="" />
</p>

<h1 align="center">pg·modern</h1>

<p align="center">
  A modern, self-hosted database console for the homelab — Postgres, MySQL and MariaDB.<br />
  It finds your databases in Docker and <code>.env</code> files, keeps the credentials encrypted, and opens everything read-only.
</p>

<p align="center">
  <img src="docs/screenshots/overview.png" alt="pg·modern overview" />
</p>

## Features

- **Postgres, MySQL and MariaDB**: one console for both protocols, so the databases behind Nextcloud, Ghost, BookStack, Firefly III, PhotoPrism or WordPress sit next to your Postgres ones. MariaDB is told apart from MySQL by its version string.
- **Discover**: finds database containers on your Docker hosts, connection strings in app containers, credentials in `.env`, `compose.yaml` and Terraform files, and every project managed by [Arcane](https://getarcane.app) through its API. Import them in one click.
- **Encrypted storage**: connection passwords are sealed with AES-256-GCM. Discovered secrets never reach the browser.
- **Read-only by default**: every query runs in a `READ ONLY` transaction that is always rolled back (on MySQL/MariaDB only reads get through at all). Writes are opt-in per connection or unlocked for a few minutes at a time, and destructive statements still ask first.
- **Access control and audit**: give viewers every connection or only selected ones, let specific people unlock writes temporarily, and see every query and change in the audit log.
- **Browse**: schema tree; filter, sort, page and export tables; inspect JSON cells; view columns, indexes, constraints, foreign keys and triggers.
- **Query**: SQL editor with schema-aware autocomplete. Run the statement under the cursor (`⌘↵`) or the whole script (`⇧⌘↵`), cancel long queries, keep a per-connection history, and export results to CSV or JSON.
- **Saved queries**: name, describe and share queries per connection or for every connection; open them from the workspace header.
- **EXPLAIN**: on Postgres, a visual plan tree with self time, misestimated row counts, buffers and the slowest node highlighted; `EXPLAIN ANALYZE` of a write runs inside a transaction that's rolled back. On MySQL the tree plan (`EXPLAIN ANALYZE` for reads on 8.0.18+), on MariaDB the JSON plan (`ANALYZE FORMAT=JSON` for reads).
- **Server overview and activity**: version, size, cache hit ratio, extensions (storage engines and grants on MySQL); live sessions with lock chains, waiting and idle-in-transaction sessions, database and table sizes, dead tuples and unused indexes (Postgres) or the process list, InnoDB lock waits and index sizes (MySQL/MariaDB). Cancel or terminate a session (`KILL QUERY` / `KILL` on MySQL) once writes are unlocked.
- **Backup & restore**: an encrypted, passphrase-protected file with connections, users and settings that restores on a fresh install.
- **Users and SSO**: sign in with any OIDC provider (Authentik, Authelia, Keycloak, Pocket ID, Google, …). Accounts can be created automatically for matching emails. *Admins* manage everything; *viewers* browse and query read-only.
- **Schema diagram**: an ER view of each schema (each database, on MySQL) built from its foreign keys.
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
| Write | ✓ on read/write connections; unlock read-only ones for 5–60 min | only by unlocking, on connections you allow |
| Add, edit and delete connections | ✓ | |
| Discover, Settings, Users, Audit log | ✓ | |

Set a viewer's access from **Users → Connections**. Every unlock is time-limited, needs no restart, and is recorded with its reason. The **Audit log** lists every query (who, where, whether it wrote, how it ended) and every sign-in, connection, user, access and settings change.

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
- Groups that declare an unsupported engine (`DB_CONNECTION=sqlite`, `database__client=sqlite3`) are ignored.

Scan results stay on the server, and an import refers to them by key, so a discovered password goes straight into the encrypted store.

## Backup & restore

**Settings → Backup & restore** downloads a `.pgmbackup` file with pg·modern's own configuration: connections (with their passwords), saved queries, users (password hashes, SSO links, connection access and grants), and settings (discovery, Arcane managers and their API keys, single sign-on, the password sign-in toggle). Query history, the audit log and sessions aren't included.

The file is encrypted with a passphrase you choose (12+ characters), not the master key, so it also restores on a fresh install with a different `secret.key` or `PGM_SECRET_KEY`. Restoring first shows a preview of what would be added or updated, then merges the categories you pick: connections by id, users by email. Nothing is deleted, your own account is never changed, and settings are replaced as a whole. The API is `POST /api/backup` and `POST /api/backup/restore` (admins only).

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
- **Postgres-only features**: the visual EXPLAIN tree (MySQL/MariaDB show the server's text or JSON plan instead, and `EXPLAIN ANALYZE` there is limited to reads), and dead tuple / vacuum / per-index scan statistics and extensions in the overview and Activity tab.
- **Writes** need a read/write connection or a temporary unlock, which uses a separate session pool and expires on its own. `DROP`, `TRUNCATE`, and `DELETE` / `UPDATE` without a `WHERE` must be confirmed; the server enforces this, not just the UI.
- **Access** is checked on the server for every connection-scoped page and API call; connections a viewer wasn't given don't exist as far as they can tell.
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
