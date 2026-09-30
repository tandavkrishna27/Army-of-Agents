# JOB-012 — Preserve budget and authoritative cost policy — result

**Result:** `pass`
**Revision:** authored on `docs/replatform-program` (after JOB-011)
**Date (UTC):** `2026-08-14`
**Acceptance:** `pnpm -r build` (clean, EXIT 0, all packages incl. db/shared/server/ui/cli). `AOA_RUN_WIN_INTEGRATION=1 pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-budget-cost-parity.integration.test.ts` = **13 passed** (incl. the post-review `[exhaustion sibling]` regression). `pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-control-legacy-grants.contract.test.ts src/__tests__/job-fence-surface.contract.test.ts` = **15 passed** (**7** legacy-grants KEYSTONE UNCHANGED + **8** fence-surface). `pnpm --filter @armyofagents/db exec vitest run src/__tests__/migration-idempotency.test.ts` = **5 passed / 1 skipped** (static IF-NOT-EXISTS lint over `0242`/`0243`; the embedded-PG apply runs in every integration `beforeAll`). `tsc --noEmit` green for both `@armyofagents/server` and `@armyofagents/db`. Regression suites GREEN: `costs-service`(24) · `budget-hooks`(13) · `budget-validators`(13) · `one-shot-cli-budget`(13) · `aoa-budget-autopause`(12) · `org-concurrency`(3) · `dispatcher-budget-preflight`(2) · `crew-cost-model` · `run-cost-rate-model` · `crew-cost-caps` · `crew-budget-wired` · `finance-service` · `one-shot-sandbox-cli` · `dispatcher-autonomy-failclosed` · `company-portability-budget-policies` · `company-portability-cost-events`. On Windows the `.integration` file runs under `AOA_RUN_WIN_INTEGRATION=1`; **Linux CI is the formal green authority** (DEC-03).

## Outcome

`job-budget-cost-bridge` makes a DISTRIBUTED attempt's ACCEPTED usage event priced by the EXISTING budget/cost authority **EXACTLY ONCE**. The worker event supplies **bounded usage units only** (`usagePayloadV1Schema` is `.strict()` and rejects every price/rate field); the SERVER resolves provider/model/biller/billing-type/rate/version/rounding via a NEW versioned **fail-closed** resolver, charges the EXISTING cost writer once (`costService.createEvent` for agent-bearing `task_run`; the agent-less `recordOneShotCliCost` for every other source), stamps `cost_events.project_id` so DEPARTMENT policies observe the spend, writes a JOB-005 `authoritative_cost` projection RECEIPT linking the `cost_events` row to the attempt, drives the EXISTING budget engine **synchronously** (warning/incident/pause/emit at agent+company+department scope), and on a NEW hard-stop breach drives the EXISTING `requestCancellation` (which releases the Organization capacity slot exactly once — JOB-007 owns admit/release). It invents no parallel ledger, no worker-supplied pricing, no second capacity-release engine, and relaxes no hard stop. **Flag-off leaves every current path byte-unchanged** — every entrypoint throws `JobBudgetCostBridgeDisabledError` before any effect; the rollback gate throws `JobBudgetCostBridgeRollbackPendingError` while an `authoritative_cost` receipt is still pending, so disabling can never erase or skip an authoritative charge.

## Rate-resolution decision — a NEW versioned, FAIL-CLOSED resolver (no `jobs` pricing column)

The worker usage event carries **no** model/provider, and there is **no** server-owned LLM-rate binding on the job today. Per the resolved design I built a NEW resolver used ONLY by the bridge — `server/src/services/job-authoritative-rate.ts` — and left `cost-model.ts computeCostCents` (and its legacy heartbeat/one-shot callers) **fail-open (DEFAULT_RATE) untouched**.

- **Model resolution source** (best-available immutable-ish fact): `task_run` → the source-owning agent's `adapter_config.model` (+ `adapter_type` as provider); `crew_run` / `commander_turn` → the company crew/Commander config (`internal_agent_config`, crew prefers `crew_model`); `one_shot` / `service_reconcile` / `browser_request` → the company workload default (`internal_agent_config.model`).
- **Returns** `{ provider, model, biller, billingType, rateId, rateVersion, roundingMode, costCents }`; `rateId` = the model key, `rateVersion` = `AUTHORITATIVE_RATE_VERSION` (1), `roundingMode` = `"round_half_up_cents"` (matches `Math.round`).
- **Fails closed**: an unresolvable model, or one absent from the KNOWN rate set, throws `JobBudgetCostRateError` **before any write** (0 cost_events, 0 receipts). The resolver gates on the additive `isKnownRateModel` export FIRST, so the `computeCostCents` it calls afterwards can only ever hit a KNOWN rate — DEFAULT_RATE is unreachable on this path.
- **No `jobs` pricing-snapshot column.** Snapshotting an immutable `{provider,model,rate…}` onto the job at submission (so a later config change cannot re-price an in-flight job) is a documented **follow-up** (arguably JOB-009 placement territory) and is outside this ticket's "schemas ONLY for department + rate/version/rounding + idempotency key" scope.

## Receipt-before-charge proof (exactly-once) + release-once proof

- **Receipt fast-path behind the fence lock.** `priceAcceptedUsage` runs ONE `runInTenant` tx that: (1) `lockActiveFence(fence)` FOR UPDATE (writes nothing) so two concurrent same-event charges serialize; (2) reads the `authoritative_cost` receipt by `source_identity = cost:{company}:{eventId}` — a hit returns `status:"replayed"` with the already-linked `costEventId` WITHOUT a second charge; (3) fail-closed rate resolve; (4) charge once; (5) `recordGovernedProjection` writes the receipt `applied` in the SAME tx. The cost writers have NO native dedup, so the receipt is the sole replay guard — belt-and-suspenders is the NEW `cost_events (company_id, source_idempotency_key) WHERE source_idempotency_key IS NOT NULL` partial unique. Proven by `[replay]` (2 calls → 1 charge, 1 receipt) and `[retry attribution]` (2 distinct events → 2 charges with distinct keys; replay adds none).
- **Release exactly once, no second engine.** The exhaustion "stop" is realized ONLY through the existing `requestCancellation` (→ `releaseAttemptCapacitySlot`, an exactly-once `held→released` transition) — never a bridge write of `capacity_claim_state`. A static test asserts the bridge source contains no `releaseAttemptCapacity` / `capacityClaimState` / `capacity_claim_state` and DOES call `requestCancellation`. `createIncidentIfNeeded` was made race-safe (`ON CONFLICT DO NOTHING` on the open-incident unique + re-read → null), so a concurrent-exhaustion race yields exactly ONE incident (and thus one cancel) instead of aborting a tenant tx mid-charge. Proven by `[exhaustion]` (breach → 1 incident, 1 cancel, job `cancel_requested`; a 2nd charge does not re-cancel) and `[after-cost determinism]` (the incident is committed in the SAME tx — visible with no delay, distinguishing it from the legacy fire-and-forget).

## Failure matrix (`server/src/__tests__/job-budget-cost-parity.integration.test.ts`, 12 cases)

| # | case | assertion |
|---|---|---|
| 1 | worker price rejected | `usagePayloadV1Schema.safeParse({…,costCents})` = false; charge == `computeCostCents(resolved model, units)`; row carries `rate_id`/`rate_version=1`/`rounding_mode`/`source_idempotency_key=cost:{co}:{eventId}` |
| 2 | unknown rate | `JobBudgetCostRateError` thrown; **0** cost_events, **0** authoritative_cost receipts |
| 3 | replay | 2 calls same eventId → charged then replayed (same costEventId); 1 cost_event, 1 receipt |
| 4 | retry attribution | 2 distinct events → 2 charges w/ distinct keys; replaying event #1 adds none |
| 5 | exhaustion | breach → 1 hard_stop incident, 1 cancel control, job `cancel_requested`; 2nd charge no re-cancel |
| 6 | after-cost determinism | incident committed in the SAME tx (visible with no delay) + receipt `applied` |
| 7 | department scope | agent-less charge stamps `project_id`; a department hard-stop is observed + enforced |
| 8 | rollback gate | a PENDING `authoritative_cost` receipt → `assertRollbackSafe` throws; `applied` → passes; no cost_events erased |
| 9 | flag off | `isEnabled()=false`; `priceAcceptedUsage` throws `…DisabledError`; 0 cost_events, 0 receipts |
| 10 | admission scopes | `budgetAwareCapacityBridge.checkAdmission` admits when clear, denies at company/agent/department hard-stop |
| 11 | admission fail-closed | an unavailable admission dependency → `{admitted:false, reason:"unavailable"}` (never a silent admit) |
| 12 | no second release engine | static: bridge source has no capacity-release write, DOES call `requestCancellation` |

## Keystone note — POLICY_COUNTS / grants UNCHANGED (contract green)

The `aoa_app` legacy allowlist ALREADY covers the entire budget/cost charge path (`cost_events` SELECT+INSERT, `budget_policies`/`budget_incidents`, `projects` SELECT, `agents`, `companies`, `approvals`, `internal_agent_config` SELECT; `job_projection_receipts` all via the new-path grant). JOB-012 adds **NO** grant and **NO** RLS/policy: `0242` adds four nullable `cost_events` columns + a partial unique + a widened `job_projection_receipts` projection-kind CHECK (grants/RLS untouched — `cost_events` is a CAV-005 legacy non-forced table); `0243` RE-AFFIRMS the single existing `job_projection_receipts_tenant_isolation` policy (drop-before-create, ZERO new `CREATE POLICY`). `job-control-legacy-grants.contract.test.ts` (incl. the exact 20-table RLS / 19-table FORCE / **29-row POLICY_COUNTS** certificate) and `job-fence-surface.contract.test.ts` (closed governed-mutator surface — no new tenant-repo method added; bridge reuses `lockActiveFence`/`recordGovernedProjection`/`requestCancellation`) both stay green.

## Independent check + one fix applied

A 2-lane adversarial Workflow (money-correctness + release/race/keystone). Lane 2 (release-once / synchronous-eval / keystone) was CLEAN. **Lane 1 found one confirmed MEDIUM money defect — FIXED:** the bridge cancelled the attempt only when its charge *won* the one-incident-per-window insert (`evaluated.hardStopIncidentCreated`). A concurrent SIBLING job (different fence/tx) that crosses an already-breached cap gets `createIncidentIfNeeded → null` (dedup) → `hardStopIncidentCreated=false` → **was never cancelled → kept spending past the hard stop** (department scope also skips `emitBudgetExhausted`, so no fallback signal reaches a distributed attempt). **FIX:** `evaluateCostEvent` now also returns `hardStopBreached` (true whenever THIS charge's `observed >= amountCents` for an applicable hard-stop policy, independent of incident creation), and the bridge cancels on `hardStopBreached`. `requestCancellation` is idempotent, so cancelling every over-budget attempt is safe; the cancel `commandId` is now derived from the job (was `randomUUID()`) so repeated over-budget charges dedup to ONE cancel control (the JOB-011 finding-4 lesson). Regression: `[exhaustion sibling]` (a different job over an already-breached cap is cancelled with no new incident) — proven fail-first (`expected false to be true` on the pre-fix condition); the `[exhaustion]` same-job case updated to assert the 2nd charge re-confirms cancel idempotently with still ONE incident + ONE control command.

## Non-goals (honored)

No commercial billing/payment; no worker-supplied pricing; no parallel cost ledger (charges live on `cost_events`; provenance columns only); no relaxed hard stops; no second capacity-release engine (JOB-007 owns `admit`/`releaseAttemptCapacity` — the bridge reaches release ONLY via `requestCancellation`); no new runtime-decision/aggregate row for "budget_stop" (realized via incident+pause+`emitBudgetExhausted`+`requestCancellation`). Legacy callers retain their fail-open `computeCostCents` and fire-and-forget budget evaluation unchanged.

## Files created / modified

**Created**
- `server/src/services/job-budget-cost-bridge.ts` — the parity bridge: `priceAcceptedUsage` (fence-lock → receipt fast-path → fail-closed rate resolve → charge once → receipt applied → synchronous evaluate → exhaustion→cancel), `assertRollbackSafe`, flag gate + error classes.
- `server/src/services/job-authoritative-rate.ts` — the versioned fail-closed rate resolver (`resolveAuthoritativeRate`, `JobBudgetCostRateError`, `AUTHORITATIVE_RATE_VERSION`, `AUTHORITATIVE_ROUNDING_MODE`).
- `server/src/__tests__/job-budget-cost-parity.integration.test.ts` — the 12-case failure matrix (embedded PG).
- `packages/db/src/migrations/0242_tricky_network.sql` — `cost_events` provenance columns + partial unique + widened receipt CHECK (C14 idempotency-guarded).
- `packages/db/src/migrations/0243_job_authoritative_cost_rls.sql` — custom RLS re-affirm of `job_projection_receipts` (Decision #122; zero new policies).

**Modified**
- `packages/db/src/schema/cost_events.ts` — nullable `sourceIdempotencyKey`/`rateId`/`rateVersion`/`roundingMode` + partial unique `cost_events_source_idem_uq`.
- `packages/db/src/schema/job_projection_receipts.ts` — widen projection-kind CHECK to add `authoritative_cost`.
- `packages/db/src/repositories/tenant/job-control.ts` — widen `GovernedProjectionKind` union with `authoritative_cost`.
- `packages/shared/src/validators/budget.ts` + `packages/shared/src/types/budget.ts` — add `department` to the budget scope enum/types.
- `server/src/services/budgets.ts` — department branch in `getObservedCents`; `evaluateCostEvent` synchronous-callable (nullable agent + `projectId`, returns `hardStopIncidentCreated`); `getInvocationBlock` nullable agent + department branch; `listPolicies` department scope-name; `createIncidentIfNeeded` race-safe (`onConflictDoNothing`).
- `server/src/services/costs.ts` — `createEvent` gains `{ deferBudgetEvaluation }` (legacy fire-and-forget unchanged by default; new columns flow via `data`).
- `server/src/services/one-shot-cli-budget.ts` — `recordOneShotCliCost` threads `projectId`/`costCents`/`billingType`/`biller`/`sourceIdempotencyKey`/rate columns (optional; legacy callers unchanged).
- `server/src/services/org-concurrency.ts` — widen `CapacityBudgetBridge.checkAdmission` input; add `budgetAwareCapacityBridge`.
- `server/src/services/internal-agent/cost-model.ts` — additive `KNOWN_RATE_MODELS` / `isKnownRateModel` (does NOT change `computeCostCents`).
- `server/src/__tests__/budget-hooks.test.ts` — add `onConflictDoNothing` to the sequence-mock chain (no-op; matches the race-safe incident insert).

## Residual risks / follow-ups

- **Immutable pricing snapshot** on the job at submission (so a mid-flight config change cannot re-price) is deferred — documented above.
- **`admitAttemptCapacity` wiring** to `budgetAwareCapacityBridge` at the real distributed admit call site rides E3/E4 adoption; the bridge is injected via the existing `AdmitAttemptCapacityInput.budgetBridge` seam (unchanged admit/release). The parity test exercises `checkAdmission` directly (it reads only non-RLS budget tables) because `admitAttemptCapacity` reads RLS-forced `job_attempts` and must run under tenant org context.
- **Department budget on the LEGACY fire-and-forget path** is not enforced (only company/agent, as before) — `costService.createEvent`'s fire-and-forget was left byte-unchanged; department enforcement is driven where the bridge threads `projectId` and evaluates synchronously.
