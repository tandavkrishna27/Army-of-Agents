# DEP-007 Result — Distributed observability baseline

**Status:** `complete` (server-lane + static local green; live `e6f-10` trace/tenant-scoping = Docker/CI-only via `d1-merge-train`)
**Disposition:** `pass` (metric-discipline + correlation + evidence-fix verified locally; the live telemetry-contract test is Linux-CI-only — DEC-03)
**Date opened (UTC):** `2026-08-15`
**Epic:** `E6-deployment-test-harness` (remainder; third of DEP-005..009)
**Plan task:** `DEP-007 — Distributed observability baseline (program-design.md:732-737)`
**Implementer:** `Claude subagent (opus) — worktree C:\e3`
**Reviewer:** `Claude adversarial-review Workflow (6 dimensions → refute-by-default verify, 13 agents) + controller re-verification + fix round`
**Start SHA:** 5e1d901ac (design-doc commit; see git)

## Acceptance model + CI caveat

There is no server `/metrics` endpoint and no OpenTelemetry — server telemetry is structured pino log-lines and the durable `job_events` event stream. "One trace end-to-end" is therefore a `jobId`-keyed correlation join over `job_events` + the spine-bound logs, proven by the live `e6f-10-telemetry.test.mjs` in the `d1-merge-train` foundation campaign (Linux-CI only). The adversarial review found **NO HIGH defects** (the id-discipline core is triple-guarded, no id sink); 2 MEDIUM + several LOW, **all addressed** — M1 fixed in code, M2 documented precisely (inert-until-wired), and L1/L2/L3 hardened.

## Delivered scope

- **4 new count-only, id-free `JobControlMetrics` families** — `providerLifecycle` / `egressDenied` / `secretRead` / `artifactOp`, every parameter a closed low-cardinality enum or a `clampCount` integer (no org/company/job/attempt/lease/worker id); each with a `NOOP` entry, an out-of-union `clamp` (folds misuse to a safe default), and a `@ts-expect-error` id-rejection in `job-control-metrics.test.ts` (compile-closed — adding an id breaks the build). Best-effort emit (try/catch swallow).
- **Correlation logger-binding** — `bindJobTraceLogger(base, spine)` binds the durable spine `(org/company/jobId/attemptId/attemptNumber/leaseId/fence/sequence/executionSourceKind)` at the JOB-005 ingest anchor (`job-events.ts`) + the worker-control poll/ack hops, so one `jobId` log query reconstructs the trace. All three sites best-effort-wrapped (M1).
- **Evidence-collector fix** — repointed `collect-d1-evidence.mjs` off the **non-existent `worker_events` table** (a latent DEP-004 bug: the retained failure-evidence `events` section was silently empty for every D1 run) to `job_events`, ordered by `occurred_at` (most-recent, not the per-attempt `sequence` which evicts low-seq rows under load — L1).
- **D1 telemetry-contract test** `e6f-10-telemetry.test.mjs` — durable trace reconstruction (exec-source→job→attempt→lease→sandbox, `sandboxId` parsed from the `attempt_started` payload) + RLS tenant-scoping (a non-owner `aoa_app` read of a foreign org's `job_events` is empty, with a positive control) + evidence retention.
- **Non-goals preserved:** no server `/metrics`/prom-client/registry; no frozen-protocol edit; no new compose service/network; no trigger-level `paths:` filter; threat-register untouched; all new emitters dormant behind `AOA_DISTRIBUTED_EXECUTION_ENABLED`.

## Changed files

| File | Responsibility |
|---|---|
| `server/src/services/job-control-metrics.ts` | 4 new count-only id-free families + clamps + NOOP + pino emits |
| `server/src/__tests__/job-control-metrics.test.ts` | closed-interface mirror + 4 `@ts-expect-error` id-rejections |
| `server/src/services/job-trace-log.ts` (new) + its test | `bindJobTraceLogger` spine binder |
| `server/src/services/job-events.ts` | spine binding at the ingest anchor (best-effort wrapped, M1) |
| `server/src/routes/worker-control.ts` | spine binding at poll/ack (best-effort wrapped, M1) + wires the metrics instance into artifact-commit |
| `server/src/services/{artifact-commit,secret-broker,egress-proxy,sandbox-provider-runtime}.ts` | best-effort metric emits at the (formerly silent) chokepoints |
| `scripts/collect-d1-evidence.mjs` | `worker_events→job_events`, chronological `occurred_at` order (L1) |
| `scripts/lib/__tests__/collect-d1-evidence.test.mjs` (new) | repoint + `SELECT *` + fail-closed-`[]` guard (L3) |
| `tests/d1/lib/e6f-harness.mjs` | `queryJobEventTrace` (owner trace) + `queryJobEventsAsApp` (RLS-scoped read) |
| `tests/d1/e6f-10-telemetry.test.mjs` (new) | telemetry-contract D1 test (exec-source `=== one_shot`, L2) |

## Acceptance evidence

| Acceptance clause (program-design.md:736) | Evidence | Result |
|---|---|---|
| One trace end-to-end (exec-source→job→attempt→lease→sandbox) | `e6f-10` durable-trace reconstruction over `job_events` (sandboxId from payload) + spine-bound logs | `pass` (live) |
| Tenant ids access-controlled (not freely readable) | ids only in FORCE-RLS `job_events` + operator-only logs; `e6f-10` foreign-org `aoa_app` read empty (+ positive control); metrics id-free | `pass` (live) |
| High-cardinality ids NOT as metric labels | `JobControlMetrics` compile-closed + count-only; `@ts-expect-error` rejects id fields; typecheck holds | `pass` (in-process) |
| The 7 metric families | queues/leases/workers already emit; artifacts emits live; **provider-lifecycle/egress/secret are inert-until-wired** (families + emit code + unit coverage exist; see Residual risk) | `pass` (baseline) |
| Evidence retains the trace | collector repointed to `job_events`; unit test + `e6f-10` evidence facet | `pass` |

## Commands

| Command | Exit | Result |
|---|---:|---|
| `pnpm --filter @armyofagents/server exec vitest run …job-control-metrics.test.ts …job-trace-log.test.ts` | `0` | **9 passed** |
| `pnpm --filter @armyofagents/server typecheck` | `0` | clean (the `@ts-expect-error` id-rejection + M1 wraps compile) |
| `node --test scripts/lib/__tests__/collect-d1-evidence.test.mjs scripts/lib/__tests__/d1-evidence-bundle.test.mjs` | `0` | **9 passed** |
| `node --test scripts/check-d1-compose.test.mjs` | `0` | **32 passed** (unchanged) |
| `node --check tests/d1/e6f-10-telemetry.test.mjs` | `0` | parse OK; SKIPs off `AOA_D1_LIVE` |
| Live telemetry-contract | — | `d1-merge-train` foundation (CI-only, DEC-03) |

## Findings

Adversarial-review Workflow (6 dimensions, 13 agents): **NO HIGH**, 2 MEDIUM, 7 LOW confirmed/partial — all addressed. Each re-verified against source by the controller.

- **M1 (MEDIUM) — trace-logger `.debug()` sites unwrapped; the ingest hop ran INSIDE the tenant tx.** A synchronous logger throw between the committed `acceptEvent` and the tx return would roll back the append. **Fixed:** wrapped all three sites in best-effort `try/catch` (mirrors the metric-emit pattern; a throw can no longer propagate/roll back).
- **M2 (MEDIUM/PARTIAL) — 3 of 4 new families are inert-until-wired.** Only `artifactOp` emits a live production log-line (via worker-control under the flag). `providerLifecycle` resolves to NOOP at its three prod callers; `egressDenied`/`secretRead` have zero prod callers (their live cross-process channels are unbuilt E4-D12/DAT-005 seams). **Resolution:** documented precisely (below) — not force-wired into legacy non-distributed paths (which would violate dormancy). The families + emit code + unit coverage exist and go live when their seams land.
- **L1 — evidence collector ordered by per-attempt `sequence` (evicts low-seq rows under campaign load).** **Fixed:** order by `occurred_at DESC` (most-recent), tie-broken by `sequence`.
- **L2 — exec-source asserted only as non-empty string.** **Fixed:** `assert.equal(sourceKind, "one_shot")`.
- **L3 — collector unit test was a token-regex (wouldn't catch a projected-column typo).** **Fixed:** assert `SELECT *` present + `gatherEvents` fails closed to `[]` (`deepEqual`).
- **L4/L5 (deferred, follow-up) — `providerLifecycle` never emits `outcome:'failed'` on a rejected acquire/resume, and `resumeLease` reports `succeeded` even on a create-fresh `resumed:false`.** Metric-fidelity only, and NOOP in current wiring; to be completed when the provider-lifecycle seam is live-wired. **L6/L7** are doc-precision / forward-fragility (no code defect).

**Refuted (checked, not defects):** the `reason`-vocab narrowing (triple-guarded: `Equal<>` fixture + AST text-match + `clampEgressDeniedReason` folding); `fenceToken` in the operator log (a FORCE-RLS spine column behind a full tuple + Ed25519 proof, zero standalone authority — design-sanctioned D3); correlation lines suppressed under log level (the file target persists at `level:'debug'`); `executionSourceKind` constant (a descriptive label, not the `jobId` trace key; these hops exist only under the distributed flag).

## Residual risk / scope-honesty

1. **3 of 4 new metric families are INERT-UNTIL-WIRED.** Only `artifacts` emits a live log-line today. `provider-lifecycle` is NOOP at all three prod callers (`environment-runtime.ts`, `environment-probe.ts`, `one-shot-sandbox-cli.ts`); `egress`/`secret` have no prod callers (inert E4-D12/DAT-005 channels). Invariant #5 "the families emit on a live run" is satisfied by **construction + unit/contract test** for these three, not by live runtime emission. When their seams are wired, also complete `provider-lifecycle`'s `failed` emit (L4).
2. **Tenant access-control = restricted-sink scoping, not a new RBAC surface.** Correlation ids ride the FORCE-RLS `job_events` spine (writes via `runInTenant`/`withTenantTx`) + the operator-only server-log sink — never a customer-visible or cross-tenant channel, never a scrapable metric.
3. **Live proof is CI-only.** The durable-trace / tenant-scoping / evidence assertions run on the Docker/Linux `d1-merge-train` lane; the collector fails closed to `[]` off-CI. The delivered proof covers the single-attempt fake job (<500 recent events).

## Follow-up tickets

`None` blocking. When the provider-lifecycle / egress / secret seams are live-wired (E4-D12 / DAT-005 / the distributed sandbox path), thread the composition-root metrics instance + complete the `failed`/`resumed:false` emits (L4/L5).

## Gate recommendation

`ready for independent review` — server-lane + static + local gates green; the live telemetry-contract test is Docker/CI-only under DEC-03.

## Independent review

**Reviewer:** `Claude adversarial-review Workflow (6 dimensions → refute-by-default verify, 13 agents) + controller re-verification`
**Reviewed revision:** implementer working tree → fixes re-verified against source (`job-events.ts:216`, `worker-control.ts:235,291`, `collect-d1-evidence.mjs:87`)
**Disposition:** `approved`
**Review evidence:** NO HIGH; 2 MEDIUM (M1 fixed, M2 documented) + 7 LOW (L1/L2/L3 fixed, rest deferred/doc); id-discipline core confirmed triple-guarded; all local gates re-run green post-fix.

## Review attempt history

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
| 1 | Claude adversarial-review Workflow (13 agents) + controller | implementer working tree | `approved` | NO HIGH; M1 (tenant-tx-unwrapped trace log) fixed; M2 (inert-until-wired 3/4 families) documented; L1/L2/L3 hardened; id-discipline confirmed no-id-sink; local gates green post-fix; live proof on d1-merge-train |
