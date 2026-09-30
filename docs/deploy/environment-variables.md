---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that AoA reads. Grouped by concern. The list reflects `process.env` reads in `server/src/`, `cli/src/`, and `packages/`.

Use the `AOA_*` names shown below.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port (alias: `AOA_LISTEN_PORT`, `AOA_SERVER_PORT`) |
| `HOST` | `127.0.0.1` | Server host binding (alias: `AOA_LISTEN_HOST`, `AOA_SERVER_HOST`) |
| `DATABASE_URL` | (embedded) | PostgreSQL connection string. If unset, AoA boots `embedded-postgres@18.x` automatically |
| `AOA_HOME` | `~/.aoa` | Base directory for all AoA data. Resolved by `cli/src/config/home.ts`: uses `~/.aoa/` |
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
| `AOA_ALLOW_UNSANDBOXED_MULTITENANT` | unset (local execution refused) | **Multi-tenant safety gate (D1).** When tenant isolation is enforced (`cloud_auth`), agent/crew/Commander processes, local Docker targets (including a claimed `runtime: "runsc"`), adapter probes, workspace provision/cleanup/jobs, and local runtime-service commands are REFUSED on the control-plane host unless this is set to `1`/`true`/`yes`. Real per-tenant execution isolation is deferred; a runtime string is not worker-plane provenance. New workspace-command configuration is also rejected without this override, while sink checks protect legacy persisted configuration. When set, the process logs one loud process-wide SECURITY warning. Self-hosted deployments (`local_trusted` and `authenticated` single-tenant) ignore this. Do not use the override in production multi-tenant deployments. |

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
| `AOA_AGENT_JWT_ISSUER` | `aoa` (wire-compat default) | JWT `iss` claim. Legacy default kept so existing agents validate |
| `AOA_AGENT_JWT_AUDIENCE` | `aoa` | JWT `aud` claim |
| `AOA_AGENT_JWT_TTL_SECONDS` | `300` | Token TTL — keep short; the heartbeat refreshes it on each run |
| `AOA_COMMANDER_JWT_TTL_SECONDS` | `600` (10 min) | TTL (seconds) for the per-turn Commander run-JWT (`kind:"commander"`) that authenticates a sandboxed Commander turn to the MCP broker on `cloud_auth`. Turn-scoped and minted fresh each turn, so it is short — but longer than the agent token's 300s to cover a full Commander turn. Signed with the SAME secret as agent run-JWTs (`AOA_AGENT_JWT_SECRET` / `BETTER_AUTH_SECRET`); the secret NEVER enters the sandbox — only the minted token crosses as `AOA_API_KEY`. Self-hosted Commander runs host-direct (no broker, no run-JWT) and ignores this. |

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `AOA_SECRETS_PROVIDER` | `local_encrypted` | Default secret-storage backend. `local_encrypted` and `aws_secrets_manager` are supported; `gcp_secret_manager` and `vault` are coming-soon stubs |
| `AOA_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw). Use the file path variant in production |
| `AOA_SECRETS_MASTER_KEY_FILE` | `~/.aoa/.../secrets/master.key` | Path to key file. Auto-created by `pnpm aoa onboard` |
| `AOA_SECRETS_STRICT_MODE` | `false` | When `true`, sensitive env keys (`*_API_KEY`, `*_TOKEN`, `*_SECRET`) must use secret references instead of inline plain values |

## Storage

| Variable | Default | Description |
|----------|---------|-------------|
| `AOA_STORAGE_PROVIDER` | `local_disk` | `local_disk` or `s3` |
| `AOA_STORAGE_LOCAL_DIR` | `<AOA_HOME>/instances/<id>/data/storage` | Override local-disk storage root |
| `AOA_STORAGE_S3_BUCKET` | — | S3 bucket name (required when provider is `s3`) |
| `AOA_STORAGE_S3_REGION` | — | S3 region (e.g. `us-east-1`) |
| `AOA_STORAGE_S3_ENDPOINT` | (default AWS) | Override endpoint URL for MinIO, Cloudflare R2, Backblaze B2, etc. |
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
| `AOA_RUN_ID` | Current heartbeat run ID — also sent in `X-AoA-Run-Id` HTTP header |
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
| `AOA_FORCE_EMBEDDED_TESTS` | Opts specific embedded PostgreSQL migration tests into running on Windows. Use only in a test environment. |
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
