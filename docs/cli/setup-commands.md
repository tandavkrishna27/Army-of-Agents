---
title: Setup Commands
summary: Onboard, run, doctor, and configure
---

Instance setup and diagnostics commands.

## `aoa run`

One-command bootstrap and start:

```sh
pnpm aoa run
```

Does:

1. Auto-onboards if config is missing
2. Runs `aoa doctor` with repair enabled
3. Starts the server when checks pass

Choose a specific instance:

```sh
pnpm aoa run --instance dev
```

## `aoa onboard`

Interactive first-time setup:

```sh
pnpm aoa onboard
```

First prompt:

1. `Quickstart` (recommended): local defaults (embedded database, no LLM provider, local disk storage, default secrets)
2. `Advanced setup`: full interactive configuration

Start immediately after onboarding:

```sh
pnpm aoa onboard --run
```

Non-interactive defaults + immediate start (opens browser on server listen):

```sh
pnpm aoa onboard --yes
```

## `aoa doctor`

Health checks with optional auto-repair:

```sh
pnpm aoa doctor
pnpm aoa doctor --repair
```

Validates:

- Server configuration
- Database connectivity
- Secrets adapter configuration
- Storage configuration
- Missing key files

## `aoa configure`

Update configuration sections:

```sh
pnpm aoa configure --section server
pnpm aoa configure --section secrets
pnpm aoa configure --section storage
```

## `aoa env`

Show resolved environment configuration:

```sh
pnpm aoa env
```

## `aoa allowed-hostname`

Allow a private hostname for authenticated/private mode:

```sh
pnpm aoa allowed-hostname my-tailscale-host
```

## Local Storage Paths

| Data | Default Path |
|------|-------------|
| Config | `~/.aoa/instances/default/config.json` |
| Database | `~/.aoa/instances/default/db` |
| Logs | `~/.aoa/instances/default/logs` |
| Storage | `~/.aoa/instances/default/data/storage` |
| Secrets key | `~/.aoa/instances/default/secrets/master.key` |

> **Legacy fallback:** if `~/.aoa/` does not exist but `~/.paperclip/` does, the CLI uses `~/.paperclip/` automatically for one release to keep existing installs working. The fallback is removed after the next major version. See `cli/src/config/home.ts`.

Override with:

```sh
AOA_HOME=/custom/home AOA_INSTANCE_ID=dev pnpm aoa run
```

Or pass `--data-dir` directly on any command:

```sh
pnpm aoa run --data-dir ./tmp/aoa-dev
pnpm aoa doctor --data-dir ./tmp/aoa-dev
```

## `aoa db:backup`

Create a one-off database backup using the current config:

```sh
pnpm aoa db:backup
```

Optional flags:

| Flag | Description |
|------|-------------|
| `--dir <path>` | Backup output directory (overrides config) |
| `--retention-days <days>` | Number of days to keep backups before pruning |
| `--filename-prefix <prefix>` | Filename prefix for the backup file (default: `paperclip`) |
| `--json` | Print backup metadata as JSON |

Example — backup to a custom directory and print JSON metadata:

```sh
pnpm aoa db:backup --dir /backups/aoa --retention-days 14 --json
```

The default backup directory is `~/.aoa/instances/default/data/backups`. The connection string is resolved from `DATABASE_URL` env var, then `config.database.connectionString`, then the embedded-postgres default.

## `aoa auth bootstrap-ceo`

Generate a one-time invite URL for the first instance admin (authenticated deployment mode only):

```sh
pnpm aoa auth bootstrap-ceo
```

Optional flags:

| Flag | Description |
|------|-------------|
| `--force` | Create a new invite even if an admin user already exists |
| `--expires-hours <hours>` | Invite expiration window in hours (default: 72, max: 720) |
| `--base-url <url>` | Public base URL used to build the invite link |

The command is a no-op in `local_trusted` deployment mode — it prints an info message and exits. In `authenticated` mode it revokes any existing un-accepted bootstrap invite before issuing a new one.

Example — create an invite that expires in 24 hours:

```sh
pnpm aoa auth bootstrap-ceo --expires-hours 24 --base-url https://aoa.example.com
```

## `aoa heartbeat run`

Run one agent heartbeat and stream live logs. Full reference is in [Control-plane commands](/cli/control-plane-commands#heartbeat); the essential form is:

```sh
pnpm aoa heartbeat run --agent-id <agent-id>
```

Key flags: `--source` (timer | assignment | on_demand | automation, default `on_demand`), `--trigger` (manual | ping | callback | system, default `manual`), `--timeout-ms <ms>`, `--debug` (show raw stdout/stderr JSON chunks), `--json`.
