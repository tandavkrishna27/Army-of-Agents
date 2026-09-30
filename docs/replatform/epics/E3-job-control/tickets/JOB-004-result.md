# JOB-004 — Renew leases and enforce fencing — result

**Result:** `pass`
**Revision:** authored on `docs/replatform-program` (tip after the E6-D1-FOUNDATION gate close `d569ed84a`)
**Date (UTC):** `2026-08-14`
**Acceptance:** `pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-fencing.integration.test.ts src/__tests__/job-fence-surface.contract.test.ts` — **15/15 pass** (contract 8/8 + integration 7/7), re-verified by the controller on Windows embedded-PG (`AOA_RUN_WIN_INTEGRATION=1`). `tsc --noEmit` green (db + server). Regression green: job-leasing-contract (20), job-leasing.integration (39), job-leasing-operator-loss (2), worker-operation-receipts-schema (6), job-control-schema (5).

## Outcome

Only the active lease renews, and the ONE shared active-fence guard protects every governed surface.

## Deliverables

- **`packages/db/src/repositories/tenant/job-fence.ts`** — the common active-fence predicate
  (`isActiveFence` = lease `active` + fresh-clock expiry + non-terminal attempt), `classifyFence`
  (`attempt_terminal`/`stale_fence`), the closed `GUARDED_JOB_MUTATORS` list (7), `TERMINAL_ATTEMPT_STATUSES`,
  and typed `JobFenceError`. Lives in `packages/db` so repo + server share one non-drifting seam.
- **`server/src/services/job-fencing.ts`** — re-exports the predicate/surface + hosts
  `createJobLeaseRenewalService` (the renew service path).
- **`packages/db/src/repositories/tenant/job-control.ts`** — `guardActiveFence` (locks lease+attempt
  `FOR UPDATE` by the COMPLETE 13-field identity incl. `fence`+`targetGeneration`; evaluates
  `expires_at > clock_timestamp()` in the same locked read); `renewLease`; and the 7 guarded mutators,
  each gating on `guardActiveFence` BEFORE any `tx` access.
- **`server/src/routes/worker-control.ts`** — `/api/worker-control/leases/:leaseId/renew` route,
  mirroring `/ack`.
- Tests: `job-fence-surface.contract.test.ts` (static TS-AST fail-closed contract) +
  `job-fencing.integration.test.ts` (renew + stale-fence-cannot-mutate matrices).

## Key properties (verified)

- **Fence guard:** the 13-field `FOR UPDATE` locking read means any identity/fence mismatch returns no
  row → `stale_fence`; expiry is a FRESH database `clock_timestamp()` in the locked read, never txn-start.
- **Renew:** conditional `UPDATE … WHERE status='active' AND expires_at > clock_timestamp()` + full
  identity + fence → a lease expiring mid-transaction renews 0 rows → `stale_fence`; extends only
  `expiresAt` (no authority column). Same key+digest replays the stored receipt outcome without a second
  extend; changed digest → `malformed`; new key → fresh renewal; receipt insert + lease UPDATE are one
  atomic transaction.
- **Closed governed surface:** the static contract AST-scans the real repository and fails closed if the
  returned method set drifts (equals exactly allowlist ∪ guarded) OR any guarded mutator skips the guard
  OR the guard runs after a `tx` access. The 7 guarded mutators equal the spec's enumerated surface;
  every allowlisted method is pre-fence/leasing-creation/server-side/liveness (verified `touchWorkerLeaseProfile`
  is a `workers.lastSeenAt` heartbeat, not a governed data surface) — no fail-closed bypass.

## Independent check (adversarial-review-Workflow acceptance model)

Controller review + a 2-lane adversarial Workflow. Lane (renew idempotency + platform narrowing):
CLEAN (replay/malformed/fresh-key/atomic/expired→stale_fence all safe; platform-target renewal fails
CLOSED to `target_revoked`, no 500, org/owner renewals not wrongly denied, existing platform ack/poll
untouched). Fence-surface allowlist verified by the controller (no governed method mis-allowlisted).

## Key decision

Renew lives in `job-fencing.ts`, NOT `job-leasing.ts`: the JOB-003 `job-leasing-contract.test.ts` AST
scanner enforces each trusted authority helper (`ackAuthorityCurrent`, …) is called exactly once in
`job-leasing.ts`. Rather than weaken that scanner, `ackAuthorityCurrent` was exported and reused, keeping
`job-leasing.ts`'s scanned surface byte-identical and all JOB-003 invariants intact. Consequence:
renewal serves org/owner authority; a platform-scoped target has no physical heartbeat on this path and
fails CLOSED to `target_revoked` (platform renewal is out of JOB-004 scope; documented).

Non-goals (correctly deferred): event storage/projection (JOB-005), control storage (JOB-006), secret
materialization/retry/reconciliation — the pre-JOB-005 governed mutators are guarded stubs behind the
already-closed interface.
