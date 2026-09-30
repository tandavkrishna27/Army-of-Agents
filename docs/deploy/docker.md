---
title: Docker
summary: Docker Compose deployment
---

Run AoA in Docker without installing Node or pnpm locally.

For the deployment checks required before a fleet repair, see
[Marketplace recovery](/guides/board-operator/marketplace-recovery).

## Compose Deployment

The default `docker-compose.yml` is the recommended remote-dev deployment. It starts:

- `server`: the AoA API, UI, workers, adapters, and plugin runtime on port `3100`
- `db`: PostgreSQL with pgvector enabled via `pgvector/pgvector:pg18`

It also defines an opt-in `bootstrap` service (behind the `bootstrap` Compose
profile) for pre-issuing an admin invite. See [Instance admin](#instance-admin)
below — you do not need it for a normal deploy, where the first Google sign-in
becomes admin.

```sh
docker compose up --build
```

### Authentication

The default stack runs in `authenticated` mode, which requires Google OAuth.
Supply the OAuth client credentials before the first boot, or the server will
refuse to start:

```sh
GOOGLE_CLIENT_ID=... \
GOOGLE_CLIENT_SECRET=... \
AOA_PUBLIC_URL=https://aoa-dev.example.com \
docker compose up --build -d
```

Docker deployments always run `authenticated`: the container binds `0.0.0.0`
for port publishing, and `local_trusted` (the keyless mode) is loopback-only,
so it cannot be used here. For a keyless local trial, run the native `aoa` CLI
instead of Docker — it binds `127.0.0.1` and supports `local_trusted`.

If you are exposing the container directly during early testing, `AOA_PUBLIC_URL=http://<server-ip>:3100` is enough. Behind a reverse proxy, also set `AOA_TRUST_PROXY=1`; for a public internet deployment set `AOA_DEPLOYMENT_EXPOSURE=public`.

Defaults:

- Host port: `3100` (`AOA_PORT=3200` changes it)
- App data volume: `aoa-data` mounted at `/aoa`
- Database volume: `aoa-postgres`
- Database URL: `postgres://paperclip:paperclip@db:5432/paperclip`
- Image tag: `aoa:local`

Existing Docker Compose installs that used the older `pgdata` and
`paperclip-data` named volumes are not migrated automatically by this stack.
The database image now uses Postgres 18 with pgvector and mounts storage at
`/var/lib/postgresql`. Do not point the new `aoa-postgres` volume directly at
an old Postgres 17 data directory; take a `pg_dump`/backup from the old stack
and restore it into the new database.

On a blank `/aoa` volume, the entrypoint creates:

- `/aoa/instances/default/config.json`
- `/aoa/instances/default/.env` with generated `BETTER_AUTH_SECRET` and `AOA_AGENT_JWT_SECRET`
- local storage, logs, backup, secrets, and workspace directories

Pending migrations are applied automatically in the Compose stack with `AOA_MIGRATION_AUTO_APPLY=true`.

### Instance admin

Both admin paths run in `authenticated` mode with Google configured — pick one
by how exposed the instance is:

- **First sign-in wins (zero config).** The first user to sign in with Google
  becomes the instance admin automatically. Best for a solo or trusted instance
  (behind a firewall / not publicly reachable) where no one else can sign in
  before you.
- **Pre-issued invite (recommended when the URL is exposed before you sign in).**
  Generate an admin invite and hand it to the intended founder, so a stranger
  who reaches the sign-in page first can't claim admin. The `bootstrap` service
  mints this invite; it is behind an opt-in profile and does **not** run during a
  normal `docker compose up`. The instance must already be up (Google configured,
  server healthy):

  ```sh
  docker compose --profile bootstrap run --rm bootstrap
  ```

  It exits cleanly when the instance already has an admin user; pass
  `BOOTSTRAP_FORCE=true` to mint another invite anyway. (The invite is redeemed
  via Google sign-in — it designates *who* becomes admin, it is not a way to run
  without Google.)

To open a psql shell against the bundled database:

```sh
docker compose --profile tools run --rm psql
```

## Configuration

Common overrides can be passed as environment variables:

```sh
AOA_PORT=3200 \
AOA_PUBLIC_URL=https://aoa-dev.example.com \
OPENAI_API_KEY=sk-... \
ANTHROPIC_API_KEY=sk-... \
docker compose up --build -d
```

Provider keys are optional. Without them, the app still boots; adapter health checks will report missing prerequisites until keys or CLI auth are configured.

Compose-specific variables:

| Variable | Default | Notes |
| --- | --- | --- |
| `AOA_IMAGE` | `aoa:local` | Image tag used by the `server` and `bootstrap` services. |
| `USER_UID`, `USER_GID` | `1000` | Runtime UID/GID for the `node` user inside the image. |
| `AOA_BIND_ADDRESS` | `0.0.0.0` | Host interface used for the published app port. |
| `AOA_PORT` | `3100` | Host port mapped to container port `3100`. |
| `AOA_INSTANCE_ID` | `default` | Instance directory under `/aoa/instances/`. |
| `AOA_POSTGRES_IMAGE` | `pgvector/pgvector:pg18` | Database image used by the default Compose stack and `psql` tool profile. |
| `AOA_POSTGRES_USER` | `paperclip` | Database user. |
| `AOA_POSTGRES_PASSWORD` | `paperclip` | Database password. Set this for shared or long-lived deployments. URL-reserved characters (`/ # ? % @ :`) are safe — the entrypoint percent-encodes the value into `DATABASE_URL` automatically, so no manual escaping is needed. |
| `AOA_POSTGRES_DB` | `paperclip` | Database name. Must be a plain SQL identifier (`^[A-Za-z_][A-Za-z0-9_]*$`); the entrypoint rejects anything else at startup. |
| `AOA_MIGRATION_AUTO_APPLY` | `true` | Applies pending migrations during container startup. |
| `AOA_DEPLOYMENT_MODE` | `authenticated` | Both the default stack and quickstart default to `authenticated`, which requires Google OAuth. `local_trusted` (keyless loopback) is loopback-only and not usable for a port-published container. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | empty | Google OAuth client credentials. **Required** in `authenticated` mode; the server refuses to boot without them. |
| `AOA_DEV_LOCAL_IDENTITY` | empty | Dev escape hatch that lets `local_trusted` boot without Google OAuth. Not set by the Compose stacks; not for multi-user deploys. |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY_PEM`, `GITHUB_APP_WEBHOOK_SECRET` | empty | Optional GitHub App integration variables. Names match `.env.example` and server expectations. |
| `AOA_DATA_DIR` | `./data/docker-aoa` | Quickstart-only host bind path for `docker-compose.quickstart.yml`. The default multi-service stack uses named volumes. |

> **DATABASE_URL assembly.** The default multi-service stack builds `DATABASE_URL`
> from the `AOA_POSTGRES_*` pieces in `scripts/docker-entrypoint.sh`, percent-encoding
> the user and password (URL-reserved characters need no manual escaping). Set your own
> `DATABASE_URL` (host shell or `.env`) to override assembly and point at an external
> database. Quickstart and the standalone `docker run` flow set no `AOA_POSTGRES_*` and
> stay on embedded PostgreSQL.
>
> **Rotating the password.** Postgres stores the role password at first initialization
> inside the `aoa-postgres` volume. Changing `AOA_POSTGRES_PASSWORD` later does **not**
> re-set it — run `ALTER ROLE ... WITH PASSWORD ...` (e.g. via the `psql` tools profile)
> or recreate the volume.

For S3-compatible storage:

```sh
AOA_STORAGE_PROVIDER=s3 \
AOA_STORAGE_S3_BUCKET=aoa-artifacts \
AOA_STORAGE_S3_REGION=us-east-1 \
docker compose up --build -d
```

The image includes git, GitHub CLI, curl/wget, ripgrep, Python, OpenSSH, jq, psql/pg_dump, Docker CLI, Claude Code, Codex, Gemini CLI, and OpenCode. Mounting `/var/run/docker.sock` is intentionally not enabled by default because it gives the container root-equivalent access to the host; add a local Compose override only for deployments that explicitly need sandbox-docker execution.

## Single-Container Quickstart

For quick local trials, `docker-compose.quickstart.yml` runs one AoA container with embedded PostgreSQL:

```sh
docker compose -f docker-compose.quickstart.yml up --build
```

Data is persisted in a host bind mount at
`${AOA_DATA_DIR:-./data/docker-aoa}` and mounted at `/aoa` in the container.
The default host directory is `./data/docker-aoa`; set `AOA_DATA_DIR` to
override it. The image keeps `/paperclip` only as a compatibility symlink to
`/aoa`; do not mount a second volume there.

Like the main stack, quickstart runs in `authenticated` mode and needs Google
OAuth credentials (the first Google sign-in becomes the instance admin):

```sh
GOOGLE_CLIENT_ID=... \
GOOGLE_CLIENT_SECRET=... \
docker compose -f docker-compose.quickstart.yml up --build
```

> **Docker cannot run keyless.** `local_trusted` mode (the keyless path) only
> binds loopback, but a port-published container must bind `0.0.0.0`, which
> `local_trusted` refuses. For a keyless local trial without Google, run the
> native `aoa` CLI instead of Docker — it binds `127.0.0.1` and supports
> `local_trusted`.

Override quickstart paths and ports with:

```sh
AOA_PORT=3200 AOA_DATA_DIR=./data/aoa-dev \
  docker compose -f docker-compose.quickstart.yml up --build
```

## Manual Docker Run

Build and run the image directly. The image defaults to `authenticated` mode, so both
examples pass Google OAuth credentials — the server refuses to boot without them (see the
environment table above; for a keyless local trial use the native `aoa` CLI instead):

```sh
docker build -t aoa-local .
docker run --name aoa \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e AOA_HOME=/aoa \
  -e AOA_PUBLIC_URL=http://localhost:3100 \
  -e GOOGLE_CLIENT_ID=... \
  -e GOOGLE_CLIENT_SECRET=... \
  -v aoa-data:/aoa \
  aoa-local
```

With no `DATABASE_URL`, this uses embedded PostgreSQL. To use an external database:

```sh
docker run --name aoa \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e AOA_HOME=/aoa \
  -e DATABASE_URL=postgres://paperclip:paperclip@db:5432/paperclip \
  -e GOOGLE_CLIENT_ID=... \
  -e GOOGLE_CLIENT_SECRET=... \
  -v aoa-data:/aoa \
  aoa-local
```

The auth secrets are generated on first boot and persisted under
`/aoa/instances/default/.env`. You may still pass `BETTER_AUTH_SECRET` and
`AOA_AGENT_JWT_SECRET` explicitly if secrets are managed outside the container.

## Data Persistence

The `/aoa` volume stores instance config, generated secrets, local
encrypted-secret key material, uploaded assets, run logs, backups, and agent
workspace data. Do not run authenticated deployments without a durable `/aoa`
mount or volume.
