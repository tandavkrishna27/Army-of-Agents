# JOB-014 — Preserve task outputs and run summaries — result

**Result:** `pass`
**Revision:** authored on `docs/replatform-program` (after JOB-013; LAST E3 ticket)
**Date (UTC):** `2026-08-14`
**Acceptance:** `pnpm --filter @armyofagents/db build && pnpm -r build` (clean, EXIT 0 — db/shared/server/ui/cli). `AOA_RUN_WIN_INTEGRATION=1 pnpm --filter @armyofagents/db exec vitest run src/__tests__/job-events-schema.integration.test.ts src/__tests__/job-control-schema.integration.test.ts src/__tests__/migration-idempotency.test.ts` = **22 passed** (the schema-sibling lesson: the widened projection-kind CHECK did NOT break the exact-column-list assertions; 0246/0247 replay idempotently). `pnpm --filter @armyofagents/server exec vitest run src/__tests__/artifact-lifecycle-schema-contract.test.ts` = **3 passed** (latest snapshot resolves to `0247_snapshot.json` — BOTH snapshots authored). `pnpm --filter @armyofagents/db exec vitest run src/__tests__/migration-journal-contiguity.test.ts` = **4 passed** (248 entries idx 0..247, `sqlFiles.size === entries.length`). `AOA_RUN_WIN_INTEGRATION=1 pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-output-parity.integration.test.ts` = **16 passed**. `pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-control-legacy-grants.contract.test.ts src/__tests__/job-fence-surface.contract.test.ts` = **15 passed** (**7** legacy-grants KEYSTONE UNCHANGED + **8** fence-surface). `tsc --noEmit` green for both `@armyofagents/server` and `@armyofagents/db`. Regression: `run-summary-comment`(5) + `run-summary-comments`(11) + `task-outputs-service`(7) + `task-output-emitters`(5) + `task-outputs-routes`(4) + `output-detection`(6) + `output-detection-task-outputs`(3) = **41 passed** (the extract-into-tx-fn + new sibling insert did NOT disturb any existing output/comment caller). On Windows the `.integration` files run under `AOA_RUN_WIN_INTEGRATION=1`; **Linux CI is the formal green authority** (DEC-03).

## Outcome

`job-output-bridge` projects an ACCEPTED artifact/result event and the TERMINAL WINNER of a DISTRIBUTED attempt into the EXISTING task-output, review/primary, run-summary, and task-terminal contracts **EXACTLY ONCE**. The projection is TWO independent mutations with independent idempotency, so the bridge has **TWO entrypoints and TWO JOB-005 receipt kinds**:

- `projectAcceptedOutput` → writes ONE `task_outputs` row (via the EXISTING upsert) + an `output_projection` receipt in ONE tenant tx. The attempt stays **RUNNING** (an output event is not terminal); replay is guarded by the receipt fast-path behind `lockActiveFence`. Structurally near-identical to the JOB-012/013 single-mutation bridges: flag gate → `resolveAdmissibleOrganization` → one `runInTenant`(`lockActiveFence` FIRST → receipt fast-path → mutation → `recordGovernedProjection` `applied`).
- `projectTerminalWinner` → the terminal-winner-once guard: receipt fast-path FIRST → `completeAttempt` (claims the winner) → (optional) ONE run-summary `issue_comments` row → a `task_terminal` receipt, all in ONE tenant tx.

Flag-off leaves every current output/summary path byte-unchanged — every entrypoint throws `JobOutputBridgeDisabledError` before any effect; the not-flag-gated rollback gate throws `JobOutputBridgeRollbackPendingError` while EITHER an `output_projection` or `task_terminal` receipt is pending, so disabling can never lose or skip an accepted projection.

## The terminal-winner-once mechanism (load-bearing correctness)

`completeAttempt` makes the attempt **terminal**, so a legitimate winner-RETRY can no longer pass `guardActiveFence` (it throws `attempt_terminal`). The `task_terminal` **receipt** is therefore the winner's replay guard — NOT the fence. Two interlocking pieces:

1. **Receipt fast-path BEFORE any guard/completeAttempt.** `projectTerminalWinner` reads the `task_terminal` receipt by `source_identity = task_terminal:{company}:{terminalEventId}` FIRST. A hit returns `status:"replayed"` (`attemptTerminated:false`, `commentId` = the receipt's `target_aggregate_id` iff `aggregate_kind='issue_comments'`, else null) WITHOUT touching the attempt. This is the opposite ordering from the audit template (which locks FIRST because its mutation never changes attempt status). Proven by `[terminal replay / winner-retry]` (2 calls same `terminalEventId` → recorded then replayed; 1 comment, 1 receipt, attempt unchanged).

2. **`completeAttempt` catch-to-replay latch.** `completeAttempt` is wrapped: on a `JobFenceError` with `code === "attempt_terminal"`, re-read the receipt — **present** ⇒ a concurrent winner committed (return `replayed`); **absent** ⇒ a GENUINE LOSER (rethrow — a loser cannot change terminal state). Any other fence error (`stale_fence`/`target_revoked`) rethrows, writing nothing. Two same-event callers serialize on `completeAttempt`'s FOR UPDATE lock: the 2nd wakes after the 1st commits, its `completeAttempt` throws `attempt_terminal`, its post-catch re-read sees the committed receipt (READ COMMITTED) → replays. Proven by `[losing winner]` (a DIFFERENT `terminalEventId` on an already-terminal attempt rejects; no 2nd comment; attempt status unchanged).

**Deviation from the plan (§1b step 4) — required, load-bearing.** The plan recorded the `task_terminal` receipt via `recordGovernedProjection` AFTER `completeAttempt`. That FAILS: `recordGovernedProjection` internally re-runs `guardActiveFence`, which throws `attempt_terminal` against the attempt we just made terminal (observed: the initial RED run failed all 6 terminal cases here). The fix: after `completeAttempt` confirms the winner, the `task_terminal` receipt is inserted **DIRECTLY** (`tx.insert(jobProjectionReceipts) … onConflictDoNothing` on the identity unique) — the fence was already validated by `completeAttempt`, and the receipt's composite tenant FK still enforces integrity. `projectAcceptedOutput` is unaffected (its attempt stays running, so it keeps using `recordGovernedProjection`). The winner never writes a comment before it is confirmed the winner, so a loser/replay never leaves a stray comment.

## `issueId` is caller-supplied — the no-fabricated-task-IDs invariant

`issueId` is an explicit `string | null` parameter on BOTH entrypoints, **NEVER derived** from a source that lacks one. The bridge does not resolve crew→issue (the orchestrator/caller does — the parity test passes the resolved `ISSUE` for the crew case). Mechanically:

- `projectAcceptedOutput` with `issueId === null` → returns `{status:"skipped", outputId:null}` and writes NOTHING.
- `projectTerminalWinner` with `issueId === null` (or `summary.runtimeConfig.autoRunSummary === false`) → **skips the comment** but STILL writes the `task_terminal` receipt with `aggregate_kind:"job_attempts"`, `target_aggregate_id = attemptId`, so the winner is replay-guarded.

Proven by `[six-source projections]` (`task_run`/`crew_run` with a resolved `ISSUE` write output+summary; `commander_turn`/`one_shot`/`browser_request`/`service_reconcile` pass `issueId:null` → 0 `task_outputs`, 0 `issue_comments`, a `task_terminal` receipt `aggregate_kind='job_attempts'` targeting the attempt) and `[opt-out]` (`autoRunSummary:false` → no comment, attempt still terminal, `job_attempts` receipt).

## Never elect primary + artifact ≠ output (contract distinctions)

- **Never elect primary.** Every output write forces `isPrimary:false`; `reviewState` is caller-supplied (default `"none"`). `clearSiblingPrimaries` runs ONLY when `values.isPrimary` is truthy (`task-outputs.ts`), so a bridge output can neither become primary nor demote an existing one. Proven by `[review/primary contract]` (a `needs_review` output leaves a pre-seeded sibling primary intact) and `[output accepted]` (row `is_primary=false`, `review_state='none'`).
- **Ordinary fenced artifact commit stays DISTINCT.** The bridge NEVER calls `authorizeArtifactCommit` (that writes `job_artifacts`); only an accepted output event writes `task_outputs`. Proven by `[artifact commit ≠ output]` (a direct `authorizeArtifactCommit` → 1 `job_artifacts`, 0 `task_outputs`).
- **Stale/losing output = quarantine metadata only.** A `quarantine` block writes `isPrimary:false` + `metadata.quarantined`/`quarantineReason`; it never touches terminal/summary. Proven by `[quarantine output]` (metadata set, no comment, no `task_terminal` receipt, attempt non-terminal).

## Two minimal, byte-preserving service adaptations

- `task-outputs.ts` — extracted the inner `serviceDb.transaction(...)` BODY of `upsertForIssue` into a new exported tx-accepting `upsertTaskOutputForIssue(db, companyId, issueId, input)`; `upsertForIssue` now wraps it in its own transaction. Existing callers byte-unchanged (7 service + 4 route + 3 detection + 5 emitter regression tests green). The bridge calls it on the `runInTenant` `tx` directly, so the output write and its receipt commit in ONE tenant tx (no nested SAVEPOINT).
- `run-summary-comment.ts` — left `postRunSummaryComment` unchanged (heartbeat/crew keep it). Added `insertRunSummaryComment(tx, {id, companyId, issueId, outcome, body})`: a tx-scoped, THROWING (no try/catch — a failed insert MUST roll back the tenant tx), CLIENT-SIDE-id insert (aoa_app is INSERT-only on `issue_comments` → no `.returning()`, mirror the audit bridge's `hub_audit`), + the `issues.updatedAt` touch. The bridge builds `body` via the pure `formatRunSummary` and does the `autoRunSummary` opt-out check itself.

## Migrations 0246/0247 + BOTH snapshots (the hard-won lesson)

- `GovernedProjectionKind` (job-control.ts) widened with `| "output_projection" | "task_terminal"`; the schema `job_projection_receipts` projection_kind `check()` widened to match.
- `0246_job_output_projection.sql` = C14 CHECK-only widen (DROP CONSTRAINT IF EXISTS + ADD), mirroring 0244. `0247_job_output_projection_rls.sql` = copy of 0245 verbatim (RLS re-affirm on `job_projection_receipts` — REVOKE/GRANT/ENABLE+FORCE/DROP+CREATE the SAME single `job_projection_receipts_tenant_isolation` policy). **ZERO new policy, ZERO new grant.** `task_outputs`/`issue_comments`/`issues` are already granted to aoa_app (SELECT+INSERT+UPDATE / INSERT / SELECT+UPDATE) — touched by no grant/RLS/policy.
- **BOTH drizzle snapshots authored** (a prior ticket's Linux CI failed for lack of one): `meta/0246_snapshot.json` = copy of `0245_snapshot.json` with `prevId = 1a29b716-…` (0245's id), a fresh `id`, and ONLY the `job_projection_receipts` projection_kind check value widened. `meta/0247_snapshot.json` = copy of 0246 with `prevId = 0246.id`, a fresh `id` (schema identical — RLS is not in snapshots). Chain verified: 0245.id → 0246.prevId → 0246.id → 0247.prevId. Two `_journal.json` entries appended (idx 246/247). `artifact-lifecycle-schema-contract` resolves the latest snapshot to `0247_snapshot.json` and finds the full `artifact_versions` table (GREEN); `migration-journal-contiguity` sees 248 contiguous entries with matching `.sql` files (GREEN).

## KEYSTONE note (unchanged)

No new grant and no new policy → `POLICY_COUNTS` and the RLS/FORCE/permissive certificate are UNCHANGED: `job-control-legacy-grants.contract.test.ts` (7) stays GREEN with `job_projection_receipts: 1` policy and the `task_outputs`/`issue_comments`/`issues` ACL rows unchanged. No new repository mutator → `job-fence-surface.contract.test.ts` (8) stays GREEN (the bridge is a control-plane caller, not a guarded repo method).

## Failure matrix (`server/src/__tests__/job-output-parity.integration.test.ts`, 16 cases)

| # | case | assertion |
|---|---|---|
| 1 | output accepted | `recorded`; 1 `task_outputs` (`is_primary=false`, `review_state='none'`); 1 `output_projection` receipt `applied`, `target=outputId`, `aggregate_kind='task_outputs'` |
| 2 | duplicate provider identity | same provider+externalId across distinct events → UPDATE in place, 1 row (title = v2) |
| 3 | output replay | same `acceptedEventId` twice → recorded then replayed (same outputId); 1 row, 1 receipt |
| 4 | review/primary contract | `needs_review` output `is_primary=false`; a pre-seeded sibling primary stays primary |
| 5 | terminal winner — success | 1 system `issue_comments` (tone `success`); 1 `task_terminal` receipt `aggregate_kind='issue_comments'`, `target=commentId`; attempt `succeeded` |
| 6 | every terminal | `failed`/`cancelled`/dead_letter→`failed`/expired→`timed_out` → 1 comment each, tone `danger`/`info`/`danger`/`danger`; 1 `task_terminal` receipt; attempt status = the terminal status |
| 7 | terminal replay / winner-retry | 2 calls same `terminalEventId` → recorded then replayed (`attemptTerminated:false`, same commentId); 1 comment, 1 receipt |
| 8 | losing winner | a DIFFERENT `terminalEventId` on a terminal attempt rejects; no 2nd comment; attempt status unchanged |
| 9 | quarantine output | `metadata.quarantined=true`+reason, `is_primary=false`; no comment, no `task_terminal` receipt, attempt non-terminal |
| 10 | six-source projections | task/crew (resolved issue) → 1 output each; commander/one_shot/browser/service (`issueId:null`) → 0 outputs, 0 comments, `task_terminal` `aggregate_kind='job_attempts'` targeting the attempt |
| 11 | artifact commit ≠ output | direct `authorizeArtifactCommit` → 1 `job_artifacts`, 0 `task_outputs` |
| 12 | rollback publishes nothing | bogus `createdByAgentId` → notFound mid-tx → rejects; 0 `task_outputs`, 0 `output_projection` receipts |
| 13 | opt-out | `autoRunSummary:false` → no comment, attempt `succeeded`, `task_terminal` `aggregate_kind='job_attempts'` |
| 14 | rollback gate (pending) | a forced PENDING `output_projection` receipt → `assertRollbackSafe` rejects `JobOutputBridgeRollbackPendingError`; flip to `applied` → resolves |
| 15 | flag off | `isEnabled()===false`; both entrypoints reject `JobOutputBridgeDisabledError`; 0 outputs/comments/receipts |
| 16 | rollback before/after accepted artifact | gate resolves with no pending receipt and after an APPLIED output; rejects only on a forced PENDING `task_terminal` receipt |

## Files created / modified

**Created:**
- `server/src/services/job-output-bridge.ts` — the parity bridge (two entrypoints, two receipt kinds, terminal-winner-once).
- `server/src/__tests__/job-output-parity.integration.test.ts` — the 16-case parity matrix.
- `packages/db/src/migrations/0246_job_output_projection.sql` — C14 CHECK widen.
- `packages/db/src/migrations/0247_job_output_projection_rls.sql` — RLS re-affirm (0245 clone, zero new policy).
- `packages/db/src/migrations/meta/0246_snapshot.json`, `meta/0247_snapshot.json` — drizzle snapshots (valid prevId chain).

**Modified:**
- `packages/db/src/repositories/tenant/job-control.ts` — `GovernedProjectionKind` widened (`output_projection` + `task_terminal`).
- `packages/db/src/schema/job_projection_receipts.ts` — projection_kind `check()` widened.
- `packages/db/src/migrations/meta/_journal.json` — idx 246/247 entries.
- `server/src/services/task-outputs.ts` — extracted exported tx-accepting `upsertTaskOutputForIssue`; `upsertForIssue` wraps it (byte-unchanged behavior).
- `server/src/services/run-summary-comment.ts` — added tx-scoped, throwing, client-id `insertRunSummaryComment` (`postRunSummaryComment` unchanged).

## Independent check + two fixes applied

A 2-lane adversarial Workflow. The direct `task_terminal` receipt insert (the source-forced deviation) was **verified sound** — it uses the same `(org, company, projection_kind, source_identity)` identity-unique + `onConflictDoNothing` as `recordGovernedProjection`, stamps org/company/job/attempt from the fence (composite FK + RLS enforce tenancy), and runs under `completeAttempt`'s FOR UPDATE lock. **Two confirmed defects — FIXED:**

1. **MEDIUM — the optional summary comment could veto the mandatory terminal completion.** `projectTerminalWinner` ran `completeAttempt` and the throwing `insertRunSummaryComment` in ONE tx; a comment FK failure (e.g. the task hard-deleted mid-run → `issue_comments.issue_id` FK) aborted the whole tenant tx, rolling back the completed attempt → the winner never records its true status (only the reaper converges it as `expired`, losing the outcome / risking re-execution). **FIX:** the comment insert now runs in a nested **SAVEPOINT** (`tx.transaction`) with a catch — a failure rolls back only the comment, never `completeAttempt`; a failed comment falls back to the `job_attempts` receipt (the winner stays recorded + replay-guarded), matching the legacy best-effort `postRunSummaryComment`. Regression `[terminal summary failure]`.
2. **LOW — a re-delivered/quarantine output could demote a founder-elected primary.** The forced `isPrimary:false`, on `upsertTaskOutputForIssue`'s `(provider, externalId)` update-in-place branch, overwrote an existing row's `is_primary`. **FIX:** the upsert is now **promote-only** for the primary flag (`is_primary = existing.is_primary OR values.isPrimary`) — a stale re-delivery never demotes a primary; a genuine promotion still wins. Regression `[no primary demotion]` (fail-first proven). This also corrects the shared `upsertTaskOutputForIssue` for legacy callers (an upsert should never silently demote a primary).

Both regressions bring the parity matrix to **18 cases**. Gates re-verified independently: parity 18, keystone 15, artifact-lifecycle 3, schema siblings 26, tsc clean, plus 34 run-summary/task-outputs mock/regression tests (the mock-fidelity lesson applied).

## Non-goals (unchanged from spec)

Artifact-byte storage, automatic quarantine promotion, fabricating task outputs for inapplicable sources, and changing the current review/primary contract — none touched. `browser_request`/`service_reconcile` are N/A here (they pass `issueId:null` and mint no task rows) until their owning epics define projections.
