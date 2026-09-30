# JOB-013 — Preserve transactional activity audit — result

**Result:** `pass`
**Revision:** authored on `docs/replatform-program` (after JOB-012)
**Date (UTC):** `2026-08-14`
**Acceptance:** `pnpm --filter @armyofagents/db build && pnpm -r build` (clean, EXIT 0, all packages incl. db/shared/server/ui/cli). `AOA_RUN_WIN_INTEGRATION=1 pnpm --filter @armyofagents/db exec vitest run src/__tests__/job-events-schema.integration.test.ts src/__tests__/job-control-schema.integration.test.ts src/__tests__/migration-idempotency.test.ts` = **22 passed** (3 files — the schema-sibling lesson: the widened projection-kind CHECK did NOT break the exact-column-list assertions, and 0244/0245 replay idempotently). `AOA_RUN_WIN_INTEGRATION=1 pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-audit-parity.integration.test.ts` = **13 passed**. `pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-control-legacy-grants.contract.test.ts src/__tests__/job-fence-surface.contract.test.ts` = **15 passed** (**7** legacy-grants KEYSTONE UNCHANGED + **8** fence-surface). `tsc --noEmit` green for both `@armyofagents/server` and `@armyofagents/db`. Regression: `server/src/__tests__/mcp-connector-oauth-route.test.ts` (24) GREEN — the additive `PreparedActivityEvent.id` did not disturb the broker activity callers. There is no dedicated activity-log unit suite in the repository, so that file IS the coverage for those callers; the original phrasing named a nonexistent filename to say so, and a later evidence pass read the token as a citation. Re-verified 2026-08-22: still 24 passed, and no such file has ever existed in git history. On Windows the `.integration` files run under `AOA_RUN_WIN_INTEGRATION=1`; **Linux CI is the formal green authority** (DEC-03).

## Outcome

`job-audit-bridge` makes one ACCEPTED state/control/accounting mutation on a DISTRIBUTED attempt write the EXISTING `activity_log` (+ an OPTIONAL `hub_audit`, only when the mutation is a hub-item lifecycle action) AND a JOB-005 `activity_audit` projection RECEIPT **IN ONE tenant transaction**, and PUBLISH the live `activity.logged` event **ONLY AFTER** that transaction commits. It invents no new audit store (it rides the EXISTING activity contract), never treats a worker observation as a product action, and never publishes before commit. A replay returns the already-linked activity WITHOUT re-inserting; a stale/rejected fence writes nothing; a mid-tx failure rolls back and publishes nothing. **Flag-off leaves every current activity path byte-unchanged** — every entrypoint throws `JobAuditBridgeDisabledError` before any effect; the rollback gate throws `JobAuditBridgeRollbackPendingError` while an `activity_audit` receipt is still pending, so disabling can never lose or skip an accepted mutation's audit.

The bridge is a near-exact clone of JOB-012's `job-budget-cost-bridge` factory: same flag gate, same `resolveAdmissibleOrganization` admission, the same single-`runInTenant` shape with `lockActiveFence` FIRST → receipt fast-path → mutation → receipt `applied`, the same JOB-011 caller-owned `afterCommit` publish drain, and the same not-flag-gated `assertRollbackSafe`. The "charge" step is swapped for the EXISTING `insertActivity` and the receipt is keyed on `activity_audit`.

## The `runId: null` FK note (hazard — the load-bearing correctness pin)

`activity_log.run_id` is a FK to `heartbeat_runs.id` (`activity_log.ts:17`). A distributed attemptId is **NOT** a `heartbeat_runs` row, so writing it as `run_id` would violate that FK and roll back the whole tenant tx. The bridge therefore **forces `runId: null`** on the activity insert (`insertActivity(tx, { ...input.activity, runId: null })`) — the caller's `activity.runId` is deliberately ignored. Job/attempt provenance rides the **receipt's** composite tenant FK (`organization_id, company_id, job_id, attempt_id` → `job_attempts`), never `activity_log`; a caller that wants the ids in the trail puts them in `activity.details`/`entityId`. Test #1 passes a bogus `runId` and asserts the persisted `run_id IS NULL` (proving the force; had the bridge threaded it through, the FK would have failed the test loudly).

## Receipt-before-insert proof (exactly-once)

`insertActivityLog` has NO native dedup, so the JOB-005 receipt identity is the sole replay guard. `recordAcceptedActivity` runs ONE `runInTenant` tx that: (a) `lockActiveFence(fence)` FOR UPDATE (writes nothing) so two concurrent same-event calls serialize — the 2nd blocks until the 1st commits its receipt, then observes it and replays; (b) reads the `activity_audit` receipt by `source_identity = activity:{company}:{eventId}` — a hit returns `status:"replayed"` with the already-linked `activityId` **WITHOUT** a second insert (and without touching `hub_audit`); (c) `insertActivity` (runId forced null); (d) the OPTIONAL `hub_audit` insert; (e) `recordGovernedProjection` writes the `activity_audit` receipt `applied` in the SAME tx, `targetAggregateId` = the activity_log row id (`aggregate_kind='activity_log'`); (f) pushes `publishActivity(prepared)` onto the caller-owned `afterCommit`, drained ONLY after `runInTenant` returns. Proven by `[replay]` (2 calls same eventId → recorded then replayed, same activityId; 1 activity_log, 1 receipt, 1 hub_audit) and `[distinct events]` (2 events → 2 activity rows; replaying the first adds none).

## Worker-observation ≠ accepted-action (structural invariant)

The bridge reads **NO field of any worker payload** — it persists only the caller-supplied `input.activity`, and never calls the inline insert+publish helper (`logActivity`/`publishActivityLogged`) nor the guarded worker-event accept path. A worker OBSERVATION (poll→ack lease lifecycle) alone therefore mints ZERO product audit; only a server-accepted mutation calling this bridge does. Enforced two ways: `[worker observation ≠ accepted action]` (an `activateLease` poll→ack with no bridge call → 0 activity, 0 receipts; a single bridge call then flips both to 1) and the static `[publication-before-commit denial]` (bridge source matches `afterCommit.push(`, the SOLE `publishActivity(` call is inside an `afterCommit.push` closure, and the source matches none of `logActivity` / `publishActivityLogged` / `acceptEvent` / `usagePayload|inputTokens|outputTokens|.units`).

## Publish-after-commit proof

`publishActivity(prepared)` is pushed inside the tx callback but **drained outside** it (`for (const publish of afterCommit) { try { publish(); } catch {} }`), so a pre-commit throw exits `runInTenant` before the drain → a rollback publishes nothing. `[rollback publishes nothing]` weaponizes a bogus `agentId` (FK to `agents`) to force a mid-tx FK violation AFTER `lockActiveFence`/fast-path → the call rejects, 0 activity, 0 receipts, and the live-event subscriber received **0** `activity.logged`. `[publish after commit]` proves the committed happy path fires **exactly one** `activity.logged` post-commit.

## Failure matrix (`server/src/__tests__/job-audit-parity.integration.test.ts`, 13 cases)

| # | case | assertion |
|---|---|---|
| 1 | accepted — records once | `recorded`; 1 activity_log, 1 `activity_audit` receipt `applied`; receipt `target_aggregate_id` = activityId, `aggregate_kind='activity_log'`; persisted `run_id IS NULL` (forced), `agent_id` threaded |
| 2 | per-source | each accepted source (`task_run`/`crew_run`/`commander_turn`) writes exactly 1 activity + 1 receipt (3 + 3) |
| 3 | approval + budget action | both persist activity_log; the hub-lifecycle one writes 1 `hub_audit` row keyed `activity_audit:{eventId}` |
| 4 | replay | 2 calls same eventId → recorded then replayed (same activityId); 1 activity_log, 1 receipt, 1 hub_audit |
| 5 | distinct events | 2 events → 2 activity rows; replaying the first adds none |
| 6 | stale fence | mutated fence token → `JobFenceError`; **0** activity, **0** receipts |
| 7 | worker observation ≠ accepted action | poll→ack alone → 0 activity, 0 receipts; a single bridge call → 1 + 1 |
| 8 | rollback publishes nothing | bogus `agentId` FK violation mid-tx → rejects; 0 activity, 0 receipts, **0** published events |
| 9 | publish after commit | committed happy path → 1 activity_log AND exactly **1** `activity.logged` post-commit |
| 10 | publication-before-commit denial (static) | publish only inside `afterCommit.push`; no `logActivity`/`acceptEvent`/worker-payload read |
| 11 | rollback gate | a PENDING `activity_audit` receipt → `assertRollbackSafe` throws; `applied` → passes; no activity touched |
| 12 | flag off | `isEnabled()=false`; `recordAcceptedActivity` throws `…DisabledError`; 0 activity, 0 receipts |
| 13 | tenant + actor attribution | persisted `actor_type/actor_id/action/entity_type/entity_id` = supplied; receipt `organization_id=ORG`, `company_id`, `job_id/attempt_id` = fence |

## Keystone note — POLICY_COUNTS / grants UNCHANGED (contract green)

The `aoa_app` legacy allowlist ALREADY covers the whole transactional-audit path: `activity_log` SELECT+INSERT (`insertActivity` uses RETURNING — SELECT present), `hub_audit` INSERT-only, `job_projection_receipts` all (new-path grant). JOB-013 adds **NO** grant and **NO** RLS/policy: `0244` widens only the `job_projection_receipts` projection-kind CHECK (superset — no row invalidated; no columns/indexes); `0245` RE-AFFIRMS the single existing `job_projection_receipts_tenant_isolation` policy (drop-before-create, **ZERO** new `CREATE POLICY`) — `activity_log` and `hub_audit` are CAV-005 legacy non-forced tables and are deliberately untouched. `job-control-legacy-grants.contract.test.ts` (the exact RLS / FORCE / POLICY_COUNTS certificate) and `job-fence-surface.contract.test.ts` (closed governed-mutator surface — no new tenant-repo method; the bridge reuses `lockActiveFence`/`recordGovernedProjection`) both stay green.

## Deviations from the plan (source-forced, both fail-closed)

1. **hub_audit insert uses NO `ON CONFLICT`** (plan §1(d)/hazard #5 spec'd `onConflictDoNothing` on the partial unique). Postgres requires **SELECT** privilege on the columns in a conflict-target's index predicate, but `aoa_app` is **INSERT-only** on `hub_audit` — so `ON CONFLICT (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL` is denied (`42501`). The bridge does a **plain insert** (matching the existing `hub-items.ts recordLifecycleAction`, which also writes hub_audit without ON CONFLICT). Idempotency is unaffected: a replay short-circuits at the receipt fast-path (b) BEFORE reaching the hub insert, and `lockActiveFence` (a) serializes same-fence callers. The `(company_id, idempotency_key)` partial unique remains a **fail-closed DB backstop** (a true duplicate key → `23505` → whole-tx rollback). `aoa_app` also cannot read hub_audit back, so the outcome's `hubAuditId` is generated client-side (not via RETURNING).
2. **Test #8 forces the rollback via a bogus `agentId`, not a bogus `runId`.** The plan's matrix #8 said "pass a bad runId", but hazard #1 (and plan §1) require the bridge to FORCE `runId: null` — which makes a passed-through runId un-injectable. Honoring the production-safety pin, test #8 injects the equivalent mid-tx FK violation through `activity_log.agent_id → agents` (also FK-constrained), proving the same "rollback publishes nothing" property.

## Independent check

A 2-lane adversarial Workflow (idempotency/FK/hub_audit-deviation + after-commit-publish/worker-observation-invariant/keystone) returned **0 confirmed defects** — both deviations above were scrutinized and found sound (the hub_audit replay short-circuits at the receipt fast-path behind `lockActiveFence`, so the missing `ON CONFLICT` never fires on a legitimate replay; test #8's `agentId` FK substitution proves the identical rollback-publishes-nothing property). This is the 4th bridge in the JOB-010/011/012 family, cloned from the JOB-012 template with the accumulated idempotency lessons baked in. Gates re-verified independently: parity 13, keystone 15, schema siblings 22, `artifact-lifecycle-schema-contract` 3.

## Non-goals (honored)

No new audit store (rides the EXISTING `activity_log` + `hub_audit` contract; the `activity_audit` receipt only LINKS the row). No treating worker observations as product actions (the bridge reads no worker payload; the guarded worker-event accept path is untouched). No publishing before commit (the sole `publishActivity` runs only in the post-`runInTenant` drain). No mandatory hub_audit (it is OPTIONAL, driven only when the accepted mutation is a hub lifecycle action; no separate receipt kind for it — the single `activity_audit` receipt links the activity_log row). The self-hosted/legacy activity callers keep their unchanged behavior (`logActivity` inline insert+publish; the additive `PersistedActivity.id`/`PreparedActivityEvent.id` field is ignored by existing consumers).

## Files created / modified

**Created**
- `server/src/services/job-audit-bridge.ts` — the parity bridge: `recordAcceptedActivity` (fence-lock → receipt fast-path → activity insert with runId forced null → optional hub_audit → `activity_audit` receipt `applied` → after-commit publish), `assertRollbackSafe`, flag gate + `JobAuditBridgeDisabledError`/`JobAuditBridgeRollbackPendingError`, `BridgeActor` + typed input/outcome.
- `server/src/__tests__/job-audit-parity.integration.test.ts` — the 13-case failure matrix (embedded PG, `AOA_RUN_WIN_INTEGRATION`-gated).
- `packages/db/src/migrations/0244_abnormal_war_machine.sql` — C14-idempotent CHECK-only widen (`DROP CONSTRAINT IF EXISTS` + drop-before-add) adding `activity_audit` to the projection-kind CHECK. (+ `meta/0244_snapshot.json`, journal idx 244 — drizzle-generated.)
- `packages/db/src/migrations/0245_job_activity_audit_rls.sql` — hand-authored Decision #122 RLS RE-AFFIRM on `job_projection_receipts` ONLY (REVOKE/GRANT + ENABLE/FORCE + drop-before-create of the one existing tenant-isolation policy; ZERO new CREATE POLICY). (+ journal idx 245.)

**Modified**
- `server/src/services/activity-log.ts` — the ONE narrow change: `insertActivityLog` now `.returning({ id })` and threads `id` through `PersistedActivity` + `PreparedActivityEvent` + `insertActivity` (the bridge needs the inserted id for `recordGovernedProjection.targetAggregateId`). Additive/back-compatible; `logActivity` (legacy inline insert+publish) untouched.
- `packages/db/src/repositories/tenant/job-control.ts` — widened `GovernedProjectionKind` union with `"activity_audit"` (re-exported from the db barrel).
- `packages/db/src/schema/job_projection_receipts.ts` — widened the `job_projection_receipts_projection_kind_check` IN-list with `'activity_audit'`.
- `packages/db/src/migrations/meta/_journal.json` — appended the 0245 journal entry (0244 was added by drizzle generate).
