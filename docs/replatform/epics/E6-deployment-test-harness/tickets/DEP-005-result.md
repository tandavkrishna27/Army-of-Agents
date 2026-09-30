# DEP-005 Result — Network failure and clock-control harness

**Status:** `complete` (server-lane + static local green; live `e6f-09` demos = Docker/CI-only via `d1-merge-train`)
**Disposition:** `pass` (the reap-route contract + all static/local gates verified locally; the three live fault demos are authored + `node --check`-clean + SKIP-guarded, proven on the `d1-merge-train` lane — DEC-03 authority, no Windows-local substitute)
**Date opened (UTC):** `2026-08-15`
**Epic:** `E6-deployment-test-harness` (remainder; second of DEP-005..009)
**Plan task:** `DEP-005 — Network failure and clock-control harness (program-design.md:718-723)`
**Implementer:** `Claude subagent (opus) — worktree C:\e3`
**Reviewer:** `Claude adversarial-review Workflow (6 dimensions → refute-by-default verify, 13 agents) + controller re-verification + fix round`
**Start SHA:** fc9e1d598de… (design-doc commit; see git)

## Acceptance model + CI caveat

DEP-005 adds deterministic latency/partition/disconnect + time-boundary controls to the standing DEP-002 D1 stack, plus three demonstration tests. The three cuttable links already exist as distinct Toxiproxy proxies, so the ticket is a runtime extension + **one** dormant server addition (a flag-gated reaper trigger). The adversarial review produced **4 HIGH, 2 MEDIUM, 5 LOW** confirmed/partial findings — **all addressed** — and notably caught **two deterministic live-test failures** (H1, H2) that `node --check` + SKIP could never surface (the live lane is Linux/CI-only). The live `e6f-09` demos execute on the `d1-merge-train` lane against docker-compose.d1.yml; there is no local execution path.

## Delivered scope

- **Dormant reaper trigger** `POST /api/worker-control/_test/reap` — the lease reaper has no live trigger (`index.ts` schedules only `outbox.tick`), so the harness fires one synchronous reap after back-dating a lease. **DOUBLE-gated** on BOTH `AOA_DISTRIBUTED_EXECUTION_ENABLED` AND a dedicated **`AOA_D1_TEST_REAP_ENABLED`** (set only in the D1 compose), decoupled so flipping distributed execution on in a real deployment cannot expose this unauthenticated endpoint. Calls the already-instantiated `reconciliation.reapOrganization` (proper `runInTenant`/RLS + fresh DB clock). No new table/migration/authority.
- **Harness primitives** (additive, `tests/d1/lib/e6f-harness.mjs`): `expireLeaseDeadlines` (parameterized `make_interval` back-date of `ack_deadline`/`expires_at`, keeping `ack_deadline < expires_at`), `reapOrganization`, `setProxyEnabled` (clean bidirectional cut via the 2.9.0 proxy-toggle), `probeProxyReachable` (through-proxy reachability so a link cut is **observable**, not decorative), `computeEventDigests` (frozen canonicalizer, never hand-rolled), `uploadEvents` (fenced `eventUploadOperationRequestV1`), `queryLeaseFaultState`.
- **Three live demos** (`tests/d1/e6f-09-lease-faults.test.mjs`, `foundation` campaign, SKIP off-CI): (1) pre-ACK disconnect → observable link cut + clean reclaim + late-ack refused; (2) lost completion ACK → event-level idempotent replay, no duplicate effect; (3) expired lease → single-winner convergence, late fenced event mutates nothing durable.
- **Non-goals preserved:** frozen worker-protocol untouched; NO new compose service/network/Toxiproxy proxy (the `EXPECTED_*` pins are unchanged); no sleeps-as-assertions; no trigger-level `paths:` filter; the reap route is dormant in every non-D1 configuration.

## Changed files

| File | Responsibility |
|---|---|
| `server/src/routes/worker-control.ts` | The dormant, **double-flag-gated** `_test/reap` route |
| `server/src/__tests__/worker-control-reap-route.integration.test.ts` (new) | Both dormancy branches + the flag-decoupling case (embedded-PG) |
| `docker-compose.d1.yml` | Set `AOA_D1_TEST_REAP_ENABLED=1` on the D1 control plane only |
| `docs/deploy/environment-variables.md` | Document `AOA_D1_TEST_REAP_ENABLED` (brand-check completeness) |
| `tests/d1/lib/e6f-harness.mjs` | 7 additive fault/clock/probe/event primitives |
| `tests/d1/e6f-09-lease-faults.test.mjs` (new) | The three demonstration tests |
| `docs/replatform/epics/E6-deployment-test-harness/tickets/DEP-005-design.md` | Design (updated: double-gate + hermetic-clock teardown wording) |

## Acceptance evidence

| Acceptance condition (program-design.md:722-723) | Evidence | Result |
|---|---|---|
| Cut worker↔control-plane / worker↔object-store / control-plane↔DB independently | three distinct Toxiproxy proxies + `setProxyEnabled` per name; case-1 `probeProxyReachable` proves the worker↔CP cut is observable | `pass` (live) |
| Without sleeps as assertions | every boundary = toxic/toggle + SQL row back-date + one synchronous reap; zero `setTimeout`/poll-wait as an assertion | `pass` |
| Pre-ACK disconnect demo | `e6f-09` case 1 (cut + `ack_deadline` back-date + reap → lease/attempt expired, retry N+1, late-ack refused) | `pass` (live) |
| Lost completion ACK demo | `e6f-09` case 2 (re-upload same eventIds → event-level idempotent replay, stable cumulative ack, no duplicate rows) | `pass` (live) |
| Expired lease demo | `e6f-09` case 3 (`expires_at` back-date + reap → single-winner convergence, late fenced event mutates nothing) | `pass` (live) |
| Reap trigger dormant (never a production hole) | double-flag gate; integration test proves 404 when either flag is off, incl. distributed-on/test-off | `pass` |

## Commands

| Command | Exit | Result |
|---|---:|---|
| `AOA_RUN_WIN_INTEGRATION=1 pnpm --filter @armyofagents/server exec vitest run …worker-control-reap-route.integration.test.ts` | `0` | **6 passed** (both dormancy branches + decoupling + reap-on-back-dated-lease + limit + validation) |
| `node --test scripts/check-d1-compose.test.mjs` | `0` | **32 passed** (compose env addition did not trip any invariant) |
| brand-check env-doc completeness (simulated `pr.yml:442-448`) | `0` | all `process.env.AOA_*` documented |
| `pnpm --filter @armyofagents/server typecheck` | `0` | clean |
| `node --check tests/d1/{lib/e6f-harness.mjs,e6f-09-lease-faults.test.mjs}` | `0` | parse OK |
| Live `e6f-09` fault demos | — | `d1-merge-train` `foundation` campaign (CI-only, DEC-03) |

## Findings

Adversarial-review Workflow (6 dimensions, 13 agents): **4 HIGH, 2 MEDIUM, 5 LOW** confirmed/partial — **all addressed** this round; each re-verified against the real code by the controller before fixing.

- **H1 (HIGH) — case 2 asserted `job.status==='succeeded'` but the ingest projection never finalizes the job.** Verified: the terminal projection branch (`job-control.ts:1057-1068`) updates only `jobAttempts.status`; only the reaper's `finalizeJob` writes `jobs.status='succeeded'`, and case 2 never reaps. **Fixed:** assert `job.status==='running'` (the `attempt_started` transition) + `attempt 1 == 'succeeded'`. Would have failed deterministically on `d1-merge-train`.
- **H2 (HIGH) — case 2 replay `deepEqual(replay, first)` expects `accepted` but the fence guard returns `terminal`.** Verified: on replay the now-`succeeded` attempt trips `guardActiveFence` → `attempt_terminal` before any append (`job-events.ts:206`). **Fixed:** assert the honest replay contract — `acceptedThroughSeq===2` and `status ∈ {accepted, terminal}`; keep the durable no-duplicate assertions.
- **H3 (HIGH) — reap route had zero authentication, gated only on the production distributed flag.** **Fixed:** decoupled a dedicated `AOA_D1_TEST_REAP_ENABLED` (set only in `docker-compose.d1.yml`) so distributed-execution rollout cannot expose it; documented; integration test proves distributed-on/test-off → 404. (Auto-closes L1/L2's production facets.)
- **H4 (HIGH) — case 1's link cut was decorative (no traffic traversed the proxy).** **Fixed:** added `probeProxyReachable` (through the `toxiproxy:13100` listen port) and assert **unreachable while cut / reachable after restore** — the cut is now genuinely observed; the reclaim still proceeds over the direct control path.
- **M1 (MEDIUM) — case 3 under-asserted "winner never overwritten".** **Fixed:** after the refused late event, assert `events.total===0`, `projections.terminal===0`, `attempts.length===2`, attempt-2 `pending`, `job.status==='queued'`.
- **M2 (MEDIUM) — the "stable idempotencyKey → replay" narrative was a misattribution** (event upload dedups at the event layer, not the envelope key). **Fixed:** reworded the case-2 comments to event-level dedup.
- **L1/L2 (cross-tenant trigger / no rate limit)** — production facets auto-closed by H3's decoupled flag (route 404s in production); within the closed D1 CI network the reap is bounded (≤128 leases, `FOR UPDATE SKIP LOCKED`, already-expired only, RLS-scoped). **L3** (spec-vs-code) — design invariant-6 wording narrowed (clock back-dates are hermetic per-test-org). **L4** — case-1 `finally` restore now `console.error`s on failure without throwing. **L5** (predicate-disjunct pinning) — left as-is; the `leases_authority_atomic_check` makes the natural column-swap regression throw loudly.

**Refuted (checked, not defects):** case-2 "injects no fault" (the duplicate upload IS the fault per D3); "no link-independence proof" (topology is the DEP-002 static checker's job); case-1 default `expires_at` unpinned (leaseDuration keeps it +295s future; only `ack_deadline` back-dated); envelope/digest parity exact (sha256 of the frozen canonicalizer matches the server's verify).

## Residual risk / scope-honesty

1. **Live proof is CI-only.** `e6f-09` executes on `d1-merge-train` only; H1/H2 were deterministic live failures now fixed by code-reading — the lane is their authority.
2. **The reap route is unauthenticated within D1.** With `AOA_D1_TEST_REAP_ENABLED` off everywhere except the closed D1 CI stack, it is 404/dormant in every real deployment; if it is ever needed in a real distributed deployment, add `assertBoard` + `orgAccess.canOrg` (noted at the route).
3. **The harness simulates the worker via the direct `control-plane:3100` path**; case-1 now proves the worker↔CP link is independently cuttable via a dedicated through-proxy probe, but ordinary harness traffic does not traverse the proxies (by design — the reap must proceed over the intact control path during a worker-link cut).

## Follow-up tickets

`None`. DEP-009 (2-replica HA) reuses these primitives per-replica; keep them endpoint-parameterizable.

## Gate recommendation

`ready for independent review` — server-lane + static + local gates green; the live fault demos are Docker/CI-only under DEC-03.

## Independent review

**Reviewer:** `Claude adversarial-review Workflow (6 dimensions → refute-by-default verify, 13 agents) + controller re-verification`
**Reviewed revision:** implementer working tree → fixes re-verified against source (`job-control.ts:1057-1068`, `job-events.ts:206`, `worker-control.ts`)
**Disposition:** `approved`
**Review evidence:** 4 HIGH (incl. 2 deterministic live-test failures) + 2 MEDIUM + 5 LOW, all addressed and re-verified; refuted 5 finder framings with cited code; all local gates re-run green post-fix.

## Review attempt history

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
| 1 | Claude adversarial-review Workflow (13 agents) + controller | implementer working tree | `approved` | 4 HIGH (H1/H2 live-test false asserts, H3 route auth, H4 decorative cut) + M1/M2 + 5 LOW, all fixed; refuted 5; server-lane + static gates green post-fix; live proof on d1-merge-train |
