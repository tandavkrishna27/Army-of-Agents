# evidence-verifier A — result

**Status:** SHIPPED + CI-GREEN · **Worktree:** `C:\e3` · **Branch:** `docs/replatform-program`
**Start SHA (design v2):** `8da7d7d9e` · **Implementation SHAs:** `225e83f1f` (foundation) + `2cc204d91` (review fixes)
**CI:** run `33119607467` — `ci-required` **success**; all four `verify` shards green + e2e/e2e-pgvector/migrations/policy/brand-check/lint/distributed-contract/browser green.
**Slug:** `e7-1-evidence-verifier` (graph-inert — no `^[A-Z]{2,5}-\d{3}` id, so no ticket-graph node; mirrors `BRW-hostspawn-gate`).

> **A flips NO gate.** `scripts/gate-clause-wiring.json`'s `E7-1-coding-journey` stays `unwired`.
> Building the acceptance harness does not promote E7-1; only an operator citing a real
> dispatched distributed run does (campaign plan §6).

---

## 1. What shipped

A read-only verifier that mechanizes the E7-1 promotion rule. It reads a dispatched heartbeat run
**and its distributed-kernel evidence** and exits non-zero, naming the failing clause(s), unless the run
is **provably the distributed journey** — a worker leased it, ran it, and its terminal was projected.

Mirrors `canary-preflight.ts` exactly (pure `{ store }` service + separate drizzle adapter + thin CLI):

| File | Role |
|---|---|
| `server/src/services/e7-distributed-run-verifier.ts` | **Pure service** — `createE7DistributedRunVerifier({ store })`; NO drizzle import. Clause logic + leak scanner + `formatVerifyResult` printer. |
| `server/src/services/e7-distributed-run-verifier-store.ts` | **Drizzle adapter** — `createDrizzleE7RunVerifierStore(db)`; the ONLY file importing schema. All read-only `SELECT`s. |
| `server/src/cli/verify-e7-1-distributed-run.ts` | **CLI** — `tsx …/verify-e7-1-distributed-run.ts <runId> [--org …] [--company …]`; package.json script `verify:e7-1-distributed-run`. Prints per-clause verdict + `observed` + a `verdict-json:` line; `process.exit(ok ? 0 : 1)`. |
| `server/src/__tests__/e7-distributed-run-verifier.test.ts` | 23 pure store-fixture units (design §4 a–j + edges). |
| `server/src/__tests__/e7-distributed-run-verifier-terminal-contract.test.ts` | 1 drift guard pinning clause 3's terminal set to `heartbeat.ts`. |

**Placement is register-safe:** the CLI is `server/src/cli/*.ts` (NOT `scripts/(check|verify)-*.mjs` → does
not trip `check-guard-inventory`), and the tests are `*.test.ts` (NOT `*.test.mjs` → do not trip
`check-execution-census`). Confirmed: all five registers PASS (see §5).

### The five clauses (design v2 §2), grounded against live schema (STEP 0)

1. **Ownership** — `heartbeat_runs.execution_owner === "distributed"` (strict). Sole writer
   `buildHandoffRunPatch` throws on any non-distributed owner; only `null`/`"distributed"` ever persist.
2. **Evidence binding** — `distributed_job_id` AND `distributed_attempt_id` both set.
3. **Durably terminal** — `isTerminal(status)` AND `finished_at` set. Terminal-**agnostic** (the golden
   journey ends in a deliberate `cancelled`; `failed`/`timed_out` accepted, safe only because clause 5
   corroborates). Local `E7_TERMINAL_RUN_STATUSES` is pinned to `heartbeat.ts` by the contract test.
4. **No leaked secret** — leak-**class** matchers (provider-key `sk-`/`sk-ant-`, explicit `e2b_` +
   literal `E2B_API_KEY[=:]`, connection-string URIs, PEM) over the run's real surfaces
   (`job_events` payloads + `heartbeat_runs` raw fields + `task_outputs` + `job_artifacts`). Broad
   `<prefix>_<20+>` heuristic is **advisory only** (never a hard fail — it false-positives on session
   ids/hashes on a clean run). A failure reports `{surface, fieldOrEventId, matchedClass, count}` —
   **never the raw match** (Decision #104).
5. **Journey corroboration** (the anti-false-PASS clause — the whole reason v2 exists) — via
   `distributed_attempt_id`, tenant-matched on `company_id`, require: a same-tenant/same-job
   `job_attempts` row, ≥1 `leases` row, ≥1 `attempt_started` `job_event`, ≥1 `terminal` `job_event`,
   and an **applied** `attempt_terminal` `job_projection_receipts` row. On a `cancelled` terminal,
   additionally require a `revoked` lease (fence revoked). Terminal-agnostic on the attempt's own final
   status (the deliberate cancel means it cannot gate).

### STEP-0 schema grounding (no design premise invalidated)

Confirmed exact columns/enums before writing the adapter:
- `job_attempts.status` check includes `leased/running/cancel_requested/cancelled`; `id` IS the attempt id (no separate column). `company_id`/`organization_id`/`job_id` NOT NULL.
- `leases.status` includes `revoked`; `company_id` is **nullable** at the kernel level (handled: tenant filter allows `null` or `=run.company_id`).
- `job_events.event_type` includes `attempt_started`, `log`, `terminal`; `event` jsonb; keyed by `attempt_id` (NOT NULL).
- `job_projection_receipts.projection_kind` includes `attempt_terminal`; `status` ∈ `{pending, applied}`.
- `heartbeat_runs` has **no `organization_id`** (only `company_id`) → `observed.organizationId` resolves via the attempt row (`job_attempts.organization_id`). Design §8 MED 5 already anticipated this.
- `issue_comments` has **no run linkage** (issue-scoped, `authorType='system'`) → run-summary scan is indirect; scoped SHOULD-surface (see §6 limitations).

---

## 2. Fixture + mutation table

24 tests, all green (23 unit + 1 contract). Pure store-fixture units (no embedded-PG, no drizzle) — exactly like
`cli-006-canary-preflight.test.ts`.

| Fixture | Setup | Expected | Verified |
|---|---|---|---|
| a | golden: distributed owner, both ids, `cancelled`+finished, leased+started+projected+revoked, clean | PASS | ✅ |
| b | (a) but `execution_owner=null` | FAIL 1 | ✅ |
| c | (a) but a dist id null | FAIL 2 | ✅ |
| d | (a) but `status="running"`, `finished_at=null` | FAIL 3 | ✅ |
| e | (a) but a `job_events` log payload leaks `sk-ant-…` (asserts `redactSecretsInString` matches it) | FAIL 4 | ✅ |
| f | (a) but `stdout_excerpt` leaks `E2B_API_KEY=e2b_…`; raw value appears NOWHERE in result/print | FAIL 4 | ✅ |
| g | **v1 false-PASS:** distributed handoff, both ids, cancelled+finished, clean — but no lease/started/receipt | FAIL 5 | ✅ |
| h | (a) but attempt row is a different `company_id` | FAIL 5 (tenant) | ✅ |
| i | `runId` absent | `notFound=true`, no throw | ✅ |
| j | (a) but `status="failed"` with an error | PASS, `observed.status="failed"` | ✅ |

Plus edges: cancelled-without-revoked-lease → 5; missing `attempt_started` → 5; pending (not applied)
receipt → 5; cross-tenant receipt → 5; attempt job-binding mismatch → 5; broad token = advisory (PASS);
bare `e2b_<16+>` (no assignment prefix) → 4 (the `e2b_key` arm in isolation); connection-string URI → 4; no-planted-secret-in-output (with a clause-4 positive control); `expected` org/company mismatch → identity;
read-only surface (only the 7 read methods called).

### Mutation discipline (each fixture reddens for EXACTLY one clause)

**Positive control first:** an always-bless stub reddened all 20 discriminating tests (the 2 PASS
fixtures pass trivially) — proving the suite exercises the logic. Then, hand-DELETING each clause (not
rewriting) and re-running:

| Clause deleted | Tests that redden | Mapping |
|---|---|---|
| 1 | `(b)` only | b→1 ✅ |
| 2 | `(c)` only | c→2 ✅ |
| 3 | `(d)` only | d→3 ✅ |
| 4 | `(e)`, `(f)`, bare-`e2b_`, connection-string, no-leak | e/f→4 ✅ |
| 5 | `(g)`, `(h)`, all clause-5 edges + `expected` | g/h→5 ✅ |

No fixture reddens for a clause it does not target. **Anti-vacuity:** the clause-4 fixtures plant
values the chosen matcher actually catches (`redactSecretsInString(v)!==v` asserted in-test for the
provider-key; the E2B arms verified against A's own regex) — closing the programme's signature defect.

---

## 3. Security (Decision #104)

- A **never** receives, stores, or prints the E2B key / redeemed value. Clause 4 uses leak-**class**
  matchers over raw-at-rest text and stores only the match **count** (`String.match(...).length`); the
  matched substring is discarded. Every `failures[].reason` and every `observed` field carries SHAPE only.
- The "no planted secret in output" test asserts no planted value appears in `JSON.stringify(result)` or
  `formatVerifyResult(result)`.
- No key value crosses the store port; the adapter returns already-fetched scan text, the service matches
  and discards it. A is read-only (only `SELECT`s) and widens no RLS/scope.

---

## 4. Adversarial review

Four INDEPENDENT reviewers (read-only, verify-against-source, one per dimension changed), run at
`225e83f1f`. Then the one surviving finding was reproduced and fixed.

| Dimension | Verdict |
|---|---|
| Clause soundness (1/2/3/5 — false-PASS core) | **No findings.** Verified clause 5 is DB-GUARANTEED: a `job_events` `attempt_started`/`terminal` row cannot exist without a real worker lease (composite `leaseFk` → non-null-company `leases` → `authorityAtomic` requires `worker_id`), so an inert never-leased handoff cannot forge it. `bothIds` = exact negation of clause 2 (no null-id bypass); clause 1 unforgeable (sole writer throws on legacy). |
| Clause 4 security + leak specificity | **No reproducible leak/vacuity.** Only match COUNTS stored (never substrings); matchers mirror `redaction.ts`; no `lastIndex` bug (only `String.match`); broad heuristic structurally advisory-only. |
| Adapter vs live schema | **No findings.** Every SELECT verified against schema; `workspace_patch`/`committed` literals confirmed against real writers + an integration test; RLS fail-safe direction confirmed. |
| Test anti-vacuity | **1 MEDIUM (fixed) + 2 LOW (fixed).** |

**MEDIUM — the `e2b_key` value arm was vacuously covered (FIXED + re-verified).** Every E2B fixture
planted `E2B_API_KEY=e2b_…`, which trips BOTH the `e2b_key` value arm AND the `e2b_api_key_assignment`
arm; since clause 4 fires on either, deleting the `e2b_key` arm was a **surviving mutant** (reproduced:
the suite stayed green). A bare/infix `e2b_<16+>` value in a `job_events` payload would have escaped —
a Decision #104 leak class. **Fix:** exported `detectHardLeakClasses` (auditable, class-names-only, uses
`String.match` to avoid the `lastIndex` bug) + added a bare-`e2b_` fixture that asserts the value trips
`e2b_key` and NOT the assignment/provider arms, then fails clause 4. **Re-verified:** deleting the
`e2b_key` arm now reddens exactly that fixture (mutant KILLED); the one-clause-per-fixture mapping still
holds (clause-4 deletion reddens only clause-4 tests).

**LOW — the "no planted secret" test had no positive control (FIXED):** it now asserts `ok===false` +
≥2 clause-4 hits fired, so it cannot pass vacuously (confirmed: clause-4 deletion reddens it).
**LOW — the read-only test title overstated (FIXED):** retitled to "consults all 7 read evidence sources
and drops none" (the port exposes no mutating member by type; the test guards against a dropped source).
**LOW (security reviewer) — adapter `issue_comments` comment imprecise (FIXED):** tightened to note the
one existing run↔comment pointer (`issueCommentSatisfiedByCommentId`) is the reverse ask-human-ANSWER
link, not a run-summary key, and is unused in `server/src`.

No HIGH/BLOCKING finding survived, so no skeptic-refutation pass was required (a skeptic is spawned only
to attack a HIGH/BLOCKING claim); the one MEDIUM was reproduced, fixed, and re-verified directly.

---

## 5. Registers + build

All five registers PASS (run at `225e83f1f`):

```
check-ticket-graph-coverage  PASS   (graph-inert slug — no program-design node needed, confirmed)
check-finding-ownership      PASS
check-guard-inventory        PASS   (CLI is server/src/cli/*.ts, not scripts/(check|verify)-*.mjs)
check-gate-clause-wiring     PASS   (E7-1-coding-journey untouched — stays unwired)
check-execution-census       PASS   (tests are *.test.ts, not *.test.mjs)
```

- `pnpm --filter @armyofagents/server typecheck` → exit 0.
- `pnpm exec vitest run …e7-distributed-run-verifier*.test.ts` → 24 passed (23 unit + 1 contract).
- CLI smoke: no args → exit 2 + usage; runId without `DATABASE_URL` → exit 2.

---

## 6. Claims I could NOT fully prove (honest limits)

1. **The drizzle adapter's SQL is not exercised by a unit test** (it is operator-time; the pure service
   is fully fixture-tested). Its correctness rests on STEP-0 schema grounding + typecheck + the review.
   No embedded-PG integration test was added (the design mandates pure store-fixture units).
2. **`issue_comments` run-summary body is not scanned.** The table has no run linkage (issue-scoped,
   `authorType='system'`), so attributing one to a specific distributed run is indirect and would risk a
   cross-run false HARD-fail. Its leak-relevant content (detected files, error) is already scanned at its
   SOURCE (`heartbeat_runs.detected_outputs` + `task_outputs` + `run.error`). Scoped SHOULD-surface per
   design §7 open-Q2. **Claim:** nothing leak-relevant is lost by the omission — plausible but not proven
   for every projector path.
3. **`task_outputs.createdByRunId` for a distributed run** is set by the JOB-014 job-output-bridge from
   the projected payload (`job-output-bridge.ts` `createdByRunId: input.output.createdByRunId ?? null`).
   If a projector path leaves it null / not equal to the heartbeat `run.id`, the `task_outputs` scan
   surface and produced-count would UNDER-count. Both are advisory/SHOULD-surface and the gate does not
   depend on them (clause 4 still hard-fails on `job_events` + `heartbeat_runs` surfaces), so this
   degrades coverage, not soundness. Not fully traced end-to-end.
4. **RLS:** the distributed kernel tables carry FORCE RLS + the `aoa_app` policy. The adapter uses plain
   `createDb` selects. If the operator's `DATABASE_URL` role cannot see the run's tenant rows, clause 5
   fails **safe-closed** (missing corroboration → refuse to bless, never a false PASS). Verified the
   direction is safe; NOT verified which operator role/context is correct in staging (operator concern).
5. **Clause-3 drift** is guarded by a contract test, and a drift would fail **safe** (over-strict
   refusal), never a false PASS.
6. **E2B infix form.** The `e2b_key` arm catches a bare `e2b_<16+ contiguous alnum>` value (now tested in
   isolation). A non-assigned INFIX form with an internal underscore (`e2b_live_<…>`) is caught by the
   `e2b_api_key_assignment` arm ONLY when written as `E2B_API_KEY=…`; a bare `e2b_live_…` in free text
   would trip the broad heuristic (advisory), not a hard class. No such E2B shape is pinned in the tree
   (real keys are `e2b_<hex>`), so no concrete miss is reproducible — noted as the known edge of the
   leak-CLASS backstop (A cannot detect an opaque token with no recognizable shape; the value-planted
   case is covered at write/egress time by the `E5-5-redaction` canary — design §2 clause 4).

---

## 7. Disposition

E7-1-coding-journey stays `unwired`. When an operator dispatches a real-E2B distributed coding run on a
live staging fleet, they run `pnpm verify:e7-1-distributed-run <runId> [--org …] [--company …]`; a green
(exit 0) is a **necessary** precondition they cite (with the run id) in the gate-flip `reason`, alongside
the full-journey observation + non-canary isolation that remain theirs (campaign plan §6; runbook §4/§5).
A green here does not by itself promote E7-1.
