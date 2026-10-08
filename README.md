<p align="center">
  <img src="docs/logo.svg" width="64" height="64" alt="" />
</p>

<h1 align="center">pg·modern</h1>

<p align="center">
  A modern, self-hosted Postgres console for the homelab.<br />
  It finds your databases in Docker and <code>.env</code> files, keeps the credentials encrypted, and opens everything read-only.
</p>

<p align="center">
  <img src="docs/screenshots/overview.png" alt="pg·modern overview" />
</p>

## Features

- **Discover**: finds Postgres containers on your Docker hosts, connection strings in app containers, and credentials in `.env` and `compose.yaml` files across your stacks folders. Import them in one click.
- **Encrypted storage**: connection passwords are sealed with AES-256-GCM. Discovered secrets never reach the browser.
- **Read-only by default**: every query runs in a `READ ONLY` transaction that is always rolled back. Writes are opt-in per connection, and destructive statements still ask first.
- **Browse**: schema tree; filter, sort, page and export tables; inspect JSON cells; view columns, indexes, constraints, foreign keys and triggers.
- **Query**: SQL editor with schema-aware autocomplete. Run the statement under the cursor (`⌘↵`) or the whole script (`⇧⌘↵`), cancel long queries, keep a per-connection history, and export results to CSV or JSON.
- **Server overview**: version, size, sessions, cache hit ratio, largest tables, extensions, and whether your role is a superuser.
- **Light and dark** themes, and multi-arch images (`amd64`, `arm64`).

## Getting started

### Docker Compose (recommended)

```sh
mkdir pg-modern && cd pg-modern
curl -fsSLO https://raw.githubusercontent.com/vitafortis/pg-modern/main/compose.yaml
# edit the /opt/stacks volume to point at where your stacks live
docker compose up -d
```

Open `http://<your-host>:3030` and choose an admin password. Then go to **Discover**:

1. **Containers** lists every Postgres it found through the Docker API. Use **Running only** and **Reachable only** to cut the noise.
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

### Reaching your databases

pg·modern connects from inside its own container, so for each database it needs a route.

- **Published ports** (`5432:5432`) work out of the box through `host.docker.internal`.
- **Unpublished databases** need pg·modern on the same Docker network. Add the network to the `pg-modern` service (see the comments in `compose.yaml`).
- **Remote hosts** just need the host and port.

Discovery probes every address it knows for a server and preselects the first one that answers.

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
| ![Table browser](docs/screenshots/table.png) | ![Query editor](docs/screenshots/query.png) |
| **Browse**: virtualized grid with a JSON cell inspector | **Query**: runs in a read-only transaction that is rolled back |
| ![Structure](docs/screenshots/structure.png) | ![Server overview](docs/screenshots/server.png) |
| **Structure**: columns, indexes, constraints | **Server overview** |
| ![Light theme](docs/screenshots/overview-light.png) | ![First-run setup](docs/screenshots/setup.png) |
| **Light theme** | **First run** |

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `PGM_DATA_DIR` | `./data` (`/data` in the image) | Encrypted SQLite store and key file |
| `PGM_SECRET_KEY` | — | Master secret. Unset means a random key is generated in `secret.key` |
| `PGM_SCAN_PATHS` | — | Comma-separated folders to scan (more can be added in the UI) |
| `PGM_SCAN_DEPTH` | `6` | How deep to recurse into scan folders |
| `PGM_DOCKER_HOSTS` | local socket | `unix://…` or `tcp://host:2375`, comma-separated |
| `PGM_STATEMENT_TIMEOUT_MS` | `30000` | Per-statement timeout |
| `PGM_MAX_ROWS` | `5000` | Rows returned per result; the rest are truncated |
| `PGM_AUTH` | — | `disabled` skips the login screen (trusted networks only) |
| `PROTOCOL_HEADER`, `HOST_HEADER` | — | Set to `x-forwarded-proto` / `x-forwarded-host` behind a TLS reverse proxy |

## How discovery works

**Containers.** Every container on each Docker endpoint is inspected.

- Postgres servers are recognized by image (`postgres`, `postgis`, `timescaledb`, `pgvector`, `bitnami/postgresql`, `immich-app/postgres`, …) or by `POSTGRES_PASSWORD` / `PGDATA` in their environment.
- Credentials come from `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB`, plus the Bitnami equivalents. Passwords kept in `*_FILE` secrets are flagged so you can type them in.
- App containers are scanned for connection strings too. When an app points at a sibling container by service name, the candidate is rewritten to an address pg·modern can reach.

**Files.** Scan folders are walked for `.env`, `.env.*`, `*.env` and `compose.yaml` / `docker-compose.yml`.

- `node_modules`, `.git`, `*.example` and similar are skipped.
- From each file pg·modern picks up:
  - `postgres://` URLs in any variable
  - grouped keys like `DB_HOST` / `DB_USER` / `DB_PASSWORD`, `PGHOST` / `PGUSER`, `PAPERLESS_DBHOST`, and `POSTGRES_*`
  - Compose services, with `${VAR:-default}` interpolation from the neighbouring `.env`
- Groups that declare another engine (`DB_CONNECTION=mysql`) are ignored.

Scan results stay on the server, and an import refers to them by key, so a discovered password goes straight into the encrypted store.

## Security model

- **Credentials** are sealed with AES-256-GCM, bound to their connection id. The SQLite file and key file are created with mode `0600`. Back up `secret.key`, or set `PGM_SECRET_KEY`. Without it, stored passwords can't be recovered.
- **Read-only mode** is enforced in four layers:
  1. The session sets `default_transaction_read_only=on`.
  2. Every request runs inside `BEGIN TRANSACTION READ ONLY … ROLLBACK`.
  3. Each statement goes through the extended protocol, so it can't smuggle in a `COMMIT`.
  4. Transaction and session control statements (`COMMIT`, `SET TRANSACTION`, `SET ROLE`, `RESET`, …) are rejected before they reach the server.

  For the strongest guarantee, also connect as a role that only has `pg_read_all_data`.
- **Writable connections** confirm `DROP`, `TRUNCATE`, and `DELETE` / `UPDATE` without a `WHERE`.
- **The app** sits behind an admin password: scrypt-hashed, with httpOnly `SameSite=Strict` cookies and a login throttle. Cross-origin API writes are rejected.

## Development

```sh
pnpm install
PGM_SCAN_PATHS=~/docker pnpm dev   # http://localhost:5173
pnpm check && pnpm test            # types + unit tests
pnpm screenshots                   # regenerate docs/screenshots (needs Docker)
```

Requires Node 24+. The store uses the built-in `node:sqlite`, so there are no native modules. `pnpm screenshots` runs a seeded demo Postgres and a fake Docker API, so the images only ever show demo data.

**Stack:** SvelteKit 3 · Svelte 5 · Tailwind CSS 4 · CodeMirror 6 · node-postgres. The look follows [Arcane](https://getarcane.app).
