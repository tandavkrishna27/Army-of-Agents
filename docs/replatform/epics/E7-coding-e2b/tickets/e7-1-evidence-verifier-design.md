# evidence-verifier A — the E7-1 distributed-run promotion gate (design v2)

**Status:** design · **v2 (post-adversarial-review, 2026-08-28)** · **Worktree:** `C:\e3` · **Branch:** `docs/replatform-program`
**Slug is graph-inert** (`e7-1-evidence-verifier`, no `^[A-Z]{2,5}-\d{3}` id → no ticket-graph node; mirrors
`BRW-hostspawn-gate`). It is the campaign plan's unit **(A)** (`qa/2026-08-28-e7-1-campaign-plan.md` §4.A)
and mechanizes the promotion rule (`CLI-006-staging-canary-runbook.md` §4/§5; campaign plan §6).

> **v2 folds a three-reviewer adversarial pass (§8).** v1 had the exact defect it exists to catch — it
> would have blessed a distributed *handoff that no worker ever ran*. v2 adds the job-kernel corroboration
> clause (5), retargets + narrows the leak scan (4), fixes the store/port shape, the register/bin
> placement, tenant binding, and not-found handling. Clauses 1–3 were verified sound and are unchanged.

---

## 0. What this is, and the one reason it exists

`E7-1-coding-journey` flips `unwired → wired` in `scripts/gate-clause-wiring.json` **only** on a cited,
dispatched, real-E2B run that completed the DISTRIBUTED journey. Today that citation is an **operator
eyeballing a database column.** This is the programme's central vacuous-green trap *at its highest-stakes
moment*: every one of the campaign's ~6 arming prerequisites, if missing, produces a **silent legacy
fallback** or an **inert handoff** — the run completes, real E2B spend may be incurred, and the result is
indistinguishable at a glance from the distributed journey (campaign plan §2, §7).

**Evidence-verifier A mechanizes the promotion rule into a read-only script that refuses to bless a run
unless it is provably the distributed journey — a worker leased it, ran it, and its terminal was
projected.** It flips no gate; it produces the verdict a human cites when flipping the gate.

**Non-goals:** A does not arm, dispatch, or deploy. Pre-spend arming is unit **(B)** (`canary-readiness`,
campaign plan §4.B). A runs **after** a dispatched run.

---

## 1. The requirement

`verify-e7-1-distributed-run <runId>` reads the dispatched run **and its distributed-kernel evidence** and
**exits non-zero, naming the failing clause(s), unless ALL hold** (campaign plan §4.A; runbook §4):

1. **Ownership** — the heartbeat ran a *distributed* attempt, not its own adapter.
2. **Evidence binding** — the run carries distributed job + attempt ids.
3. **Durably terminal** — the run reached a durable terminal state.
4. **No leaked secret** — no provider key / E2B key leaked into the run's real evidence surfaces.
5. **A worker actually leased, ran, and its terminal was projected** — the run is a completed journey, not
   an inert handoff. *(new in v2 — the load-bearing anti-false-PASS clause.)*

Buildable + **pure-unit testable now** (store-fixture tests, no embedded-PG, no live fleet, no real key);
only its *execution input* (a real dispatched run) is operator-time.

---

## 2. The clauses, grounded in source

Column facts from `packages/db/src/schema/{heartbeat_runs,heartbeat_run_events,job_events,job_attempts,leases,job_projection_receipts,job_artifacts,task_outputs}.ts`;
terminal set + helper from `server/src/services/heartbeat.ts`; ownership writer from
`server/src/services/run-execution-owner.ts`; redactor from `server/src/redaction.ts`.

### Clause 1 — Ownership: `execution_owner === "distributed"` — **VERIFIED SOUND (§8), unchanged**

The schema comment (`heartbeat_runs.ts`, `executionOwner`) states the invariant: `null` is the only value
a legacy run carries; `"distributed"` means the heartbeat **SUPPRESSED its own `adapter.execute`.** Sole
writer is `buildHandoffRunPatch` (`run-execution-owner.ts`), which **throws** unless
`owner.owner === "distributed"`; its only application (`heartbeat.ts` `db.update(heartbeatRuns)`) sits
inside the `shouldSuppressLegacyExecution` branch that `return`s **before** `adapter.execute`. The column
is never copied on retry; the only two values ever persisted are `null` and `"distributed"`. **FAIL**
unless `execution_owner === "distributed"` exactly. *(Fail-safe: this can only refuse, never bless a
legacy run — but "not legacy" ≠ "the journey ran" → clause 5.)*

### Clause 2 — Evidence binding: both dist ids set — **softened (defense-in-depth)**

`distributed_job_id` + `distributed_attempt_id` (real `uuid`, null on legacy) are written **atomically
with the marker** by `buildHandoffRunPatch`, so on a real row clause 2 never fails independently of clause 1.
Keep it as a cheap defense-in-depth null-check; it **binds the run to distributed evidence** (it does NOT,
by itself, prove a worker ran it — that is clause 5). **FAIL** if either id is null.

### Clause 3 — Durably terminal — **VERIFIED SOUND, unchanged; safe only because clause 5 corroborates**

`TERMINAL_RUN_STATUSES = ["succeeded","failed","cancelled","timed_out"]` + `isTerminalRunStatus`
(`heartbeat.ts`). **FAIL** unless `isTerminalRunStatus(status)` and `finished_at` is set. A is
terminal-**agnostic** — the golden journey ends in a deliberate fence-revoking **`cancelled`**, and
`succeeded` is equally valid; accepting `failed`/`timed_out` is safe **only because clause 5** proves a
worker actually leased+ran (a never-leased attempt also lands in a terminal). Surface `status` +
`error_code` in `observed` so the operator judges whether the terminal was the intended one.

### Clause 5 — Journey corroboration against the job kernel — **NEW; the anti-false-PASS clause**

**Why it exists (§8 BLOCKER 1, verified):** `execution_owner="distributed"` + both ids are stamped at
**handoff** — the instant placement makes the attempt *leasable*, **before any worker leases it**
(`run-execution-owner.ts` header: "Placement is the LAST step, because placement is what makes an attempt
leasable"; the marker write follows). A run handed to a worker that never enrolls (a *named* silent-fallback
trap, campaign plan §2 prereq e) terminalizes carrying every mark clauses 1–4 check, **byte-indistinguishable
from the golden journey.** Clause 5 closes this by corroborating against where "a worker leased, ran, and
the projector projected" is durably recorded. Via `distributed_attempt_id` (and `distributed_job_id`),
**tenant-matched on `company_id`** (the heartbeat columns carry NO foreign key — §8 MED 5), require:

- **A worker leased it:** ≥1 `leases` row for the attempt (`leases.ts`). *(The strongest single
  discriminator: the never-leased inert handoff has none.)*
- **A worker started it:** ≥1 `job_events` row `event_type='attempt_started'` for the attempt
  (`job_events.ts` — the distributed event surface, keyed by `attempt_id`/`lease_id`/`fence_token`).
- **A terminal was projected:** a `job_projection_receipts` row `projection_kind='attempt_terminal'`,
  `status='applied'` for the attempt (`job_projection_receipts.ts`) — proves the *projector* ran, not that
  the reaper terminalized an empty shell (§8 HIGH 3). And ≥1 `job_events` `event_type='terminal'`.
- **Same-tenant, same-job attempt row exists:** a `job_attempts` row whose id = `distributed_attempt_id`,
  `company_id = heartbeat_runs.company_id`, `job_id = distributed_job_id` (`job_attempts.ts`, composite
  tenant FK) — so the bare stamped uuids name a real, same-tenant attempt, not a dangling/cross-tenant id.

**Terminal-agnostic on purpose (my refinement of the review):** do **NOT** require final
`job_attempts.status ∈ {running,succeeded}` — the golden journey ends in a deliberate **cancel**, whose
attempt is `cancelled`/`cancel_requested` (`job_attempts_status_check`). The proof of "a worker ran it" is
the durable **`leases` row + `attempt_started` event + `attempt_terminal` projection receipt**, all of
which a cancelled-after-running attempt has and a never-leased attempt lacks. When `status='cancelled'`,
additionally corroborate the fence-revoke: the attempt's lease reached `status='revoked'` (`leases.ts`;
§8 LOW 7).

**SHOULD-surface, not hard-fail (§8 HIGH 4):** report the count of committed `job_artifacts`
(`kind='workspace_patch'`, carrying `leaseId`+`fenceToken`) / `task_outputs` (`createdByRunId=runId`) for
the run — a deliberate cancel can pre-empt produce, so surface it for operator judgment rather than
rejecting.

**FAIL** if the leased / started / projected corroboration is absent.

### Clause 4 — No leaked secret — **REWORKED (§8 grounding-skeptic HIGH + completeness BLOCKER 2 + security BLOCKER 3)**

Three v1 defects, all verified:
- **Wrong surface.** `heartbeat_run_events` is written **only** by the legacy `heartbeat.ts`; a distributed
  worker's logs land in **`job_events.event`** (jsonb, `event_type='log'`). v1 scanned an empty table.
- **False premise.** The scanned fields are stored **RAW at rest** (`stdout_excerpt` via `sanitizeForDb` =
  a unicode strip, not a redactor; event payloads inserted raw); redaction is applied only at **egress**
  (`redactRunEventPayload` = "the redactor for event payloads on their way **out**"). So "re-redaction
  changed the field" ≠ "a leak escaped" — the egress redactor is **deliberately over-redacting**
  (`redaction.ts` `SECRET_VALUE_PATTERNS` pattern 7 = any `\b[A-Za-z]\w*_[A-Za-z0-9]{20,}\b`), which
  legitimately matches session ids / hashes in a clean run. A hard gate on that diff would **false-positive
  on clean distributed runs** and get overridden — corroding the gate.
- **Re-leak.** Quoting the offending value to "prove" the leak re-commits the Decision #104 leak.

**v2 clause 4:**
- **Right surfaces:** scan the distributed evidence — every `job_events.event` (jsonb) for the attempt, the
  run-summary `issue_comments` body, `task_outputs.summary/metadata` and `job_artifacts` metadata for the
  job — **plus** the `heartbeat_runs` raw text fields (they *are* raw at rest): `stdout_excerpt`,
  `stderr_excerpt`, `error`, `prompt_snapshot`, `detected_outputs`, `result_json`, `context_snapshot`,
  `usage_json` (§8 LOW 10 — include `detected_outputs`, the agent-authored field most likely to leak).
- **Leak-SPECIFIC matchers (hard-FAIL), not the over-redactor diff:** the provider-key class
  `\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b` (**verified to cover the redeemed Company key** — `redaction.ts`
  pattern 2), an **explicit E2B matcher** (`\be2b_[A-Za-z0-9]{16,}\b` and the literal `/E2B_API_KEY\s*[=:]/`)
  because no E2B shape is fixed in the tree and the generic pattern misses infix forms like
  `e2b_live_…`, connection-string URIs, and PEM `-----BEGIN … PRIVATE KEY-----` blocks. Do **NOT** hard-fail
  on the broad generic `<prefix>_<20+>` — surface those as **advisory** (`observed.suspectedHeuristicHits`)
  for operator judgment.
- **Never quote the match:** a clause-4 failure reports `{ surface, fieldOrEventId, matchedClass, count }`
  — **never the raw substring** (the literal-`E2B_API_KEY=` arm especially: its value did not pass through
  any redactor). A test asserts no planted secret appears anywhere in `VerifyResult` or printed output.
- **Honest limitation (rewritten):** clause 4 is a leak-*class* backstop. It cannot detect an opaque
  redeemed token with no recognizable shape (A must never hold the value to compare). The value-planted
  case is covered at *write/egress* time by `synthesiseRunSecrets` / the DAT-008 slice-5 redaction canary
  (`E5-5-redaction`, `wired`); A backstops the recognizable provider-key / E2B / URI / PEM classes the
  promotion rule names.

---

## 3. Shape — a `{ store }`-port service + drizzle adapter + a thin CLI (§8 HIGH 3/4)

Mirror `canary-preflight.ts` **exactly** — a pure acceptance module over a port, with drizzle in a separate
adapter file (the CLAUDE.md drizzle-ESM test split; `canary-preflight.ts` `createCanaryPreflight(deps: { store })`
+ `canary-preflight-store.ts` `createDrizzleCanaryPreflightStore(db)`):

- **Pure service:** `server/src/services/e7-distributed-run-verifier.ts` —
  `createE7DistributedRunVerifier(deps: { store: E7RunVerifierStore }).verify({ runId, expected? })`.
  `expected?: { organizationId?, companyId? }` lets the operator assert the run belongs to the canary org
  (§8 MED 5). No drizzle import. Returns
  `VerifyResult = { ok, runId, notFound?: true, failures: Array<{ clause:1|2|3|4|5, reason }>,
  observed: { executionOwner, distributedJobId, distributedAttemptId, companyId, organizationId, status,
  errorCode, finishedAt, leaseCount, attemptStartedEvents, terminalEvents, projectionReceiptApplied,
  producedArtifacts, suspectedHeuristicHits } }`.
- **Port `E7RunVerifierStore`:** `getRun(runId)`, `getAttempt(attemptId)`, `listLeases(attemptId)`,
  `listJobEvents(attemptId)`, `getAttemptTerminalReceipt(attemptId)`, `listRunSecretScanSurfaces(run)` (the
  text/jsonb blobs to scan). Every method returns plain data; **no key value ever crosses the port.**
- **Drizzle adapter:** `server/src/services/e7-distributed-run-verifier-store.ts`
  `createDrizzleE7RunVerifierStore(db)` — all tenant-scoped `SELECT`s; **the only file that imports the
  schema.**
- **CLI:** `server/src/cli/verify-e7-1-distributed-run.ts` run via a `package.json` script (e.g.
  `tsx server/src/cli/verify-e7-1-distributed-run.ts <runId>`); opens the app DB, composes adapter→service,
  prints the per-clause verdict + `observed`, `process.exit(ok ? 0 : 1)`. **NOT** `scripts/(check|verify)-*.mjs`
  (§8 HIGH 2 — that trips `check-guard-inventory`'s `GUARD_NAME=/^(check|verify)-.+\.mjs$/`) and **NOT**
  a `*.test.mjs` (would trip `check-execution-census`). As ordinary server code + a vitest test it touches
  **neither register** and rides normal `verify` CI.

---

## 4. Test strategy — pure store-fixture units (§8 HIGH 3 makes this simple)

Vitest `server/src/__tests__/e7-distributed-run-verifier.test.ts` over hand-built `E7RunVerifierStore`
fixtures (no embedded-PG, no drizzle — exactly like `cli-006-canary-preflight.test.ts`). Write the tests
FIRST.

| # | Fixture | Expected |
|---|---|---|
| a | Golden: `execution_owner="distributed"`, both ids, `status="cancelled"`, finished; attempt has a `leases` row + `attempt_started` + `terminal` events + an applied `attempt_terminal` receipt + lease `revoked`; clean surfaces | **PASS** |
| b | as (a) but `execution_owner=null` | FAIL 1 |
| c | as (a) but a dist id null | FAIL 2 |
| d | as (a) but `status="running"`, `finished_at=null` | FAIL 3 |
| e | as (a) but a `job_events` `log` payload contains `sk-ant-<24 alnum>` (assert `redactSecretsInString` matches it in-test) | FAIL 4 |
| f | as (a) but `stdout_excerpt` contains `E2B_API_KEY=e2b_<20 alnum>` | FAIL 4, and the raw value appears **nowhere** in `VerifyResult` |
| g | **The v1 false-PASS:** distributed handoff, both ids, `status="cancelled"`, finished, clean — but **no `leases` row, no `attempt_started`, no receipt** (worker never leased) | **FAIL 5** |
| h | as (a) but attempt row is a **different `company_id`** | FAIL 5 (tenant) |
| i | `runId` not present in the store | `ok=false, notFound=true`, no throw |
| j | as (a) but `status="failed"` with an `error` | **PASS**, `observed.status="failed"` surfaced |

**Anti-vacuity (§8 LOW 9, restated correctly):** the invariant is "**each fixture reddens for exactly one
clause**" (not "deleting a clause flips exactly one fixture" — deleting clause 4 flips both e & f). Verify
by hand-deleting each clause and re-running: (b)→1, (c)→2, (d)→3, (e)/(f)→4, (g)/(h)→5. Clause-4 fixtures
MUST plant a value the *chosen leak-specific matcher* catches — assert `redactSecretsInString(v) !== v`
(or the explicit E2B matcher) in the test setup, else clause 4 is tested vacuously (the programme's
signature defect — `checks-that-nothing-runs`).

---

## 5. Promotion linkage (necessary, not sufficient) — unchanged

A green is a **necessary** precondition for `E7-1-coding-journey → wired`, not sufficient: the full journey
observation + non-canary isolation (runbook §3 step 8) remain the operator's. A mechanizes the
machine-checkable evidence (ownership + binding + terminal + no-leak + leased/ran/projected). When the
operator flips the gate they cite **A's output + the run id** in the `reason`, then update
`CLI-006-campaign-result.md` + GO-BOOK §3.1/§4 and run the five registers (campaign plan §6). **A flips no
gate.** The keyed provider lane, a D1 fake-provider run, and any embedded-PG harness do not satisfy A
against a real run and do not promote E7-1 regardless (campaign plan §3, §6).

---

## 6. Security constraints (hard) — strengthened

- A **never** receives, reads, or logs the `E2B_API_KEY` / redeemed value (Decision #104). Clause 4 uses
  leak-*class* matchers, so A needs no secret value; its `observed` output and every `failures[].reason`
  carry only SHAPE (ids, owner string, status, counts, matched-class name + field id) — **never a raw
  matched substring** (§8 BLOCKER 3). A test asserts no planted secret appears in the result or stdout.
- A is **read-only** (only `SELECT`s) and **tenant-safe**: it reads by run/attempt id and asserts
  `company_id` consistency across the run and its corroborating rows; it accepts an optional `expected`
  org/company to assert the run is the intended canary's (§8 MED 5). It widens no RLS/scope.
- **No key crosses the port.** The drizzle adapter returns scan-surface text already fetched; the service
  matches patterns over it and discards it.

---

## 7. Open questions for the implementer (grounded, narrow)

1. Confirm the exact `job_events`/`job_attempts`/`leases`/`job_projection_receipts` column + enum names when
   writing the adapter (status values verified: `job_attempts_status_check` includes
   `leased/running/succeeded/cancelled`; `projection_kind='attempt_terminal'`, `status='applied'`). Ground
   each clause-5 `SELECT` against the live schema as step 0.
2. Confirm the run-summary `issue_comments` linkage for a distributed run (how the projector's run-summary
   comment is keyed to the run) so clause 4 can scan it; if the linkage is indirect, scope it as
   SHOULD-surface rather than a required scan.
3. Confirm `redactSecretsInString` is the right shared matcher to import for clause 4's provider-key arm, or
   whether the explicit E2B + literal arms should live in A to keep A's matcher set auditable in one place.

## 8. Review round — three-agent adversarial pass (2026-08-28)

Dispatched three independent reviewers (grounding skeptic · completeness critic · design/security/test),
each told to verify against source and refute. Findings, and how v2 answers each:

**VERIFIED SOUND (survived refutation) — kept unchanged:**
- **Clause 1** — sole writer `buildHandoffRunPatch` throws on any legacy owner and is reached only before
  `adapter.execute`; only `null`/`"distributed"` ever persist; not copied on retry. Strict `=== "distributed"`
  is correct and cannot bless a legacy run.
- **Clause 3** — `TERMINAL_RUN_STATUSES`/`isTerminalRunStatus`/`finished_at` confirmed verbatim.
- **`redactSecretsInString` idempotency** — the `***REDACTED***` marker matches no pattern → re-redaction
  is a no-op (so idempotency was never the issue; the *raw-at-rest premise* was).
- **Read-only / no-key / operational honesty** — build+test needs only fixtures; the real-run input is
  cleanly operator-time.

**BLOCKER 1 (completeness) — false-PASS on a never-leased handoff.** `execution_owner="distributed"` +
ids are stamped at handoff, before lease → an inert handoff passes clauses 1–4. **Verified in
`run-execution-owner.ts`.** → **v2 clause 5** (leased + started + projected corroboration).

**BLOCKER 2 (completeness) — clause 4 scanned the wrong table.** Distributed logs live in `job_events`,
not `heartbeat_run_events` (legacy-only). **Verified** (`heartbeat_run_events` written only by
`heartbeat.ts`; `job_events.event_type` includes `log`). → **v2 clause 4 surfaces**.

**BLOCKER 3 (security) — clause-4 reason could re-leak the secret.** → **v2 clause 4** reports match-class +
field id only, never the raw value; test asserts it.

**HIGH (grounding) — clause-4 re-redaction premise false (fields raw at rest; over-redactor → false
positives on clean runs).** **Verified** (`sanitizeForDb` = unicode strip; egress-only redaction; broad
pattern 7). → **v2 clause 4** uses leak-*specific* matchers (hard-fail) + advisory for broad heuristics.

**HIGH (design) — register claim wrong + shape/bin.** The risk is `check-guard-inventory`
(`/^(check|verify)-.+\.mjs$/`), not the census; canary-preflight uses a `{ store }` port with a separate
drizzle adapter and has **no CLI precedent**. **Verified** (`canary-preflight.ts:124` `{ store }`;
`canary-preflight-store.ts`). → **v2 §3** ({store} port + adapter + a concrete non-`scripts/` CLI).

**MED/LOW folded:** clause 2 softened (atomic with clause 1; binding not liveness); tenant binding +
`expected` assertion + fixture (h); explicit not-found result + fixture (i); clause-4 fixture must trip
the real matcher; scan `detected_outputs`; `job_attempts.status`-agnostic corroboration (my refinement:
the golden journey's deliberate cancel means final status can't gate — the leases/started/receipt trio
does); SHOULD-surface produced-artifact count; corroborate lease `revoked` on a cancelled terminal.

**Net:** clauses 1–3 are the validated fail-safe "not legacy" core; **clause 5 makes A prove the journey
actually ran** (closing the v1 false-PASS); clause 4 is now leak-specific, right-surfaced, and
non-leaking. Ready for the §9 implementation prompt.
