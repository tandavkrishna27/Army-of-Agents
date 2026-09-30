---
title: Local Development
summary: Set up AoA for local development
---

Run AoA locally with zero external dependencies.

## Prerequisites

- Node.js 20.3+
- pnpm 9+

## Start Dev Server

```sh
pnpm install
pnpm dev
```

This starts:

- **API server** at `http://localhost:3100`
- **UI** served by the API server in dev middleware mode (same origin)

No Docker or external database required. AoA uses embedded PostgreSQL automatically.

## One-Command Bootstrap

For a first-time install:

```sh
pnpm aoa run
```

This does:

1. Auto-onboards if config is missing
2. Runs `aoa doctor` with repair enabled
3. Starts the server when checks pass

## Tailscale/Private Auth Dev Mode

To run in `authenticated/private` mode for network access:

```sh
pnpm dev --tailscale-auth
```

This binds the server to `0.0.0.0` for private-network access.

Alias:

```sh
pnpm dev --authenticated-private
```

Allow additional private hostnames:

```sh
pnpm aoa allowed-hostname dotta-macbook-pro
```

For full setup and troubleshooting, see [Tailscale Private Access](/deploy/tailscale-private-access).

## Health Checks

```sh
curl http://localhost:3100/api/health
# -> {"status":"ok"}

curl http://localhost:3100/api/companies
# -> []
```

## Reset Dev Data

To wipe local data and start fresh:

```sh
rm -rf ~/.aoa/instances/default/db
pnpm dev
```

> Note: existing installs that still have `~/.paperclip/` are read via the legacy fallback in `cli/src/config/home.ts` (used when `~/.aoa/` does not yet exist). On a fresh install, AoA writes only to `~/.aoa/`.

## Data Locations

| Data | Path |
|------|------|
| Config | `~/.aoa/instances/default/config.json` |
| Database | `~/.aoa/instances/default/db` |
| Storage | `~/.aoa/instances/default/data/storage` |
| Secrets key | `~/.aoa/instances/default/secrets/master.key` |
| Logs | `~/.aoa/instances/default/logs` |

Override with environment variables:

```sh
AOA_HOME=/custom/path AOA_INSTANCE_ID=dev pnpm aoa run
```
