# JOB-006 — Cancellation, expiry, retry, and reconciliation — result

**Result:** `pass`
**Revision:** authored on `docs/replatform-program` (after JOB-005 `aacddfc6e`)
**Date (UTC):** `2026-08-14`
**Acceptance:** `pnpm --filter @armyofagents/db exec vitest run src/__tests__/job-control-schema.integration.test.ts src/__tests__/migration-idempotency.test.ts` (15) + `pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-reconciliation.integration.test.ts src/__tests__/job-control-commands.integration.test.ts` (**14** after the fix). Re-verified: reconciliation + control-commands + `job-control-legacy-grants.contract` + `job-fence-surface.contract` = 28 green pre-fix; 14 acceptance green post-fix; `tsc --noEmit` green (db + server).

## Outcome

Durable controls + reconciliation converge abandoned or canceled work to ONE winner / new attempt / terminal result, behind the JOB-004 active-fence guard.

## Deliverables

- **`packages/db/src/schema/job_control_commands.ts`** — durable cancel/drain/graceful_stop command + ACK; unique `(org, lease, command_id)` and monotonic `(org, lease, command_seq)`; composite tenant FKs to `job_attempts`+`leases` only.
- **Migrations** `0236` (table + `jobs.max_attempts`/`dead_letter_reason` + `job_attempts.backoff_until`; C14-idempotent guards) + `0237_job_control_commands_rls.sql` (custom Decision #122 RLS mirroring 0235).
- **`server/src/services/job-reconciliation.ts`** (reaper/cancellation) + **`job-control-sweeper.ts`** (bounded sweeper: one in-flight tick, bounded org window + rotating cursor + tick budget, bounded reaper batch, backoff, flag-off = zero-DB no-op) + **`job-control-ack.ts`** (worker fence-guarded control-ACK).
- Repo: filled the JOB-004 `ackControlCommand` stub (guard-first); added `requestCancellation`/`listPendingControlCommands`/`allocateRetryAttempt`/`reapExpiredLeases`; `renewLease` surfaces an un-ACKed cancel.
- `POST /control-acks` + operator cancel route.
- **Manifest reconciliation:** `job_control_commands` registered (RLS 18→19, FORCE 17→18, policies 26→27) in `job-control-legacy-grants.ts` + `distributed-execution-databases.ts` + the independent oracle.

## One-winner + convergence (verified)

- Reaper claims expired leases `FOR UPDATE SKIP LOCKED`, locks attempt→job, conditionally revokes the fence (`offered/active → released/revoked/expired`; a losing update = another reaper converged → skip), and converges: `succeeded`→finalize (no retry); `cancelled`/`cancel_requested`→cancelled; else `expired`→retry if `attempt_number < max_attempts` else dead-letter (`retry_exhausted`).
- **N+1 allocation** under the job lock proceeds only if `max(attempt_number)` still equals the reaped N (else `not_latest` — no spurious N+2); the `(org,company,job,attempt_number)` unique + `ON CONFLICT DO NOTHING` backstop → exactly one N+1 attempt + one attempt-ready outbox row; immutable backoff; late fence mutation refused (`attempt_terminal`/`stale_fence`), never overwriting a winner; never revives an expired fence.

## Independent check + two fixes applied

Controller review + a 2-lane adversarial Workflow. **Lane (manifest consistency): CLEAN.** **Lane (reaper/cancellation): two real concurrency defects the serial tests can't surface:**
1. **BLOCKER — lock-order inversion → deadlock:** `requestCancellation` locked job→attempt→lease, the reverse of the reaper + worker-ingest (which lock the job LAST). A concurrent cancel + reap/terminal-event forms a wait-for cycle → Postgres 40P01. **FIXED:** cancellation now locks lease→attempt→job (job last) — a single global order across all three paths.
2. **SHOULD-FIX — convergence gap:** a job cancelled while its attempt has no active lease (pending/queued, or a retry N+1 in backoff) was set `cancel_requested` but nothing ever converged it (the reaper only scans expired *leases*; `claimReadyOutbox` won't dispatch a `cancel_requested` job) → permanent hang. **FIXED:** the no-lease branch finalizes `cancelled` directly (attempt + job, `notInArray`-terminal) under the held locks; added a `cancelled` status + the regression test "finalizes cancellation to terminal 'cancelled' when the job has NO active lease".

Non-goals (deferred): provider adapter/resource, checkpoint bytes, mobility, reviving an expired fence.
