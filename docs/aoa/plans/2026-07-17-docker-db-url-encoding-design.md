# Docker DB connection URL encoding — design

**Date:** 2026-07-17
**Branch:** `feat/docker-runtime-research` (PR #289)
**Origin:** Codex re-review P1 on `docker-compose.yml:36`

## Problem

The main multi-container stack assembles the server's `DATABASE_URL` by interpolating
the raw `AOA_POSTGRES_PASSWORD` straight into a URL string:

```yaml
# docker-compose.yml:36
DATABASE_URL: postgres://${AOA_POSTGRES_USER:-paperclip}:${AOA_POSTGRES_PASSWORD:-paperclip}@db:5432/${AOA_POSTGRES_DB:-paperclip}
```

Meanwhile the `db` service sets `POSTGRES_PASSWORD` to the **literal** value, so Postgres
stores the password verbatim. The server, however, derives its password by **parsing the
URL** via postgres.js 3.4.8:

- `packages/db/src/client.ts:53` → `postgres(url, ...)`
- postgres.js `parseUrl` does `new URL(url)` then `decodeURIComponent(urlObj.password)`.

When `AOA_POSTGRES_PASSWORD` contains URL-reserved characters, the two ends diverge:

| Password char | Failure |
|---|---|
| `/` `#` `?` | Terminates the URL authority → host/db misparse, wrong/empty password |
| `%` (literal) | `decodeURIComponent` throws `URIError` → boot crash |
| `%XX`-shaped run | Silently decodes to a *different* string → auth fails |

Net effect: a deployment that sets a hardened `AOA_POSTGRES_PASSWORD` (exactly the case
where reserved characters are common) fails to authenticate with a confusing
`password authentication failed` error that points nowhere near the real cause.

**Severity:** P1 for the production/quickstart deploy path. Not a CI blocker (defaults are
safe). Confirmed real via source inspection.

## Scope of exposure (traced, not assumed)

- **Only one vulnerable site:** `docker-compose.yml:36`.
- `docker-compose.research.yml` and the `docker/research/*.sh` scripts use hardcoded
  `paperclip:paperclip` (no reserved chars) — safe by construction.
- `docker-compose.quickstart.yml` has **no external DB / no `DATABASE_URL`** (embedded
  Postgres) — no exposure.
- The `psql` tools service uses `PGPASSWORD` (literal) — already correct.
- The running server reads `process.env.DATABASE_URL` first
  (`server/src/config.ts:262`: `process.env.DATABASE_URL ?? fileDbUrl`); `docker-bootstrap.mjs`
  also bakes it into `config.json` on first boot. Both flow through
  `scripts/docker-entrypoint.sh` (`ENTRYPOINT` fixed, ends `exec gosu node "$@"`), and the
  `bootstrap` one-shot inherits the same env. A single fix at the entrypoint therefore
  covers every consumer.

## Non-goals

- No change to `server/src/config.ts` or the app's URL handling — the native CLI, dev, and
  embedded-postgres paths stay untouched. This is a Docker-layer fix.
- No change to the research compose or the `psql` tools service (already safe).
- No support for reserved characters in the **database name** (see round-trip note below);
  AoA db names are validated identifiers.

## The round-trip contract (why we encode what we encode)

postgres.js extracts the three components differently:

| Component | postgres.js extraction | Encode on assembly? |
|---|---|---|
| username | `decodeURIComponent(urlObj.username)` | **Yes** — `encodeURIComponent` |
| password | `decodeURIComponent(urlObj.password)` | **Yes** — `encodeURIComponent` |
| database | `(url.pathname \|\| '').slice(1)` — **no decode** | **No** — literal |
| host / port | `urlObj.host` / `urlObj.port` | **No** — literal (`db` / `5432`) |

`encodeURIComponent` is the exact inverse of `decodeURIComponent`, and every character it
leaves unencoded (`A-Za-z0-9 - _ . ! ~ * ' ( )`) is valid in URL userinfo and is never a
`%`-sequence — so `user`/`password` round-trip byte-for-byte for **any** input.

The database name must **not** be encoded, because postgres.js does not decode the
pathname (`postgres@3.4.8/src/index.js:554` keeps `urlObj.pathname`; `:469` does
`.slice(1)`) — an encoded db name would be taken literally (`my%2Fdb`).

**Correction (Codex review):** `AOA_POSTGRES_DB` is **not** validated anywhere today —
`ensurePostgresDatabase` (`packages/db/src/client.ts:727`) only runs for embedded Postgres
(`server/src/index.ts:428`), never for the compose var, which Compose accepts unchecked. So
a literal db name is safe only if the **builder** validates it. The builder therefore
enforces `^[A-Za-z_][A-Za-z0-9_]*$` on `AOA_POSTGRES_DB` and exits nonzero on violation;
reserved-char db names remain an accepted out-of-scope limitation of postgres.js itself.

## Design

### 1. New file — `scripts/compose-database-url.mjs`

A pure builder + a thin CLI entry:

```js
const DB_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function buildDatabaseUrl({ user, password, db }) {
  if (!DB_NAME_RE.test(db)) {
    throw new Error(`Unsafe AOA_POSTGRES_DB (must match ${DB_NAME_RE}): ${db}`);
  }
  const enc = encodeURIComponent;
  // host:port are fixed compose-internal constants — never user-controlled,
  // so no injection surface and no encoding needed.
  return `postgres://${enc(user)}:${enc(password)}@db:5432/${db}`;
}
```

- `databaseUrlFromEnv` returns **null when no `AOA_POSTGRES_PASSWORD` is set** — i.e. the
  embedded-postgres deployments (`docker-compose.quickstart.yml`, standalone `docker run`)
  that ship no `db` service. Only the multi-service `docker-compose.yml` injects
  `AOA_POSTGRES_*` (password defaults to `paperclip`), so only it assembles a URL. This
  keeps the embedded paths on embedded postgres (fix for the second Codex P1 — an
  unconditional assembly would point them at a nonexistent `db:5432` and break boot).
- CLI mode reads `AOA_POSTGRES_USER/PASSWORD/DB` with the current defaults
  (`paperclip` / `paperclip` / `paperclip`), prints the URL to stdout (nothing in embedded
  mode); on an invalid db name it prints the error to stderr and exits nonzero (fail-fast).
- Only `user` and `password` are `encodeURIComponent`-ed; `db` is validated then placed
  literally; `db:5432` are hardcoded constants (revision D — no new `AOA_POSTGRES_HOST/PORT`
  vars, per Codex).
- Exported `buildDatabaseUrl` is imported by the unit test.

### 2. Edit — `scripts/docker-entrypoint.sh`

Immediately before `node /app/scripts/docker-bootstrap.mjs`:

```sh
if [ -z "${DATABASE_URL:-}" ]; then
    _assembled_database_url="$(node /app/scripts/compose-database-url.mjs)"
    if [ -n "$_assembled_database_url" ]; then
        export DATABASE_URL="$_assembled_database_url"
    fi
    unset _assembled_database_url
fi
```

- The `-z` guard means an explicitly-provided `DATABASE_URL` always wins → the research
  compose and any advanced override are untouched.
- The `-n` inner guard means an empty print (embedded mode: no `AOA_POSTGRES_PASSWORD`)
  leaves `DATABASE_URL` unset → embedded postgres preserved. A bad db name makes the
  script exit nonzero, which aborts the container under `set -e` (fail-fast).
- Runs before `docker-bootstrap.mjs` (so the baked `config.json` is correct) and before
  `exec gosu node "$@"` (so the server's `process.env.DATABASE_URL` is correct). `gosu`
  preserves the exported environment.

### 3. Edit — `docker-compose.yml`

Replace line 36 (`DATABASE_URL: postgres://…`) in the shared `x-aoa-env` anchor with a
**passthrough** `DATABASE_URL` plus the discrete pieces the server container needs (it
currently receives only `DATABASE_URL`, not the `AOA_POSTGRES_*` vars):

```yaml
# Empty by default so the entrypoint assembles it; a host-shell/.env DATABASE_URL
# still propagates and wins (revision A — keeps override support).
DATABASE_URL: ${DATABASE_URL:-}
AOA_POSTGRES_USER: ${AOA_POSTGRES_USER:-paperclip}
AOA_POSTGRES_PASSWORD: ${AOA_POSTGRES_PASSWORD:-paperclip}
AOA_POSTGRES_DB: ${AOA_POSTGRES_DB:-paperclip}
```

- No `AOA_POSTGRES_HOST/PORT` (revision D — builder hardcodes `db:5432`).
- The `db` service already consumes `AOA_POSTGRES_*` for `POSTGRES_PASSWORD` (literal) —
  that side is correct and unchanged.

### 4. Test — `scripts/__tests__/compose-database-url.test.ts` (location TBD in plan)

Prove the round-trip against postgres.js's real parse:

- Import `buildDatabaseUrl`; build a URL with a hostile password, e.g.
  `p@ss/w#rd?x%20&y:z` and a user with a reserved char.
- Feed the result to **real** `postgres(url)` and assert `sql.options.pass`,
  `sql.options.user`, and `sql.options.database` equal the originals — postgres.js parses
  lazily, so no connection is opened. **No parser-replication fallback** (revision C —
  replicating the parse could bake in the same wrong assumption the test is meant to catch).
- Assert `db`/`host`/`port` are placed literally (no encoding), defaults applied when env
  absent, and an invalid `AOA_POSTGRES_DB` throws.

### 5. Docs — `docs/deploy/docker.md`

Two notes: (1) the `AOA_POSTGRES_*` pieces are assembled and percent-encoded into
`DATABASE_URL` automatically — passwords need no manual URL-escaping, and an explicitly-set
`DATABASE_URL` overrides assembly; (2) rotating `AOA_POSTGRES_PASSWORD` on an existing
volume requires `ALTER ROLE` or recreating the volume (initdb-time password is persisted).

## Edge cases

- **Explicit `DATABASE_URL`** → assembly skipped (research compose, advanced users).
- **Empty password** → compose `:-paperclip` default applies; script defaults to `paperclip` for parity.
- **`%` in password** → `encodeURIComponent` → `%25` → postgres.js decodes back to `%` (no `URIError`).
- **Existing volumes** → for previously-working (safe) passwords, assembled URL is
  byte-identical to the old raw URL, so `config.json` and env stay consistent; for
  previously-failing (unsafe) passwords, the deployment now boots. No migration needed.
  (`config.json` is not rewritten — `docker-bootstrap.mjs:150` only writes when absent —
  but env wins at `config.ts:262`, so the corrected URL is used.)
- **Changing the password on an existing volume** (revision E) → Postgres bakes the role
  password at initdb into the persistent volume; editing `AOA_POSTGRES_PASSWORD` later does
  **not** re-set it, so auth still fails. This is general Postgres behavior, orthogonal to
  this fix — documented in `docs/deploy/docker.md` (rotate via `ALTER ROLE` or recreate the
  volume), not solved here.

## Verification plan

- Unit test green (round-trip proof).
- `docker compose config` renders without the raw password in a URL.
- Live: bring the stack up with `AOA_POSTGRES_PASSWORD='p@ss/w#rd%x'`, confirm the server
  reaches `authReady:true` / healthy (previously would fail auth).
