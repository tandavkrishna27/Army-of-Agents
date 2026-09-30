---
title: Deployment Modes
summary: local_trusted vs authenticated (private/public)
---

AoA supports two runtime modes with different security profiles.

## `local_trusted`

The default mode. Optimized for single-operator local use.

- **Host binding**: loopback only (localhost)
- **Authentication**: no login required
- **Use case**: local development, solo experimentation
- **Board identity**: auto-created local board user

```sh
# Set during onboard
pnpm aoa onboard
# Choose "local_trusted"
```

## `authenticated`

Login required. Supports two exposure policies.

### `authenticated` + `private`

For private network access (Tailscale, VPN, LAN).

- **Authentication**: login required via Better Auth
- **URL handling**: auto base URL mode (lower friction)
- **Host trust**: private-host trust policy required

```sh
pnpm aoa onboard
# Choose "authenticated" -> "private"
```

Allow custom Tailscale hostnames:

```sh
pnpm aoa allowed-hostname my-machine
```

### `authenticated` + `public`

For internet-facing deployment.

- **Authentication**: login required
- **URL**: explicit public URL required
- **Security**: stricter deployment checks in doctor

```sh
pnpm aoa onboard
# Choose "authenticated" -> "public"
```

## `cloud_auth`

Hosted controlled-beta multi-tenant mode. Every Company belongs to an
**Organization** (tenant); any signed-in user can self-serve-create an
Organization and becomes its `owner`.

- **Authentication**: login required (Google via Better Auth)
- **Exposure**: always `public`, with an explicit `auth.publicBaseUrl` — the
  config schema rejects any other combination
- **`instance_admin` promotion**: disabled everywhere. All four runtime
  promotion paths (both better-auth hooks, the `bootstrap_ceo` invite branch,
  and board-claim) are gated by a single chokepoint,
  `instanceAdminBootstrapEnabled(mode)`, which returns `false` for
  `cloud_auth`. `instance_admin` is provisioned out-of-band only
  (break-glass/operator tooling) — never at runtime.
- **Self-serve Organizations**: `POST /api/organizations` lets any signed-in
  board user create an Organization and become its owner; company-create
  authorization is scoped to org role (`owner`/`admin`) rather than
  instance-admin status.
- **Board-claim**: not available — board-claim is a single-tenant
  `local_trusted → authenticated` handoff and is inert in `cloud_auth`.

```sh
pnpm aoa onboard
# Choose "cloud_auth"
```

## Execution Isolation (cloud_auth)

On `cloud_auth`, every agent, crew, and Commander run — plus supported one-shot
CLIs (extraction, compaction, and `claude_local`/`codex_local` readiness probes)
— executes inside E2B. Agent, crew, and Commander runs use the run-JWT/MCP
broker path. One-shot CLIs instead resolve Company-scoped provider authority and
call the sandbox provider runtime directly; unsupported readiness adapters fail
closed. Organization agents may use ephemeral or warm per-agent leases under
the warm-sandbox policy, crew is ephemeral, and Commander may use warm
per-conversation or ephemeral-per-turn leases. The control-plane host never
runs tenant model output directly. Self-hosted deployments (`local_trusted` and
single-tenant `authenticated`) are unchanged: they spawn host-direct with the
in-process MCP bridge, and the D1 unsandboxed-multitenant guard is a no-op.

### Execution isolation by run kind

| Run kind | `local_trusted` / `authenticated` (self-hosted) | `cloud_auth` (multi-tenant) |
|----------|--------------------------------------------------|-----------------------------|
| Org agent | host-direct or docker (operator choice) | E2B via broker; ephemeral or warm per-agent reuse by policy |
| Crew agent | host-direct or docker | ephemeral E2B sandbox via broker (always ephemeral) |
| **Commander** | **host-direct spawn + in-process bridge (byte-identical)** | **warm per-conversation E2B sandbox via broker (Commander run-JWT); ephemeral-per-turn if `warmCommanderConversations=false`** |
| Extraction / compaction | host-direct | direct ephemeral one-shot E2B provider-runtime call |
| Readiness probes | host-direct | direct ephemeral one-shot E2B call for `claude_local`/`codex_local`; unsupported adapters fail closed |

Every agent, crew, and Commander dispatch passes a resolved `provider-sandbox`
execution target into the D1 guard (`assertUnsandboxedMultitenantAllowed`). A
`null`/`local` target (acquire failed) still fails closed on `cloud_auth` — there
is no silent host fallback. One-shot CLIs use a separate fail-closed path:
environment acquisition and the sandbox-driver check must succeed before the
direct provider-runtime call. The D1 guard is a **closed refuse-enumeration**
(refuses local + docker-family, permits everything else), so a future
tenant-operated `remote-tenant-runner` is an allowed category by construction;
the reserved driver name (`RESERVED_TENANT_RUNNER_DRIVER = "remote-runner"`) is
documented but not yet admitted in v1.

### Instance experimental settings (Commander warm sandboxes)

These live on the singleton `instance_settings` row (not env vars):

- `warmCommanderConversations` (default `true`) — when true on `cloud_auth`,
  each active Commander conversation holds a warm (paused/resumed)
  per-conversation E2B sandbox across turns; the idle reaper + per-company cap
  bound accumulation. Set `false` to run Commander ephemeral-per-turn
  (create + destroy each turn), trading warm-disk continuity (codex `resume`
  via `~/.codex`) for a smaller idle-VM footprint.
- `enableWarmSandboxReaper` + `warmSandboxIdleTtlMinutes` (default `30`) — the
  idle reaper destroys warm paused leases older than the TTL and evicts the
  oldest paused lease when a per-company cap is hit, bounding the per-user
  idle-VM cost surface the warm model introduces.

### Commander-in-sandbox credential taxonomy

Extends the parent E2B credential taxonomy (cloud-execution-isolation spec §9)
for the Commander run kind. Same posture org/crew already have — intra-company
defense-in-depth, not a tenant boundary.

**Never enters the Commander VM** (host-side only): `DATABASE_URL` /
`DIRECT_DATABASE_URL`, the secrets master key, `GITHUB_PAT`, `BETTER_AUTH_SECRET`
/ `AOA_AGENT_JWT_SECRET` (the key that **mints** the run-JWT), `REDIS_URL`, the
embeddings `OPENAI_API_KEY`, the operator `~/.claude` login, and OAuth connector
refresh tokens / signed bundles (`mcp:oauth:<id>`).

**Enters the Commander VM** (scoped, short-lived): the per-turn Commander
run-JWT as `AOA_API_KEY` (company-bound, ~10 min TTL, dead after the turn), the
company's own BYO model-provider API key (cloud shared-pool is API-key-only — no
subscription creds), and the company's own connector **access** tokens
(`AOA_MCP_*_TOKEN`, short-lived, re-resolved fresh at every stage-in incl. warm
resume — never the stale paused-env token). The U5 env allowlist
(`buildSandboxEnvAllowlist`) is the sink that enforces this, keyed on the
**model provider family** (`anthropic`/`openai`/…) — not the E2B infra id.

**Blast radius of a fully-compromised Commander turn:** that ONE company's own
tasks / goals / memory / artifacts (read/write within the driving user's RBAC),
its own injected model key, its own connector access tokens. **Cannot reach:**
the control-plane DB, the secrets/signing keys, `GITHUB_PAT`, any other tenant's
data, the operator login, or OAuth refresh tokens.

**Threat-model notes:**

- **N-1 — the Commander run-JWT is a same-company bearer credential** (parity
  with the agent run-JWT), so its blast radius is "all same-company
  `assertCompanyAccess`-gated routes," bounded by the 10-min TTL + per-user +
  company scope — **not** broker-only. A leaked token is a same-company,
  time-boxed credential, not a cross-tenant one.
- **N-2 — the mint site derives `companyId`/`userId`/`userRole` server-side**
  from the authenticated session, never from client input, so a caller cannot
  widen its own company/role by crafting the token request.

## Board Claim Flow

When migrating from `local_trusted` to `authenticated`, set
`AOA_HEADLESS_BOOTSTRAP=1` if `local-board` is still the only instance admin.
AoA then emits a one-time claim URL at startup:

```
/board-claim/<token>?code=<code>
```

A signed-in user visits this URL to claim board ownership. This:

- Promotes the current user to instance admin
- Demotes the auto-created local board admin
- Ensures active company membership for the claiming user

"Headless" refers to the server setup: the claim can be completed from a
different browser that can reach the server. The claiming user must still sign
in with Google before ownership can be transferred.

## Changing Modes

Update the deployment mode:

```sh
pnpm aoa configure --section server
```

Runtime override via environment variable:

```sh
AOA_DEPLOYMENT_MODE=authenticated pnpm aoa run
```

## Security Headers (helmet + CSP)

AoA mounts [helmet](https://helmetjs.github.io/) on every response. The exact header set depends on deployment mode:

| Header | `local_trusted` (dev) | `local_trusted` (prod / npm install) | `authenticated` |
|--------|------------------------|----------------------------------------|------------------|
| `Content-Security-Policy` | not set | strict | strict |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` | `same-origin-allow-popups` | `same-origin-allow-popups` |
| `Cross-Origin-Resource-Policy` | `same-site` | `same-site` | `same-site` |
| `Cross-Origin-Embedder-Policy` | not set | not set | not set |
| `X-Content-Type-Options` | `nosniff` | `nosniff` | `nosniff` |
| `X-Frame-Options` | `SAMEORIGIN` | `SAMEORIGIN` | `SAMEORIGIN` |
| `Referrer-Policy` | `no-referrer` | `no-referrer` | `no-referrer` |

**CSP is skipped only when** `AOA_DEPLOYMENT_MODE=local_trusted` AND `NODE_ENV !== "production"`. This is the Vite-HMR dev case — HMR's runtime injects inline scripts and uses `eval`, both of which strict CSP would block. Loopback is the trust boundary in dev.

Strict-CSP directives:

```
default-src 'self';
script-src 'self' 'sha256-<hash>';            // hash of the FOUC bootloader in index.html, computed at server startup
style-src 'self' 'unsafe-inline';             // Vite injects styles via dynamic <style>
img-src 'self' data: blob: https:;            // avatar generators + asset previews
font-src 'self' data:;
connect-src 'self';                           // UI never calls LLM APIs directly — all LLM traffic is server-mediated
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests
```

`connect-src 'self'` is intentionally tight. If you wire a custom backend that fetches LLM endpoints from the **browser** (uncommon — most operators keep LLM calls server-side), you'll need to extend the directive list in `server/src/services/helmet-options.ts`. Cross-Origin-Embedder-Policy (`require-corp`) stays disabled because it would block any external avatar/image without a CORP header.

When `index.html` changes, the inline-script hash auto-updates on next server start (no rebuild of the helmet config required). The hash extractor lives in `server/src/services/csp-script-hashes.ts`.
