# DEP-003 Result — Migration job + readiness contract + fail-closed 0188 cutover preflight

**Status:** `complete` (logic + embedded-PG verified; live migrate-job container = CI-deferred)
**Disposition:** `pass` (fail-closed preflight, marker RLS, readiness gate, and migrate job locally + embedded-PG verified; the live container build/compose-up is Docker/CI-only, billing-blocked)
**Date opened (UTC):** `2026-08-13`
**Epic:** `E6-deployment-test-harness` (partial: `E6-D1-FOUNDATION`)
**Plan task:** `DEP-003 — Migration job + readiness contract + 0188 preflight (E6 §2.4)`
**Implementer:** `Claude subagent (opus) — worktree C:\e3`
**Reviewer:** `Claude adversarial-review Workflow (4 dimensions → dedup → refute-by-default verify; 6 agents) + fix-round verification`
**Start SHA:** `3eacdb59a` (DEP-002 commit)

## Acceptance model + CI caveat

Adversarial-review Workflow = the independent check; **2 confirmed findings (0 blocking, 2
should-fix)**, both fixed. The two security-critical dimensions — the **fail-closed preflight
state machine** and the **operator-only marker RLS** — came back **clean**. The state machine,
marker RLS, readiness gate, and migrate job are Windows/embedded-PG verified; only the live
migrate-job **container** build + compose bring-up is Docker/CI-only (billing-blocked).

## Scope

- **Marker table (Drizzle + C14):** `packages/db/src/schema/distributed_cutover_markers.ts` +
  generated migration `0232` + custom RLS migration `0233` (mirrors `0218_job_control_submission_rls`):
  slug `distributed_cutover_marker`, **`aoa_operator` WRITE, `aoa_app` READ-ONLY (visible only
  outside a tenant tx), tenants NONE**, FORCE RLS, every statement idempotent. `db:generate` reports
  no drift.
- **Migration job:** `packages/db/src/migrate-job.ts` (privileged, idempotent, non-destructive,
  bounded `maxAttempts=3`, fail-closed exit) invoked by `docker/control-plane/migrate-entrypoint.sh`
  (schema migrate THEN the 0188 preflight, `set -eu` fail-closed). App startup runs NO migrations.
- **Fail-closed 0188 preflight:** `cutover-0188-preflight-state.ts` (PURE deterministic transition)
  + `cutover-0188-preflight.ts` (orchestrator, injected deps). A marker is written ONLY after
  opt-in AND `candidateSha==imageSha` (empty/blank ≠ match) AND snapshot AND checksum AND
  restore-validation all pass; verified by read-back; idempotent-repeat = no-op. Any failure ⇒ stop,
  no marker. App startup READS the marker via a read-only gate, never writes/synthesizes it.
- **Readiness split + gate:** `/api/health` (liveness) + `/api/ready`
  (`{live, ready, schemaCompatible, dependencies}`, schema-compat via
  `loadAppliedMigrationIdentity` vs `loadRequiredMigrationIdentity`) + a readiness-gate middleware
  that 503s tenant/app routes until ready (not a crash), wired at the composition root with
  `gateEnabled = distributedExecutionEnabled` (dormant in single-binary/flag-off mode).

## Independent adversarial review + fix round (2 confirmed, both fixed; security core clean)

- **SHOULD-FIX — the readiness gate did not cover pre-`api` routes.** It was mounted inside the
  `/api` Router, but ~13 DB-backed routers (onboarding, provider-credentials incl. tenant-scoped
  `/companies/:id/...`, commander, llms) mount on `app` before it, so they bypassed the 503 gate
  when active. **Fixed:** the gate now mounts on `app` before the first `/api` DB route (keeping
  the `/health`/`/health/live`/`/ready` bypass). New test: RED was a 401 bypass on
  `/api/companies/:id/provider-credentials` → GREEN 503 while not-ready.
- **SHOULD-FIX — the tested gate + migrate command were wired into no live path.** `index.ts` never
  passed `readiness`; the compose `migrate` service was an `exit 0` placeholder; the Dockerfile
  never copied `migrate-entrypoint.sh`. The plan attributes all three to DEP-003. **Fixed:**
  `index.ts` builds the readiness probe + passes `gateEnabled: distributedExecutionEnabled`
  (single-binary startup unchanged — dormant); `docker-compose.d1.yml` runs
  `migrate-entrypoint.sh`; the Dockerfile COPYs it. (minio dependency-check left a clear TODO — the
  StorageService exposes no ping — rather than faked.)

## Operator-directed Windows-local evidence (from `C:\e3`; live migrate-job container = Docker/CI, billing-blocked)

| Lane | Result |
|---|---|
| pure `cutover-0188-preflight` + `readiness-liveness` + `readiness-gate-pre-api-coverage` | PASS — **41/41** |
| embedded-PG `distributed-cutover-marker-schema.integration` (marker RLS: operator-write, app read-only [`permission denied`], tenant-invisible) | PASS — 6/6 |
| embedded-PG `migration-readiness.integration` + `migration-rollback-startup.integration` (behind→503; newer/incompatible→refuse; startup writes no marker) | PASS — 6/6 |
| embedded-PG `migration-idempotency` (0232+0233 replay-idempotent, policies/FORCE survive) | PASS — 6/6 |
| route-ordering regression (`distributed-execution-exclusions`, `app-board-mutation-guard-order`) | PASS — 6/6 (gate move broke nothing) |
| `@armyofagents/server` + `@armyofagents/db` tsc; `db:generate` | PASS — clean; **no drift** |
| `node scripts/check-d1-compose.mjs` + corpus | PASS — 29/29 (migrate command change keeps the validator green) |
| `check:frozen-worker-protocol-v1` + `--frozen-lockfile` | PASS + no-op (zero new deps) |
| **DEFERRED to CI** — live migrate-job container build + `docker compose up` | not run (Docker/CI, billing-blocked) — honestly deferred |

## Decision

DEP-003 is `complete`/`pass` for its locally + embedded-PG-verifiable surface: the fail-closed
operator-gated 0188 preflight, the operator-only marker RLS, the migration job (idempotent/bounded/
non-destructive/fail-closed), and the readiness gate (now covering all `/api` routes, wired at the
composition root, dormant in single-binary mode). Only the live migrate-job container is DEFERRED
(Docker/CI). Next: **DEP-004** (CI lane routing) → then the **E6-D1-FOUNDATION gate assembly**.
