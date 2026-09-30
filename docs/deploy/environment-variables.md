---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that AoA reads. Grouped by concern. The list is verified against `process.env` reads in `server/src/`, `cli/src/`, and `packages/`; the brand-check CI job in `.github/workflows/pr.yml` keeps it in sync.

> **Legacy `PAPERCLIP_*` aliases.** Every `AOA_FOO` env var has a legacy `PAPERCLIP_FOO` alias that's mirrored at startup by `server/src/env-compat.ts` (and `cli/src/config/env-compat.ts` for the CLI). If both are set, `AOA_*` wins. The mirror runs only inside the spawned Node process — bash invocations of project scripts must use `AOA_*` directly.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port (alias: `AOA_LISTEN_PORT`, `AOA_SERVER_PORT`) |
| `HOST` | `127.0.0.1` | Server host binding (alias: `AOA_LISTEN_HOST`, `AOA_SERVER_HOST`) |
| `DATABASE_URL` | (embedded) | PostgreSQL connection string. If unset, AoA boots `embedded-postgres@18.x` automatically |
| `AOA_HOME` | `~/.aoa` (with legacy `~/.paperclip` fallback) | Base directory for all AoA data. Resolved by `cli/src/config/home.ts`: prefers `~/.aoa/`, falls back to `~/.paperclip/` if the legacy dir exists and the new one does not |
| `AOA_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances on one machine) |
| `AOA_RUNTIME_PROCESS_OWNER_ID` | host + `AOA_INSTANCE_ID` fingerprint outside `cloud_auth`; unset in `cloud_auth` | Stable identity for the OS PID namespace/replica that owns `local_process` runtime services. It is required before the unsafe cloud override may start a local runtime service **and on every cloud replica that boots while the shared DB still contains PID-bearing local-runtime rows**. Set a unique value per concurrently live replica/PID namespace (for example a Kubernetes Pod UID), and keep it stable while detached children from that owner can survive a server restart. Never share it across replicas. This is process-safety provenance; `AOA_INSTANCE_ID` and `AOA_EXECUTION_TARGET_ID` are not substitutes. |
| `AOA_DEPLOYMENT_MODE` | `local_trusted` | `local_trusted`, `authenticated`, or `cloud_auth`. Pass the configured value to manual `pnpm db:migrate` runs so migration safety policy is explicit. |
| `AOA_DEPLOYMENT_EXPOSURE` | `private` | `private` or `public`. Meaningful for `authenticated`; `cloud_auth` requires `public`. |
| `AOA_PUBLIC_URL` | (derived) | Public-facing URL for deployment. Used in invite links and webhook URLs |
| `AOA_DEPLOY_SHA` | (unset) | Exact lowercase 40-character Git commit injected by the trusted deployment workflow. The server exposes it from `/api/health` so deployment health checks can prove the running container matches the requested revision. Leave unset for ordinary local development. |
| `AOA_IMAGE_REVISION` | `unknown` | Build-time revision written to the container's `org.opencontainers.image.revision` label. When supplied to the server as an exact lowercase 40-character Git SHA, marketplace reconciliation also accepts it as a fallback if `AOA_DEPLOY_SHA` is absent. The trusted remote deployment passes the same reviewed SHA to both values. |
| `AOA_ALLOWED_HOSTNAMES` | (empty) | Comma-separated allowlist of hostnames the server will accept (Tailscale, Docker host alias, etc.) |
| `AOA_TRUST_PROXY` | `false` | Express trust-proxy setting. Set to `true` (trust any proxy), a hop count like `1` (recommended for cloud), or a comma-separated CIDR list. Required when running behind Cloudflare/ALB/nginx — without it, `req.ip` reads the proxy IP and rate limits collapse. **Never set to `true` on a directly-exposed deployment** (allows X-Forwarded-For spoofing). |
| `AOA_OPEN_ON_LISTEN` | `true` (CLI), `false` (server-only) | Auto-open default browser on first listen |
| `AOA_CONFIG` | (default path) | Override path to instance `config.json` |
| `AOA_LOG_DIR` | `<AOA_HOME>/instances/<id>/logs` | Override log directory |
| `RUN_LOG_BASE_PATH` | `<AOA_HOME>/instances/<id>/data/run-logs` | Override local-file heartbeat run log storage. Use a durable mounted volume in Docker/cloud single-node deployments |
| `WORKSPACE_OPERATION_LOG_BASE_PATH` | `<AOA_HOME>/instances/<id>/data/workspace-operation-logs` | Override local-file workspace operation log storage. Use a durable mounted volume in Docker/cloud single-node deployments |

For horizontally scaled deployments, local-file run logs require sticky routing or shared durable storage. Object-storage-backed run logs are a future backend; do not rely on per-container ephemeral disk for production run history.

## Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `AOA_AUTH_BASE_URL_MODE` | `auto` | `auto` (derive from request) or `explicit` (use `AOA_AUTH_PUBLIC_BASE_URL`) |
| `AOA_AUTH_PUBLIC_BASE_URL` | — | Required when `AOA_AUTH_BASE_URL_MODE=explicit`. Public URL where Better Auth callbacks resolve |
| `AOA_AUTH_STORE` | `default` | Auth-store backend selection |
| `BETTER_AUTH_BASE_URL` | (derived) | Override for Better Auth base URL — usually leave unset and let `AOA_AUTH_*` drive it |
| `BETTER_AUTH_SECRET` | (required when `AOA_DEPLOYMENT_MODE!="local_trusted"`) | HMAC secret for Better Auth session cookies and root key for MCP OAuth state/bundle signing. **Required** for `authenticated` (and any future non-local-trusted) deployment — the server refuses to start if unset. `AOA_AGENT_JWT_SECRET` is the OAuth/JWT fallback when `BETTER_AUTH_SECRET` is absent. Auto-generated on first `pnpm aoa onboard`; set one stable value explicitly for multi-instance setups. Rotating the effective root key invalidates outstanding OAuth flows and stored signed OAuth bundles, so disable affected connectors and reauthorize them after rotation. |
| `BETTER_AUTH_TRUSTED_ORIGINS` | (derived) | CORS allowlist for Better Auth |
| `BETTER_AUTH_URL` | (derived) | Better Auth canonical URL |
| `AOA_DEV_LOCAL_IDENTITY` | auto-enabled by `pnpm dev` when local Google credentials are absent | Development-only synthetic board identity for loopback `local_trusted` mode. It is ignored outside `local_trusted`; do not use it for an authenticated or exposed deployment. |
| `AOA_DEV_LOCAL_IDENTITY_FORCE` | `false` | Allows `AOA_DEV_LOCAL_IDENTITY` on an instance that already contains real users. Development/recovery only: this bypasses the populated-instance safety check. |
| `AOA_HEADLESS_BOOTSTRAP` | `false` | Enables the legacy board-ownership claim path for a headless/self-hosted server migrating from `local_trusted` when `local-board` is still the only instance admin. The claim is completed by a real Google user in a browser that can reach the server. Leave disabled for normal onboarding. |

### CLI subscription authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `AOA_INSTALL_PROFILE` | Derived from deployment mode/exposure | High-level CLI-auth topology: `local_single_user`, `remote_single_tenant`, or `hosted_multi_tenant`. Shared hosted installations disable subscription sign-in. |
| `AOA_NETWORK_LOCATION` | From install profile | Advanced topology override: `local` or `remote`. It must agree with `AOA_INSTALL_PROFILE`. |
| `AOA_TRUST_BOUNDARY` | From install profile | Advanced topology override: `single_user`, `single_tenant`, or `multi_tenant`. It must agree with `AOA_INSTALL_PROFILE`. |
| `AOA_EXECUTION_OWNERSHIP` | From install profile | Advanced topology override: `user_hosted`, `tenant_hosted`, or `aoa_hosted`. It must agree with `AOA_INSTALL_PROFILE`. |
| `AOA_CODEX_DEVICE_AUTH` | `false` on remote installs | Enables Codex device-code subscription sign-in on a dedicated `remote_single_tenant` installation. It never enables sign-in on `hosted_multi_tenant`. |
| `AOA_CLAUDE_PASTE_AUTH` | `false` on remote installs | Enables Claude paste-code subscription sign-in on a dedicated `remote_single_tenant` installation. It never enables sign-in on `hosted_multi_tenant`. |
| `AOA_EXECUTION_TARGET_ID` | `control-plane` | Stable identity of the execution target that owns the provider-native credential files. Login, verification, binding, and agent execution must use the same value. Since Phase 5 (multi-tenant cloud, `execution_targets` registry) this string is an `execution_targets.slug` — the default `control-plane` is the row `ensureControlPlaneExecutionTarget` seeds idempotently at boot (`organization_id = NULL`, `kind = local_host`, `trust_class = local_trusted`). A dedicated worker for a personal subscription is registered with its own slug (`POST /organizations/:orgId/execution-targets`) and that slug is what `AOA_EXECUTION_TARGET_ID` must be set to on that worker. |
| `AOA_SCOPED_CLI_AUTH` | `false` | When true, subscription-backed agent runs require a verified company/user/provider credential binding and fail closed if it is absent. Verified bindings are preferred even when this flag is false; the flag controls whether an entirely missing binding may fall back to the legacy global CLI home. |
| `AOA_PROVIDER_RESOLVER` | (unset) | Dark-launch kill-switch for the Phase 4 unified provider-credential resolver. Set to `legacy` to bypass the new `provider_connections` / `provider_assignments` model and resolve credentials via the legacy ladder only (the `company_secrets` API-key env ladder + the subscription auth-home ladder), reproducing pre-Phase-4 behaviour with no redeploy. Any other value — or leaving it unset — uses the unified resolver. Read at `server/src/services/provider-resolution-deps.ts`. |

### Execution targets & gVisor pool egress (multi-tenant cloud, Phase 5)

Phase 5 adds a tenant-scoped `execution_targets` registry (fleet inventory) on
top of the `AOA_EXECUTION_TARGET_ID` identity above. Runs route to a target by
credential kind — `execution-target-resolver.ts`: a business (company) API key
routes to the shared `pooled_gvisor` target, a personal subscription routes to
the dedicated target whose slug matches its bound `AOA_EXECUTION_TARGET_ID`. No
new environment variable governs this routing; it reads the `execution_targets`
table and the P4 credential-kind seam. Self-hosted single-tenant installs are
unaffected — they never populate `execution_targets` beyond the seeded
`control-plane` row, and `resolveExecutionTargetForRun` falls back to the local
driver when no pool target exists.

**Pool egress allowlist policy.** A pooled gVisor run's Docker hardening
(`--runtime=runsc`, dropped capabilities, read-only rootfs, etc.) is applied by
the app layer via opt-in `buildDockerRunArgs` isolation flags — see
[`docs/aoa/guides/gvisor-worker-image.md`](../aoa/guides/gvisor-worker-image.md)
for the exact flag set. **Network egress filtering is NOT an app-layer
concern**: `--network none` is the safe default (no egress at all), and a
pooled run that needs the provider API must run on a **filtered** `bridge`
network — filtering is a worker-image deliverable (a `DOCKER-USER` iptables/
nftables policy or an egress proxy) that denies RFC1918, `169.254.0.0/16`
(cloud metadata, incl. `169.254.169.254`), and the control-plane CIDR, while
allowing only the provider API hosts and package registries. There is no
environment variable for this allowlist yet — it is configured on the worker
image/host, not via AoA server env vars. **As of this writing that firewall has
not been validated on real hardware** (Task 0's spike is a pending Gate-B step,
not yet run) — see the guide's status banner before deploying a pool on
`bridge`.

### Unsandboxed multi-tenant execution gate

| Variable | Default | Description |
| --- | --- | --- |
| `AOA_ALLOW_UNSANDBOXED_MULTITENANT` | unset (local execution refused) | **Multi-tenant safety gate (D1).** When tenant isolation is enforced (`cloud_auth`), agent/crew/Commander processes, local Docker targets (including a claimed `runtime: "runsc"`), adapter probes, workspace provision/cleanup/jobs, and local runtime-service commands are REFUSED on the control-plane host unless this is set to `1`/`true`/`yes`. Real per-tenant execution isolation is deferred; a runtime string is not worker-plane provenance. New workspace-command configuration is also rejected without this override, while sink checks protect legacy persisted configuration. When set, the process logs one loud process-wide SECURITY warning. Self-hosted deployments (`local_trusted` and `authenticated` single-tenant) ignore this. Do not use the override in production multi-tenant deployments. **FND-005 (Decision #121):** in `cloud_auth` this override is now rejected at startup (`loadConfig`) — hosted execution must use an isolated worker/provider boundary; it remains self-hosted emergency compatibility only. |

### Distributed execution rollout (FND-005, default-off)

Governed by [`distributed-execution-delivery-policy.md`](../architecture/distributed-execution-delivery-policy.md) and Decision #121. The deployment flag is default-off; the reserved surfaces are hard-negative sentinels, not features.

| Variable | Default | Description |
| --- | --- | --- |
| `AOA_DISTRIBUTED_EXECUTION_ENABLED` | unset (`false`) | Default-off deployment gate for distributed execution. Enabling it **creates no worker by itself** and registers no distributed route, but it does require and verify both bounded database pools below before startup continues. The per-Organization rollout flag (E3/E10) and per-workload flag remain separately required (`resolveDistributedExecutionRollout`). Accepts `1`/`true`/`yes`/`on` (or `0`/`false`/`no`/`off`); any other value fails startup. |
| `AOA_DISTRIBUTED_EXECUTION_ROLLOUT` | unset (`{}` — all Organizations off) | CLI-005 config-driven per-Organization / per-workload rollout source that feeds the otherwise-stubbed org+workload inputs of `resolveDistributedExecutionRollout`, making the three rollout states reachable **without a new table or migration**. JSON: `{"organizations":{"<organizationId>":{"mode":"shadow"\|"active","workloads":["batch","*"]}}}`. An Organization absent from the map is **off**; a workload absent from an enabled Organization's `workloads` (and no `*`) is off; `mode` selects shadow vs active. **Gated behind `AOA_DISTRIBUTED_EXECUTION_ENABLED` first** — a flag-off deployment resolves every run to `off` regardless of this map, so the legacy adapter stays the sole executor. `shadow` runs an effect-free routing/provenance/policy comparison only; `active` mints a durable **non-leasable** job (inert until MIG-002) and moves checkout ownership to the admission bridge. Malformed JSON/shape fails startup validation loudly, and at RUNTIME fails closed (every Organization resolves to `off`, logged once). **MIG-002: edits take effect LIVE — no restart** (the source re-reads per resolution, memoized on the raw string). **`sources`** is an optional per-sink allow-list on an Organization entry (`["commander_turn","crew_run"]`, or `["*"]`); **absent means all sinks**, the pre-MIG-002 behaviour. It exists because all four cutover sinks share `workloadType: "batch"`, so `workloads` alone cannot express a one-sink-at-a-time cutover. An unknown source kind fails the parse. Pinned by `rollout-dial-live.test.ts`. **★ BEFORE ARMING THIS FOR A REAL ORGANIZATION, READ THE BILLING WARNING.** A run that is handed off to distributed execution writes **no** `cost_events` row, so `budget_policies`, the per-agent `budgetMonthlyCents` pause and the crew/company hard-stop are all blind to its spend. Measured 2026-09-07; open as finding **E3-F037** (`docs/replatform/epics/E3-job-control/findings.md`), with the operator-facing version in `docs/replatform/epics/E7-coding-e2b/tickets/CLI-006-staging-canary-runbook.md` §2.1. Do not arm this for an Organization whose spend must be capped. |
| `AOA_APP_DATABASE_URL` | unset | Required only when distributed execution is enabled. PostgreSQL URL whose authenticated `session_user` and active `current_user` are both exactly the NOSUPERUSER/NOBYPASSRLS/NOINHERIT/NOREPLICATION `aoa_app` tenant-serving role. Missing, invalid, privileged, masked by startup role options, wrong-role, inherited, owned-object, or out-of-matrix authority fails startup; there is no owner-pool fallback. |
| `AOA_OPERATOR_DATABASE_URL` | unset | Required only when distributed execution is enabled. PostgreSQL URL whose authenticated `session_user` and active `current_user` are both exactly the bounded NOSUPERUSER/NOBYPASSRLS/NOINHERIT/NOREPLICATION `aoa_operator` platform-metadata role. Startup role options cannot mask a broader login. Its current pre-JOB-002 surface is read-only named metadata columns; it is not a tenant/job-data connection. |
| `AOA_APP_DB_PASSWORD` | unset | Optional boot-time credential provisioning for `aoa_app`, performed through the migration/bootstrap owner before the bounded pool opens. Prefer external secret provisioning where available; never commit this value. |
| `AOA_OPERATOR_DB_PASSWORD` | unset | Optional boot-time credential provisioning for `aoa_operator`, with the same bootstrap-only handling. Prefer external secret provisioning; never commit this value. |
| `AOA_WORKER_SESSION_SIGNING_KEY` | unset (dev fallback) | HMAC signing key for the short-lived `aoa-worker-session` JWTs issued by the JOB-002 worker enrollment route and verified on `/worker-control/poll` and `/leases/:id/ack`. Set a strong, stable secret per deployment when distributed execution is enabled; rotating it invalidates all live worker sessions. Never commit this value. |
| `AOA_CONTROL_PLANE_SIGNING_KEY_FILE` | unset (inert) | **Control plane (DEP-012 Slice 4+5).** Path to the mounted ed25519 control-plane **PRIVATE** key (PEM PKCS#8) that MINTS the owned-labels capability in the sandbox-local resolve reply. It must be the matched pair of the adapter-manager's `AOA_ADAPTER_MANAGER_CONTROL_PLANE_PUBLIC_KEY_FILE` — verify at C0 with `pnpm verify:cp-am-keypair` BEFORE the canary (a mismatch is maximally silent: every gated create fails with the uniform error). Loaded with a try/catch → refuse: **unset ⇒ inert** (no capability minted, byte-identical to pre-DEP-011); **set but unparseable/non-ed25519 while distributed execution is enabled ⇒ refusal to boot** (never a silent inert = the dead path); set-but-bad with distributed execution off ⇒ inert. Mount out-of-band; never commit this value. |
| `AOA_D1_TEST_REAP_ENABLED` | unset (`false`) | **Test-harness only.** Enables the dormant, unauthenticated `POST /api/worker-control/_test/reap` trigger (DEP-005), which fires one synchronous lease reap so the D1 network/clock fault harness can cross a lease deadline without sleeping. Deliberately **decoupled** from `AOA_DISTRIBUTED_EXECUTION_ENABLED`: both must be set for the route to respond, and this flag is set **only** in `docker-compose.d1.yml` — never in any real deployment — so enabling distributed execution in `cloud_auth` does not expose it. Leave unset everywhere except the D1 CI stack. |
| `AOA_D1_SEED_WORKER_ENROLMENT` | unset (`false`) | **Test-harness only (WRK-017).** Read by `docker/control-plane/migrate-entrypoint.sh`, not by the server. When `1`, the PRIVILEGED D1 migrate job runs `seed-d1-worker-enrolment.mjs`: it registers ONE worker's `execution_targets` row ACTIVE and authorizes the single-use enrolment code carried by the committed ticket, so a real worker container can ENROL during `docker compose up --wait`. It must run there rather than from a `docker compose exec` seed, because a first-boot enrol failure is `proc.exit(1)` in the daemon and the D1 workers declare no `restart:` policy. Set **only** in `docker-compose.d1.yml`; a no-op on every other deploy path. |
| `AOA_D1_SEED_WORKER_PROFILE_FILE` | unset | **Test-harness only (WRK-017).** Path to the committed worker profile the enrolment seed reads its target id, scope, organization and capability ceiling from (`/seed-worker.profile.json` in the D1 compose, a read-only bind of `docker/d1/worker-b.profile.json`). Required when `AOA_D1_SEED_WORKER_ENROLMENT=1`. |
| `AOA_D1_SEED_ENROLMENT_TICKET_FILE` | unset | **Test-harness only (WRK-017).** Path to the committed enrolment ticket the seed DECODES to learn which code to authorize (`/seed-enrolment-ticket` in the D1 compose). It is a read-only bind of the SAME file the enrolling worker mounts at its `AOA_WORKER_ENROLLMENT_CODE_FILE`, which is what keeps the seeded authority and the presented credential from drifting. Required when `AOA_D1_SEED_WORKER_ENROLMENT=1`. |
| `AOA_D1_SEED_ENROLMENT_TTL_MINUTES` | `120` | **Test-harness only (WRK-017).** Lifetime written to the seeded `worker_enrollment_code_routes` / `worker_enrollment_codes` rows. Deliberately longer than the product's 10-minute `CODE_TTL_MS`, because the seed runs at migrate time while the worker enrols only after the control plane has built, booted and gone healthy; a 10-minute fixture would make the lane flaky and would prove nothing extra (expiry has its own unit and integration coverage). Must be an integer in `[1,1440]`. |
| `AOA_WORKER_POLL_RATE_LIMIT_MAX` | `100000` | DEP-009 shared worker-poll admission limit: maximum admitted `/worker-control/poll` requests **per Organization per fixed window**, enforced across ALL control-plane replicas via one shared PostgreSQL counter (`worker_admission_rate_limits`), not per-process. Over the cap, poll is denied with the retryable `throttled` (429). A generous default (a per-org safety valve, not a tight throttle); tune down for stricter admission. Only consulted when distributed execution is enabled. Must be a positive integer. |
| `AOA_WORKER_POLL_RATE_LIMIT_WINDOW_MS` | `60000` | DEP-009 shared worker-poll admission window length in milliseconds (the fixed-window bucket for `AOA_WORKER_POLL_RATE_LIMIT_MAX`). The counter resets each window. Only consulted when distributed execution is enabled. Must be a positive integer. |
| `AOA_DISTRIBUTED_PUBLIC_SERVICE_INGRESS_ENABLED` | unset (excluded) | **Reserved hard-negative sentinel.** Public service ingress is excluded from this re-platform release. Any truthy value **rejects startup in every deployment mode** rather than enabling a feature; the reserved path `/api/distributed-execution/public-services` is unregistered and returns `404`. |
| `AOA_DISTRIBUTED_CLOUD_PLUGIN_EXECUTION_ENABLED` | unset (excluded) | **Reserved hard-negative sentinel.** The distributed cloud-plugin surface is excluded from this re-platform release. Any truthy value **rejects startup in every deployment mode**; the reserved path `/api/distributed-execution/cloud-plugins` is unregistered and returns `404`. FND-006/FND-008 own the actual current plugin surfaces (Decision #103). |

### Rolling distributed execution back

**The rollback path is an ordered pair, and both steps have sharp edges. Read the whole section
before an incident, not during one.**

#### Step 1 — stop new leases (immediate, but there is NO UI and NO API)

Insert a kill-switch entry into `instance_settings.kill_switches`. The worker poll re-reads this
row from the database on **every poll**, so the effect is immediate once written.

**There is no write path.** No route, no CLI, no admin screen writes this column — the only
mutation anywhere in the repository is in a test. Throwing this switch today means an operator
executing SQL against the production database by hand. A UI/API is REL-001/REL-005.

```sql
UPDATE instance_settings
   SET kill_switches = '[{"dimension":"provider","value":"e2b","reason":"incident 1234"}]'::jsonb
 WHERE singleton_key = 'default';
```

**It is not scoped to an Organization or to a sink.** The only dimensions are `provider` and
`template` (`KILL_SWITCH_DIMENSIONS`), so this stops the named provider for the **whole
instance** — every Organization, every workload. There is no way to stop one tenant this way.
Add `"reclaim": true` to an entry only when you also intend to destroy that provider's paused
sandboxes (REL-004 clause 3b); a plain entry stops placement and touches nothing.

#### Step 2 — stop minting new distributed work (live, MIG-002)

Edit `AOA_DISTRIBUTED_EXECUTION_ROLLOUT` — remove the Organization's key, downgrade its `mode`,
or drop a sink from its `sources` list. **This takes effect on the next resolution; no restart.**

> **IF YOU DO RESTART, KEEP `AOA_DISTRIBUTED_EXECUTION_ENABLED` SET TO TRUE.**
>
> A restart is no longer needed for a rollback, but if one happens for any other reason,
> restarting with the flag unset **strands every already-handed-off run.** Such a run carries a
> durable `execution_owner = "distributed"` marker, and the orphaned-run reaper deliberately
> stands down on that marker — including on the startup sweep — because the attempt projector is
> the terminal authority for those runs. But the projector is only composed when the flag is on.
> Flag-off, nothing terminalizes them and nothing reaps them: the run stays `running` and holds
> its issue lock indefinitely.
>
> Unset the flag only after in-flight distributed work has drained.

**A malformed value fails closed.** Because the map is re-read per resolution, a bad edit lands
on a running process: every Organization resolves to `off` (legacy) and an error is logged once.
Fix the value and it recovers on the next resolution — still no restart.

#### Why the order matters

Step 1 first, then step 2. Step 1 stops new leases while letting in-flight work finish; step 2
stops new distributed work being minted at all. Doing step 2 alone leaves a window where a run
has just been handed off — legacy adapter suppressed, attempt lease-eligible — and there is no
automated convergence: `createJobControlSweeper`, `createDistributedExecutionDrain` and
`createExecutionTargetRevocationFanout` all have **zero production callers** today, and the
drain's `listActiveAttempts` has no SQL implementation at all. The only convergent action left
is a manual per-run cancel.

**Unsetting `AOA_DISTRIBUTED_EXECUTION_ENABLED` is not a master switch.** It is live for new
heartbeat conversions (the rollout hook re-reads it per call), but the worker control routes are
registered behind a construction-time check, so workers keep polling and leasing until a restart.
See the warning above for why unsetting it is also not a safe way to perform step 2.

### Distributed worker daemon (staging, DEP-006)

Read by the separately-deployed worker daemon (`packages/worker-daemon`). A worker
carries **no** database credential and **no** provider-control credential; it reaches
the control plane and the object store over egress and brokers all provider lifecycle
through the adapter-management surface. Rendered in `docker-compose.staging.yml`.

| Variable | Default | Description |
| --- | --- | --- |
| `AOA_WORKER_TARGET_PROFILE_ID` | (required) | Stable identifier of the execution-target profile this worker enrolls as. Distinct per worker service in the staging fleet. |
| `AOA_WORKER_TARGET_SCOPE` | (required) | Trust scope of the worker's target (`platform` / `organization` / …); must match the registered target profile's scope. |
| `AOA_WORKER_DISPATCH_ENABLED` | unset (disabled) | WRK-008. Worker-side opt-in for taking work. Exactly `1` enables; unset/empty/`0` disable; any other value is a **startup error** (so an intended enable is never silently ignored). Composition is ALSO gated on a sandbox provider being injected: the **container** binary cannot construct one (E4-D01 — the daemon image cannot carry a provider package), and the **desktop** binary constructs one only on an explicit opt-in via `AOA_WORKER_SANDBOX_PROVIDER` (DEP-010). So this flag matters only once a provider is present, and even then it stays off by default. Never set on a staging worker (a static manifest invariant rejects it). |
| `AOA_WORKER_SANDBOX_PROVIDER` | unset (no provider) | DEP-010. **Desktop/self-hosted** opt-in for a real sandbox provider. `e2b` builds an `E2bSandboxProvider` (requires `AOA_WORKER_E2B_TEMPLATE`); `none`/unset/empty ⇒ no provider is constructed and the `e2b` SDK is not even loaded — the shipped default. Any other value is a **refusal to boot** (an explicit opt-in that cannot be honoured fails loudly, never degrades to no-provider). Read ONLY on the desktop composition root (`worker-keystore`); the container root cannot construct a provider (E4-D01). Never set on a staging worker (a static manifest invariant rejects it). |
| `AOA_WORKER_E2B_TEMPLATE` | (required with `=e2b`) | DEP-010. The E2B sandbox template id the desktop provider launches. Required when `AOA_WORKER_SANDBOX_PROVIDER=e2b`; setting the provider switch WITHOUT a template is a **refusal to boot**, not a degrade. |
| `AOA_WORKER_PROVIDER_URL` | unset (no provider) | DEP-011 Slice 2b. **Container** opt-in for the NETWORKED sandbox provider. Set ⇒ the `worker-networked-host` boot root builds a per-run `makeRunProvider` factory that dials the adapter-manager at this base URL over the gated provider wire (each run's driver is bound to that run's minted owned-labels capability); unset/empty/whitespace ⇒ no factory, and the container boots exactly as the inert default (refuses `no_provider`). The container analogue to the desktop `AOA_WORKER_SANDBOX_PROVIDER`: worker-daemon cannot construct any provider (E4-D01), so the networked driver lives OUTSIDE it and is threaded in via the container host's bootstrap seam. **Ships inert.** Blocker B gave the networked-host bin an image home (`/worker-net-app/dist/bin/networked-host.js` in the worker image), but the image `CMD` is UNCHANGED and still enters the daemon bin — a global repoint would crash-loop the fleet (`runContainerHost` builds `FileRecordStore`s unconditionally and `resolveCustody` refuses `mounted_secret` with stores). Entering the new bin therefore needs a per-service `command:` override, and BOTH halves are now guarded: this variable is a `DISPATCH_SWITCH_ENVS` member (rejected on any staging worker, in `environment` and inline in `command`/`entrypoint`), and `checkWorkersEnterTheDaemonBin` rejects a D1 worker that enters the bin. Never set on a staging worker. |
| `AOA_WORKER_EVENT_OUTBOX_PATH` | unset (`null`) | WRK-008 slice 2b. Filesystem path for the daemon's durable event outbox (a SQLite DB). Set ⇒ the outbox opens there when dispatch composes; **unset/empty/whitespace ⇒ `null`**, and composing dispatch REFUSES with `no_event_outbox_path` (a required event sink cannot fall back to a no-op — that would silently drop a security-evidence stream). NOT defaulted to a path: a default the container cannot write would turn every inert boot into a failure. Read only inside the `compose:true` branch, so it matters only once a provider + the flag are present. |
| `AOA_WORKER_CONTROL_PLANE_URL` | (required) | Base URL the worker dials for `/worker-control/*` (enroll/poll/ack). In staging this points at the shared control-plane ingress; a session minted at either replica is portable (shared `AOA_WORKER_SESSION_SIGNING_KEY`). |
| `AOA_WORKER_S3_ENDPOINT` | (required) | Worker-facing object-store endpoint the worker dials for presigned artifact PUT/GET. Points at the external object store's presign host; carries no credential (the presigned URL is the authority). |
| `AOA_WORKER_KEY_STORE_MODE` | `mounted_secret` | How the worker sources its device custody. `mounted_secret` = an orchestrator-mounted key file with NO identity slot (the shipped container default — it holds a key, cannot enrol, and stays inert). `os_keychain` = the desktop OS-custody store (DSK-001). `file_record` = WRK-014's filesystem-backed device-IDENTITY store a container host writes under `AOA_WORKER_STATE_DIR`, so a container can enrol and persist an identity. Invalid values are a startup error. |
| `AOA_WORKER_STATE_DIR` | `/worker` | WRK-014. Directory the `file_record` custody store persists the device identity (`identity.json`) and enrollment receipt (`receipt.json`) into. Read DIRECTLY by the container host (not via the config parser), only under `AOA_WORKER_KEY_STORE_MODE=file_record`. It MUST be a durable NAMED volume for a canary worker: a recreated container that lost this directory re-mints a `workerId` the control plane denies (`worker_transfer_denied`) permanently, and there is no container reset. The host asserts the directory is writable at boot and refuses to start (exit 1) if it is not — a loud failure, never a silent re-mint. |
| `AOA_WORKER_HEALTH_PORT` | `9464` | Port the worker binds its `/healthz` liveness endpoint on. |
| `AOA_WORKER_ENROLLMENT_CODE_FILE` | (required) | Path to the mounted single-use worker enrollment code file, presented once at enroll. |

### Provider-control credential (staging adapter-management surface, DEP-006)

Read **only** by the adapter-management surface (`adapter-manager` in
`docker-compose.staging.yml`), the sole surface on `provider-ctl-net`. These are
**injected** from the orchestrator secret store (rotatable without an image rebuild),
never baked into an image, and **absent** from every control-plane / worker / migrate
surface, from protocol/metadata, and from logs/support bundles. Rotation, old-key
denial, and revocation rehearsal against a real provider is contracted against DEP-008
and deferred to CLI-001 (crosswalk rows CM-010 / CM-012).

| Variable | Default | Description |
| --- | --- | --- |
| `E2B_API_KEY` | (required on the adapter surface) | Provider-control (E2B) account/audience-scoped credential used by `sandbox-provider-runtime.ts` to create/connect/execute/pause/kill/destroy provider sandboxes. Injected only into the adapter-management surface; rotatable via the secret store; never placed on a control-plane, worker, tenant sandbox, protocol field, log line, or support bundle. |
| `E2B_DOMAIN` | (unset) | Optional provider-control API domain override for the adapter-management surface (self-hosted / regional E2B endpoint). |

### Adapter-manager composition root (DEP-012 Slice 3 · β2)

Read **only** by the adapter-manager composition-root bin
(`packages/adapter-manager/src/bin/adapter-manager.ts`), the process that hosts the per-op
`SandboxProvider` and mounts `createProviderServer`. The bin is **fail-closed**: it refuses
to boot (exit 1, `createProviderServer` never called) unless it can resolve a provider AND
load a valid ed25519 control-plane PUBLIC key — a missing key would boot an **ungated**
server (create/execute unprotected), so absence is a refusal, never a silent default. The
bin never reads the provider-control credential (`createRealE2bTransport` does; DEP-006).
The control-plane key compose env is DEPLOY-OWED (Slice 5); the bin fail-closes without it.

| Variable | Default | Description |
| --- | --- | --- |
| `AOA_ADAPTER_MANAGER_SANDBOX_PROVIDER` | unset (refuse) | Names the sandbox provider the host constructs. `e2b` builds an `E2bSandboxProvider` over the real transport (requires `AOA_ADAPTER_MANAGER_E2B_TEMPLATE`). Unlike the desktop worker, `none`/unset/empty is a **refusal to boot** — the adapter-manager IS the provider host and cannot run without one. Any other value is also a refusal. |
| `AOA_ADAPTER_MANAGER_E2B_TEMPLATE` | (required with `=e2b`) | The E2B sandbox template id the host provider launches. Required when `AOA_ADAPTER_MANAGER_SANDBOX_PROVIDER=e2b`; setting the provider switch WITHOUT a template is a **refusal to boot**. |
| `AOA_ADAPTER_MANAGER_CONTROL_PLANE_PUBLIC_KEY_FILE` | (required to boot GATED) | Path to the mounted ed25519 control-plane **PUBLIC** key, PEM SPKI (`-----BEGIN PUBLIC KEY-----`). The bin loads it (`createPublicKey`) and asserts `ed25519`. Unset/empty, missing, unreadable, unparseable, non-ed25519, or a PRIVATE-key PEM ⇒ **refusal to boot** — never an ungated server. |
| `AOA_ADAPTER_MANAGER_IDEMPOTENCY_LEDGER_DIR` | (server default: OS temp dir) | Directory the β1 durable idempotency ledger persists into. A real deployment points it at a configured out-of-tree volume (a shared volume across replicas is deploy-owed); when unset the server defaults to a fresh per-instance OS temp dir. |

`PORT` (a generic, non-`AOA_` var) selects the listen port; the staging compose pins it to
`8090` with a `:8090/healthz` check. Unset ⇒ an ephemeral port. The bin passes it straight
to `.listen(process.env.PORT)`.

### Adapter-manager sandbox reaper (DEP-011 Slice B/C, default-off)

The reaper reclaims orphan sandboxes: the adapter-manager PULLs the control-plane for a
read-only lease-truth verdict (which of the leases it holds sandboxes for are terminal /
superseded) and reclaims only the positive-confirmed orphans. It ships **INERT** — the
control-plane endpoint 404s and the AM loop does not run until the flags below are set (a
Slice-5 deploy concern; documented proactively). All four are read via `process.env[CONST]`
name indirection (never a `process.env.AOA_…` literal). The reaper's real transport auth
(mTLS / peer-allowlist on control-net) is DEPLOY-OWED (Slice 5); the double-gate keeps the
endpoint unreachable until then.

| Variable | Default | Description |
| --- | --- | --- |
| `AOA_ADAPTER_MANAGER_TRUTH_ROUTE_ENABLED` | unset (`false`) | **Control-plane (server) flag.** The independent second gate on the unauthenticated `POST /api/adapter-manager-control/lease-truth` lease-truth endpoint (DEP-011 B1). Deliberately **decoupled** from `AOA_DISTRIBUTED_EXECUTION_ENABLED`: both must be `1`/enabled for the route to respond (the route is mounted only inside the distributed block AND its pre-handler 404s unless this is `1`), so enabling distributed execution can never by itself expose the endpoint. Leave unset until Slice-5 mTLS is in place. |
| `AOA_ADAPTER_MANAGER_CONTROL_PLANE_URL` | unset (reaper off ⇒ ok; reaper on ⇒ **refuse**) | **Adapter-manager bin.** Base URL of the control-plane lease-truth endpoint the reaper PULLs over control-net. Required when the reaper is enabled — flag-on with this unset is a **refusal to boot** (never a silently-dead reaper). Ignored when the reaper is off. |
| `AOA_ADAPTER_MANAGER_TRUTH_SHARED_SECRET` | unset (inert) | **Adapter-manager bin AND control plane (DEP-012 Slice 4+5, P3).** The AM↔CP shared-secret bearer on the DEP-011 lease-truth hop (the B1-F1 deferral). The AM sends it as the `x-aoa-adapter-manager-truth` header on the truth POST; the control-plane route pre-handler is the THIRD gate arm and is **fail-closed** — an UNSET configured secret rejects (404), and a set secret is compared in constant time (SHA-256 + `timingSafeEqual`). Set the SAME value on both surfaces; injected (rotatable), never baked. Real client-cert mTLS on both hops is a filed hard production follow-up — staging uses **disposable** provider keys until then. Absent (or the truth route otherwise disabled) ⇒ the route 404s (inert). |
| `AOA_ADAPTER_MANAGER_REAPER_ENABLED` | unset (`false`) | **Adapter-manager bin.** Enables the periodic orphan-reaper sweep loop. Strict parse: enabled **iff** the trimmed value is exactly `1`; unset / `""` / `0` / `false` / anything else = off (a clean no-op). Off is the only inert state; on with a missing control-plane URL is a refusal. |
| `AOA_ADAPTER_MANAGER_REAPER_INTERVAL_MS` | (bin default `< 60000`) | **Adapter-manager bin.** Sweep cadence in milliseconds. Defaults below the E2B create-TTL (`DEFAULT_TTL_MS = 60000`) so a sweep reclaims before the interim TTL backstop. A non-positive / unparseable value falls back to the default. |

### Migration job & 0188 populated-cutover preflight (DEP-003, default-off)

These are read ONLY by the privileged migration job (`docker/control-plane/migrate-entrypoint.sh`), never at application startup. Application startup runs no migrations and can only READ the durable 0188 cutover marker — it can never write or synthesize it. The 0188 preflight is dormant unless the operator explicitly opts in; single-tenant deployments never trigger it.

| Variable | Default | Description |
| --- | --- | --- |
| `AOA_0188_CUTOVER_OPT_IN` | unset (`0`) | Explicit operator opt-in for the first populated single-tenant → `cloud_auth` migration-0188 cutover preflight. The preflight runs ONLY when this equals `1`. Missing/any-other value leaves the preflight dormant (no snapshot, no marker). |
| `AOA_0188_CANDIDATE_SHA` | unset | The exact candidate image source revision the cutover is validated against. Must EXACTLY equal the image's recorded revision (`AOA_DEPLOY_SHA`); any mismatch stops the preflight before any snapshot with no marker written. |
| `AOA_0188_ISOLATED_RESTORE_DATABASE_URL` | unset | Required when `AOA_0188_CUTOVER_OPT_IN=1`. PostgreSQL URL of an ISOLATED pre-cutover database the checksum-validated snapshot is restored into for restore-validation. Never the live source database. |
| `AOA_0188_SNAPSHOT_DIR` | `/aoa/cutover-snapshots` | Object-store directory (a mounted volume/bucket path) the cutover snapshot artifact is written to before checksum + restore validation. |

`AOA_RUNTIME_PROCESS_OWNER_ID` prevents one replica from interpreting another
machine's numeric PID as local. It does not turn the process-local runtime
maps, desired-state restart, or control APIs into a distributed scheduler.
Run at most one owner of `local_process` services for a shared deployment;
horizontal `cloud_auth` deployments are production-safe only with the
unsandboxed override disabled until the worker/gVisor runtime lands.

## Agent JWT (signing for `AOA_API_KEY`)

| Variable | Default | Description |
|----------|---------|-------------|
| `AOA_AGENT_JWT_SECRET` | (auto-generated, persisted in instance config) | HMAC secret for agent JWTs |
| `AOA_AGENT_JWT_ISSUER` | `paperclip` (wire-compat default) | JWT `iss` claim. Legacy default kept so existing agents validate |
| `AOA_AGENT_JWT_AUDIENCE` | `aoa` | JWT `aud` claim |
| `AOA_AGENT_JWT_TTL_SECONDS` | `300` | Token TTL — keep short; the heartbeat refreshes it on each run |
| `AOA_COMMANDER_JWT_TTL_SECONDS` | `600` (10 min) | TTL (seconds) for the per-turn Commander run-JWT (`kind:"commander"`) that authenticates a sandboxed Commander turn to the MCP broker on `cloud_auth`. Turn-scoped and minted fresh each turn, so it is short — but longer than the agent token's 300s to cover a full Commander turn. Signed with the SAME secret as agent run-JWTs (`AOA_AGENT_JWT_SECRET` / `BETTER_AUTH_SECRET`); the secret NEVER enters the sandbox — only the minted token crosses as `AOA_API_KEY`. Self-hosted Commander runs host-direct (no broker, no run-JWT) and ignores this. |

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `AOA_SECRETS_PROVIDER` | `local_encrypted` | Default secret-storage backend. `local_encrypted` and `aws_secrets_manager` are supported; `gcp_secret_manager` and `vault` are coming-soon stubs |
| `AOA_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw). Use the file path variant in production |
| `AOA_SECRETS_MASTER_KEY_FILE` | `~/.aoa/.../secrets/master.key` (with legacy `~/.paperclip/` fallback) | Path to key file. Auto-created by `pnpm aoa onboard` |
| `AOA_SECRETS_STRICT_MODE` | `false` | When `true`, sensitive env keys (`*_API_KEY`, `*_TOKEN`, `*_SECRET`) must use secret references instead of inline plain values |

## Storage

| Variable | Default | Description |
|----------|---------|-------------|
| `AOA_STORAGE_PROVIDER` | `local_disk` | `local_disk` or `s3` |
| `AOA_STORAGE_LOCAL_DIR` | `<AOA_HOME>/instances/<id>/data/storage` | Override local-disk storage root |
| `AOA_STORAGE_S3_BUCKET` | — | S3 bucket name (required when provider is `s3`) |
| `AOA_STORAGE_S3_REGION` | — | S3 region (e.g. `us-east-1`) |
| `AOA_STORAGE_S3_ENDPOINT` | (default AWS) | Override endpoint URL for MinIO, Cloudflare R2, Backblaze B2, etc. |
| `AOA_STORAGE_S3_PRESIGN_ENDPOINT` | (= `AOA_STORAGE_S3_ENDPOINT`) | Worker-facing **https** endpoint used only to mint presigned artifact upload/download grant URLs (distributed execution). Must be https and reachable by workers; distinct from the control-plane's internal endpoint. |
| `AOA_STORAGE_S3_PREFIX` | (empty) | Object-key prefix for namespace isolation in shared buckets |
| `AOA_STORAGE_S3_FORCE_PATH_STYLE` | `false` | Force path-style URLs (required for some S3-compatible services) |
| `AOA_COMPANY_WORKSPACE_DIR` | `<AOA_HOME>/instances/<id>/data/company-workspaces` | Server-owned base dir that `authenticated`-mode company workspace-fs browse/mkdir (WS0a) is jailed under, per-company subdir. Unused in `local_trusted` mode (founder browses their real home area, unjailed). |
| `AOA_FILE_MAX_BYTES` | `52428800` (50 MB) | Max upload size for assets/artifacts |
| `AOA_ATTACHMENT_MAX_BYTES` | (= `AOA_FILE_MAX_BYTES`) | Max upload size for issue attachments specifically |
| `AOA_ATTACHMENTS_PER_COMMENT_MAX` | `5` | Max number of attachments accepted on a single issue comment |
| `AOA_OFFICE_RENDER_MAX_BYTES` | `15728640` (15 MB) | Max input size for inline office (DOCX/XLSX) server-side rendering. Files above this return 413 from the `/render` routes and must be downloaded instead; deliberately below `AOA_FILE_MAX_BYTES` since a browser preview is small and mammoth/exceljs parse the whole file into memory |

## Database backups

| Variable | Default | Description |
|----------|---------|-------------|
| `AOA_DB_BACKUP_ENABLED` | `true` | Toggle automatic database backups |
| `AOA_DB_BACKUP_DIR` | `<AOA_HOME>/instances/<id>/data/backups` | Backup directory |
| `AOA_DB_BACKUP_INTERVAL_MINUTES` | `60` | Backup frequency in minutes |
| `AOA_DB_BACKUP_RETENTION_DAYS` | `30` | Keep backups this many days, then prune |
| `AOA_PG_DUMP_PATH` | `pg_dump` | Override the `pg_dump` executable used by backup export jobs |
| `AOA_PSQL_PATH` | `psql` | Override the `psql` executable used by backup restore/import jobs |

## Migrations / startup

| Variable | Default | Description |
|----------|---------|-------------|
| `AOA_MIGRATION_AUTO_APPLY` | `true` (embedded), `false` (external DB) | Apply pending Drizzle migrations automatically on boot |
| `AOA_MIGRATION_PROMPT` | `true` | Prompt before applying migrations to a non-empty DB. Set to `never` in CI/dev-runner |
| `AOA_EMBEDDED_POSTGRES_PORT` | (auto) | Override the embedded PostgreSQL port. Intended for isolated local/e2e instances that must avoid port collisions |
| `AOA_EMBEDDED_POSTGRES_STRICT_PORT` | `false` | When truthy, fail startup instead of falling back to a random embedded PostgreSQL port if `AOA_EMBEDDED_POSTGRES_PORT` is unavailable |
| `AOA_EMBEDDED_POSTGRES_VERBOSE` | `false` | Verbose logging from `embedded-postgres` (helpful for debugging boot issues) |
| `AOA_STEWARD_RECONCILE_ENABLED` | `true` | Set to `false` to disable only the boot/24-hour pass that adopts a legacy NULL-origin Steward into an already-installed marketplace crew. Ordinary crew repair and marketplace update checks continue. |

### Legacy Steward reconciliation backout

Disable `AOA_STEWARD_RECONCILE_ENABLED` before investigating or running a
backout so the next 24-hour pass cannot reapply the change.

`template_version = '0.0.0-legacy'` is shared by every pointer-only crew
adoption, so it is not a safe rollback selector by itself. Every successful
background reconciliation writes an `activity_log` row with action
`marketplace.legacy_steward_adopted` in the same transaction as the adoption.
The application log named `legacy Steward adopted in place` includes that
row's `auditId` for lookup, but the durable database row is the source of truth.

After taking a database backup, inspect the audit rows, choose the exact audit
IDs from the affected deployment window, and create a transaction-local target
table from only those IDs. Never select the whole fleet by version:

```sql
SELECT id AS audit_id, company_id, entity_id AS agent_id, details, created_at
FROM activity_log
WHERE action = 'marketplace.legacy_steward_adopted'
ORDER BY created_at DESC;

BEGIN;
CREATE TEMP TABLE steward_reconcile_backout_targets ON COMMIT DROP AS
SELECT
  company_id,
  entity_id::uuid AS agent_id,
  (details->>'teamId')::uuid AS team_id,
  COALESCE((details->>'memberInserted')::boolean, false) AS member_inserted,
  details->>'previousTemplateVersion' AS previous_template_version
FROM activity_log
WHERE action = 'marketplace.legacy_steward_adopted'
  AND id IN (
    '00000000-0000-0000-0000-000000000000'::uuid
  );

-- Preview every target and predicate before changing anything.
SELECT targets.*, steward.template_origin, steward.template_version
FROM steward_reconcile_backout_targets AS targets
JOIN agents AS steward
  ON steward.company_id = targets.company_id
 AND steward.id = targets.agent_id;

CREATE TEMP TABLE steward_reconcile_reverted_targets (
  company_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  team_id uuid NOT NULL,
  member_inserted boolean NOT NULL
) ON COMMIT DROP;

WITH reverted AS (
  UPDATE agents AS steward
  SET template_origin = NULL,
      template_version = targets.previous_template_version,
      updated_at = now()
  FROM steward_reconcile_backout_targets AS targets
  WHERE steward.company_id = targets.company_id
    AND steward.id = targets.agent_id
    AND steward.kind = 'aoa'
    AND steward.name = 'Steward'
    AND steward.template_origin = 'agent:aoa-curated/aoa-steward'
    AND steward.template_version = '0.0.0-legacy'
  RETURNING
    targets.company_id,
    targets.agent_id,
    targets.team_id,
    targets.member_inserted
)
INSERT INTO steward_reconcile_reverted_targets
SELECT * FROM reverted
RETURNING agent_id, company_id;

-- Abort the whole transaction instead of performing a partial backout if any
-- selected row no longer has the exact post-reconciliation pointer state.
DO $$
BEGIN
  IF (
    SELECT count(*) FROM steward_reconcile_reverted_targets
  ) <> (
    SELECT count(*) FROM steward_reconcile_backout_targets
  ) THEN
    RAISE EXCEPTION
      'Steward backout aborted: selected and reverted target counts differ';
  END IF;
END
$$;
```

If an audit row says `memberInserted=true`, the pass also created the exact
`team_members(teamId, agentId)` link in that transaction. Delete that link only
after confirming no later team operation now relies on it; a `false` value
means the link predated reconciliation and must be kept. The delete uses only
rows that the guarded pointer update above actually reverted, so a Steward that
has since advanced cannot be detached:

```sql
DELETE FROM team_members AS member
USING steward_reconcile_reverted_targets AS targets
WHERE targets.member_inserted
  AND member.team_id = targets.team_id
  AND member.agent_id = targets.agent_id
RETURNING member.id, member.team_id, member.agent_id;
```

The updater may already have created a Steward pending-update row and its open
Hub alert after reconciliation. Remove only the pending row tied to the audited
companies that were actually reverted and the legacy current version. Capture
its exact advertised version before deletion. Keep the matching Hub entry as
history, but archive the now-non-actionable open alert:

```sql
CREATE TEMP TABLE steward_reconcile_reverted_updates ON COMMIT DROP AS
SELECT
  pending.id,
  pending.company_id,
  pending.latest_version
FROM marketplace_pending_updates AS pending
JOIN steward_reconcile_reverted_targets AS targets
  ON targets.company_id = pending.company_id
WHERE pending.catalog_item_id = 'agent:aoa-curated/aoa-steward'
  AND pending.current_version = '0.0.0-legacy';

DELETE FROM marketplace_pending_updates AS pending
USING steward_reconcile_reverted_updates AS reverted
WHERE pending.id = reverted.id
RETURNING pending.id, pending.company_id;

UPDATE notifications AS hub
SET status = 'archived',
    archived_at = now()
FROM steward_reconcile_reverted_updates AS reverted
WHERE hub.company_id = reverted.company_id
  AND hub.status = 'open'
  AND hub.semantic_type = 'marketplace_op'
  AND hub.source_type = 'marketplace_update'
  AND (
    hub.source_id = 'update_available:Steward:' || reverted.latest_version
    OR left(
         hub.source_id,
         length('update_available:Steward:' || reverted.latest_version || ':')
       ) = 'update_available:Steward:' || reverted.latest_version || ':'
  )
RETURNING hub.id, hub.company_id, hub.source_id;

COMMIT;
```

Do not use the absence of a default-crew team as a damage or rollback selector.
A normal team uninstall intentionally deletes that team while retaining the
protected Steward agent, producing the same pointer state. Investigate any
suspected out-of-band stamp from its exact activity/install history; there is no
safe fleet-wide substitute for selecting the transactional audit IDs above.

Leave the switch disabled until every audited company and any inserted
membership link has been checked.

## Telemetry / feedback

| Variable | Default | Description |
|----------|---------|-------------|
| `AOA_FEEDBACK_ENDPOINT` | (unset) | URL where vote bundles + plugin telemetry are POSTed. When unset, falls back to local file in `~/.aoa/feedback-exports/` |
| `AOA_FEEDBACK_API_KEY` | (unset) | Optional Bearer token for the feedback endpoint |

## Plugins / dev

| Variable | Default | Description |
|----------|---------|-------------|
| `AOA_PLUGIN_DIR` | `<AOA_HOME>/plugins` | Plugin discovery directory |
| `AOA_MARKETPLACE_CDN_URL` | AoA marketplace CDN | Override the marketplace catalog URL. Developer/e2e harnesses can point this at an unreachable local URL to force the bundled catalog snapshot fallback |
| `AOA_MARKETPLACE_SKILLS_WRITE_ROOT` | `legacy` | Select the fixed root for new managed marketplace skill bundles: `legacy` writes under `<cwd>/.aoa/marketplace-skills`; `persistent` writes under the active AoA instance root. Both fixed roots remain protected and readable. Arbitrary paths are rejected. |
| `AOA_UI_DEV_MIDDLEWARE` | `false` | Set to `true` to mount the Vite UI as Express middleware (used by `pnpm dev`) |
| `AOA_VITE_HMR_PORT` | (Vite default) | Override the Vite hot-module-reload websocket port when the UI is mounted as Express middleware. Useful for parallel local/e2e AoA instances |
| `AOA_OPENCODE_COMMAND` | `opencode` | Override path to the `opencode` CLI binary for the OpenCode Local adapter |
| `AOA_WORKTREES_DIR` | `<AOA_HOME>/instances/<id>/workspaces` | Where the worktree provisioner places per-task git worktrees |
| `AOA_ENABLE_COMPANY_DELETION` | `true` (dev), `false` (prod) | Feature flag for the destructive "delete company" action |
| `AOA_PLUGIN_WORKER_PROCESS` | (unset) | Set to `1` ONLY inside a forked plugin worker child's own environment (`plugin-worker-manager.ts` `spawnProcess()`) — never set on, or inherited by, the host control-plane process. Read by `cloud-plugin-execution.ts` to recognize code running inside the isolated worker child rather than the control plane. Not operator-set. |

## Marketplace emergency controls

These are operator-controlled environment variables on the AoA server process.
They are not injected into agent processes. When changing them through a
deployment platform or container configuration, restart or redeploy the server
so the process receives the new environment.

| Variable | Default | Description |
|----------|---------|-------------|
| `AOA_MCP_CONNECTORS_ENABLED` | enabled | Emergency runtime kill switch for external MCP connectors. Unset/`true` keeps connectors enabled. Any other explicit value fails closed: the curated shelf is empty, catalog installation cannot resolve an entry, runtime delivery stops, and connector-tool auto-approval is denied. Existing rows remain visible to operators for recovery. |
| `AOA_MCP_CONNECTOR_DENYLIST` | (empty) | Comma-separated, lowercase connector `serverName` values to revoke without disabling every connector. Denied entries are hidden from the curated shelf, cannot be installed from it, are not delivered to runs, and do not receive connector-tool auto-approval. |

## Agent Runtime (injected into agent processes — not user-configurable)

The server sets these automatically when invoking adapters. They appear in the spawned agent's environment but are **not configured by operators**.

| Variable | Description |
|----------|-------------|
| `AOA_AGENT_ID` | Agent's unique ID |
| `AOA_COMPANY_ID` | Company ID for this run |
| `AOA_API_URL` | AoA API base URL the agent should call back to |
| `AOA_HUMAN_QUESTION_CAPABILITIES` | JSON-encoded provider capability contract for structured human questions. Set automatically for adapter runs; `ask_and_park` persists the question and resumes later, while live relay requires a provider that explicitly supports pausing and resuming the same invocation |
| `AOA_API_KEY` | Short-lived JWT for API auth (rotates each heartbeat) |
| `AOA_RUN_ID` | Current heartbeat run ID — also sent in `X-Aoa-Run-Id` HTTP header |
| `AOA_TASK_ID` | Issue (task) that triggered this wake, if any |
| `AOA_WAKE_REASON` | Wake trigger reason (`assignment`, `timer`, `mention`, etc.) |
| `AOA_WAKE_COMMENT_ID` | Comment that triggered this wake, if any |
| `AOA_APPROVAL_ID` | Resolved approval ID, when waking from an approval decision |
| `AOA_APPROVAL_STATUS` | Approval decision (`approved` / `rejected` / `revision_requested`) |
| `AOA_LINKED_ISSUE_IDS` | Comma-separated linked issue IDs for cross-task context |
| `AOA_WORKSPACE_CWD` | Working directory for the agent (when an execution workspace is provisioned) |
| `AOA_WORKSPACE_SOURCE` | How the workspace was provisioned (`task`, `agent_home`, `project_primary`, etc.) |
| `AOA_WORKSPACE_STRATEGY` | Workspace strategy: `isolated` / `shared` / `reuse_existing` |
| `AOA_WORKSPACE_ID` | Database ID of the execution workspace record |
| `AOA_WORKSPACE_REPO_URL` | Git remote URL when the workspace is git-backed |
| `AOA_WORKSPACE_REPO_REF` | Base ref (branch or tag) that was cloned |
| `AOA_WORKSPACE_BRANCH` | Git branch name when workspace is git-backed |
| `AOA_WORKSPACE_WORKTREE_PATH` | Filesystem path to the git worktree when applicable |
| `AGENT_HOME` | Agent's home directory (memory + life files live here) |
| `AOA_MCP_<CONNECTOR>_TOKEN` | Dynamic family (one per external MCP connector, name derived from the connector's `serverName`). Holds the resolved company secret for that connector and is injected into the spawned agent process env; the generated `--mcp-config` file references it only as a `${AOA_MCP_<CONNECTOR>_TOKEN}` placeholder, so the plaintext secret never lands on disk. Not operator-set. |

## Session impersonation (CLI / mcp)

| Variable | Description |
|----------|-------------|
| `AOA_SESSION_COMPANY_ID` | Override active company ID in the CLI / MCP session |
| `AOA_SESSION_USER_ID` | Override active user ID |
| `AOA_SESSION_USER_ROLE` | Override role (`founder`, `team_lead`, `team_member`) |
| `AOA_SESSION_ENABLED_CAPABILITIES` | Comma-separated list of `internal_agent_config.enabledCapabilities` consumed by the Commander MCP bridge to gate capability-bound tools (`discussion_processing`, `system_actions`, `memory_management`). Set automatically by the host process when spawning the bridge; set manually only when running the bridge subprocess directly. |

## Commander MCP bridge & internal tuning (injected / advanced)

Set automatically by the host process when spawning the Commander MCP bridge or
internal services — operators rarely set these directly.

| Variable | Description |
|----------|-------------|
| `AOA_ACTOR_TYPE` | Actor type the Commander MCP bridge runs as (`board` default, or `agent`) |
| `AOA_AGENT_KIND` | Agent kind passed into the MCP bridge for an agent-actor run |
| `AOA_COMMANDER_CONTEXT_SCOPE` | JSON-encoded context scope handed to the Commander MCP bridge |
| `AOA_DISCUSSION_RUN_MODE` | Discussion run mode for a bridge-driven discussion/thread run |
| `AOA_EFFECTIVE_AUTONOMY` | Effective autonomy level injected into the bridge run |
| `AOA_THREAD_FRESHNESS` | Thread freshness window used when resolving thread context |
| `AOA_TOOL_ALLOWLIST` | Comma-separated allowlist of tool names exposed to the bridge run |
| `AOA_KEEP_MCP_CONFIG` | When `1`, retains the generated MCP config file after a run (debugging) |
| `AOA_LOG_STDOUT` | When `0`, suppresses stdout log output (otherwise logs go to stdout) |
| `AOA_THREAD_EVENT_DEBOUNCE_MS` | Debounce window (ms) for thread live-event → Commander wakeups |
| `AOA_SCRIBE_AUTONOMOUS_DRAIN_ENABLED` | Feature flag for the Scribe autonomous-drain dispatcher path |

## LLM Provider Keys (for adapters)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (Claude Local adapter) |
| `OPENAI_API_KEY` | OpenAI API key (Codex Local + OpenCode Local adapters) |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Google AI Studio key (Gemini Local adapter) |
| `CURSOR_API_KEY` | Cursor API key (Cursor adapter) |

## Test harness (developer-only)

These are read by tests and dev scripts; you should not need to set them in production.

| Variable | Description |
|----------|-------------|
| `AOA_TEST_ARGS_PATH` | Path where test harnesses dump captured argv |
| `AOA_TEST_CAPTURE_PATH` | Path where test harnesses dump captured stdin/env |
| `AOA_CONTEXT` | CLI context-file override |
| `AOA_E2E_FAKE_AWS_SECRETS_MANAGER` | Playwright/vitest harness flag for the fake AWS Secrets Manager provider |
| `AOA_E2E_PORT` / `AOA_E2E_SKIP_LLM` / `AOA_E2E_SKIP_MCP` | Playwright e2e harness — see `tests/README.md` |
| `AOA_RUN_WIN_INTEGRATION` | Opt-in flag for real embedded-Postgres integration tests on Windows. Unset ⇒ Windows skips those tests |
| `AOA_WRK011_CAPTURE` | Opt-in flag (`=1`) that lets the WRK-011 `worker-hello-refresh.integration.test.ts` suite CAPTURE the real `LeaseOfferV1` it produces into `tests/fixtures/worker-provisioned-target.json` (read back by the daemon self-check `hello-provisioning.test.ts`). Unset ⇒ the suite only asserts the offer, never writes the committed fixture. Developer-only — never read by the server |
| `AOA_RUN_E3_PERF_01` | Opt-in flag (`=1`) that runs the JOB-003 `E3-PERF-01` million-row lease-certificate performance campaign (`scripts/run-e3-perf-01.mjs` / the guarded load contract). Unset ⇒ the campaign-gated suites skip. Developer/CI only |
| `AOA_RUN_BROWSER_TESTS` | Opt-in flag (`=1`) that runs the BRW-002 real-Chromium containment and teardown suites (`packages/browser-runtime/src/__tests__/*.browser.test.ts`). Unset ⇒ those suites skip, because they launch an actual browser and need Playwright's Chromium plus, on Linux, unprivileged user namespaces for the OS sandbox. Set by the `browser` job in `.github/workflows/pr.yml`. Developer/CI only — never read by the server |
| `AOA_STRIP_CC_ENV` | Dev/sandbox opt-in (`=1`). At server startup (`server/src/index.ts`) strips inherited `CLAUDE_CODE_*` / staging-OAuth / `ANTHROPIC_BASE_URL` vars so spawned CLIs (Commander, extraction, crew/org runs, the auth probe) fall back to the machine's own `claude` login instead of a host Claude Code session's endpoint. No-op in a normal terminal (vars absent); never needed in production |
| `AOA_E2E_FAKE_CREW_LLM` | Playwright e2e harness flag (`=1`) that swaps the real crew CLI for the deterministic fake-crew harness (`fake-crew-llm.ts`). Never activates when `NODE_ENV=production`. |
| `AOA_E2E_FAKE_CREW_CONTROL` | E2E only. Path to a JSON control file that scripts the fake-crew harness per test (e.g. the controller-mode Adjutant scope turn). Read fresh on every fake turn; absent/invalid ⇒ legacy fake behavior. Set by `tests/e2e/playwright.config.ts`. No effect unless `AOA_E2E_FAKE_CREW_LLM=1`. |
| `AOA_E2E_CONNECTOR_CATALOG_PATH` | E2E only. Absolute path to a local `connectors.json` served instead of fetching the connector-shelf CDN, so `connector-install.spec.ts` has a deterministic shelf to browse and install from. A FILE path, never a URL — it cannot point a deployment's shelf at an arbitrary host. Ignored when `NODE_ENV=production`. Set by `tests/e2e/playwright.config.ts`. |
| `AOA_ACCEPTANCE_CLI` | Selects the real CLI binary in acceptance/integration tests |
| `AOA_PI_COMMAND` | Overrides the `pi` adapter binary in adapter-model tests |
| `AOA_TEST_CODEX_MODEL` | Codex model override for live crew e2e tests |
| `AOA_CODEX_APPSERVER_LIVE` | Enables the guarded live `codex app-server` approval-loop harness (`appserver-spike.test.ts`); unset ⇒ that test skips. W5c |
| `AOA_E2E_RUNTIME_DECISION_BRIDGE_CODEX` | Opt-in flag for the guarded codex_local runtime-decision-bridge e2e (`runtime-decision-bridge-codex.spec.ts`); unset ⇒ skipped. W5c |
| `AOA_TEST_COMPANY_ID` / `AOA_TEST_THREAD_ID` | Seed IDs for the bridge stdout-purity test |
| `AOA_TEST_DATABASE_URL` | Postgres URL for tests that need a real DB connection |
| `AOA_TEST_SECRET_PROBE` | Test-only probe var set by `mcp-connectors-env.test.ts` to assert `buildConnectorProcessEnv` scrubs AoA/infra secrets out of the env handed to external MCP connectors. Never read in production. |
| `AOA_API_BASE` | API base URL used by the Commander review seed script; defaults to `http://127.0.0.1:3100/api` |
