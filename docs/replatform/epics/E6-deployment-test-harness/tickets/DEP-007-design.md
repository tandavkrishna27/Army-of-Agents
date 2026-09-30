# DEP-007 Design — Distributed observability baseline

**Status:** `design` (reviewable artifact; implementation via per-slice fail-first TDD + distinct adversarial review; live proof is Linux-CI `d1-merge-train` only)
**Epic:** `E6-deployment-test-harness` (remainder; after DEP-005/DEP-008). **Authoritative source:** `program-design.md:732-737`.
**Depends on (complete):** DEP-002 (D1 compose), PRT-004 (protocol correlation fields), JOB-005 (durable event outbox), WRK-006 (worker metrics). Frozen worker-protocol v1 SHA `b7a842870ce7509d8baa75409e0ab19da375c88a` (consumed, never edited).
**Grounded by:** the DEP-007 terrain-map (5 readers + synth) with the load-bearing claims **independently re-verified** in `C:\e3`: there is **no server `/metrics` endpoint / Prometheus registry** (server "metrics" are structured pino log-lines; `grep -rE 'prom-client|/metrics' server/src` is empty); the **D1 evidence collector queries a non-existent `worker_events` table** (`collect-d1-evidence.mjs:85-86` `FROM worker_events ORDER BY seq` — no such table; the real table is `job_events` with column `sequence`); `JobControlMetrics` is **compile-closed + count-only** (`job-control-metrics.ts:11-134`, `clampCount`/`clampScope`); the JOB-005 ingest builds the full `fenceIdentity` spine but **never logs it** (`job-events.ts:166,187`); the 4 source services (`egress-proxy.ts`, `secret-broker.ts`, `artifact-commit.ts`) are **metric-silent**; and the wire `correlationId` is a **per-request nonce** (`e6f-harness.mjs:439,469`), not a lifecycle trace key.

---

## 1. Scope + framing

**Outcome (program-design.md:734-736):** make one fake job **observable end-to-end** — correlate `execution-source → job → attempt → lease → sandbox/service-instance` — with metric families for **queues, leases, workers, provider-lifecycle, egress-denials, secret-reads, artifacts**; keep **high-cardinality ids in access-controlled logs/traces, NEVER as metric labels**; prove it with a **D1 telemetry-contract test**.

**The two facts that decide the design (verified).** (1) There is **no `/metrics` endpoint and no OpenTelemetry** in the repo — server telemetry *is* structured pino log-lines and a durable `job_events` event stream; the only Prometheus surface is the worker-daemon's **loopback-only** health server, unreachable across the D1 network. So "one trace end-to-end" is a **correlation-id join over the durable `job_events` rows** (the JOB-005 backbone), not a span library. (2) The **correlation spine already exists as first-class columns** on `job_events` (`organizationId, companyId, jobId, attemptId, attemptNumber, leaseId, fenceToken, sequence`) and immutable fields on the frozen protocol — DEP-007 needs no new id. It is a **composition + contract-assertion** ticket: bind the existing spine to the logger, add the 4 missing count-only metric families at their silent source sites, fix the evidence collector so the trace is actually retained, and assert the contract in D1.

| Component | Lane | Kind | Responsibility |
|---|---|---|---|
| Hop-local `logger.child({…spine})` at worker-control poll/ack + JOB-005 ingest | `server/src` | additive, dormant | every structured line for a job carries `jobId`+attempt+lease so one `jobId`-keyed query reconstructs the trace (the unused `fenceIdentity` anchor at `job-events.ts:166`) |
| 4 new count-only `JobControlMetrics` methods + emits | `server/src` | additive, dormant | `providerLifecycle` / `egressDenied` / `secretRead` / `artifactOp` — closed low-cardinality enums + counts, **id-free**, best-effort, at the silent chokepoints |
| Evidence-collector fix | `scripts/collect-d1-evidence.mjs` | bug fix | repoint `gatherEvents` `worker_events→job_events`, `seq→sequence` so the retained failure-evidence `events` section holds the trace |
| D1 telemetry-contract test | `tests/d1/e6f-*.test.mjs` | test | durable end-to-end trace reconstruction + tenant-scoping, foundation campaign |
| Metric-label-discipline coverage | `server/src/__tests__/job-control-metrics.test.ts` | test | the new methods stay compile-closed / id-free (the existing `@ts-expect-error` mirror) |

**Additive + dormant** behind `AOA_DISTRIBUTED_EXECUTION_ENABLED`; no frozen-protocol edit; **no new compose service/network**; no trigger-level `paths:` filter; telemetry emission is **best-effort** (a failing logger/metric must never alter a job/lease/event control path — mirror `createPinoJobControlMetrics`' swallow).

---

## 2. Invariants (each gets a test; live lane is Linux-CI only)

1. **One trace end-to-end.** For a single fake job, the durable `job_events` rows (ordered by `sequence`) reconstruct `execution-source → job → attempt → lease → sandbox` — the terminal `sandboxId` surfaced from the `attempt_started` payload — with no gap.
2. **Correlation in logs.** The server structured log-lines for that job carry the spine (`jobId`, attempt, lease) so one `jobId` query follows the chain across hops.
3. **High-cardinality ids are NEVER metric labels.** No `JobControlMetrics` method accepts an org/company/job/attempt/lease/worker id; the metric log-lines carry only closed enums + counts (compile-closed; the `@ts-expect-error` mirror rejects an id field).
4. **Tenant ids are access-controlled.** High-cardinality ids live ONLY in FORCE-RLS `job_events` + server logs (restricted sinks) — a non-owner `aoa_app` read of a foreign org's telemetry is empty; ids never reach a scrapable/unscoped surface.
5. **The 7 metric families emit.** queues/leases/workers already emit (existing `JobControlMetrics`); provider-lifecycle/egress-denials/secret-reads/artifacts emit from their (now-instrumented) source sites, count-only.
6. **Evidence retains the trace.** The D1 evidence bundle's `events` section captures the `job_events` rows (collector repointed off the non-existent `worker_events`).
7. **Zero secret/customer bytes in telemetry.** No metric/log/trace line carries a secret value or destination host (secret-read emits an outcome token only; reuse `scrubEventStrings` for any new event-string leaf).
8. **Best-effort dormancy.** New emitters NOOP on the flag-off path and never throw into a control path.

---

## 3. Decisions

### D1 — Correlation anchored on the durable `jobId` spine (NOT the wire `correlationId`)
The trace key is `jobId` — the one id present at every hop (submit → `job_outbox` → `job_attempts` → `leases` → `job_events`) — plus the composite `(organizationId, companyId, jobId, attemptId, attemptNumber, leaseId, fenceToken, sequence)` already carried as columns on `job_events`. Bind a **hop-local `logger.child({…spine, executionSourceKind})`** at the JOB-005 ingest anchor (`job-events.ts:166`, where `fenceIdentity` is already assembled but only the ACK is returned) and at the worker-control poll/ack routes, so every structured line is join-able on `jobId`. The terminal compute hop (`sandboxId`/`serviceInstanceId`) is **payload-only** (`attempt_started`/service events; no column, no FK) — surface it by parsing `job_events.event` jsonb, never a join. **Reject the wire `correlationId`** — it is a per-request Ed25519-proof nonce (`randomUUID()` per enroll/poll/ack), correlating a single HTTP call, not the job lifecycle.

### D2 — Four new count-only metric families on `JobControlMetrics` (server log-lines)
Extend `interface JobControlMetrics` (`job-control-metrics.ts:11`) with closed-enum, **id-free** methods: `providerLifecycle({operation, outcome, count})`, `egressDenied({reason, count})`, `secretRead({outcome, count})`, `artifactOp({operation, outcome, count})` — every parameter a **closed low-cardinality enum or a `clampCount` integer**, no id. Add matching `NOOP_JOB_CONTROL_METRICS` methods and the **plan-mirror** in `job-control-metrics.test.ts` (the closed-interface guard fails otherwise). Emit through the shared `createPinoJobControlMetrics(logger)` instance (composition root `index.ts:578`, inside the distributed-execution block) at the verified-silent chokepoints: the `egress-proxy.ts` deny site (closed `EgressDenyReason`), the `secret-broker.ts` resolve path (`SecretResolveOutcome`, outcome token only), `artifact-commit.ts`, and `sandbox-provider-runtime.ts`. All best-effort (try/catch swallow). **Baseline scope:** the family + one primary emit site each + the contract test; exhaustive per-call-site coverage is a follow-up.

### D3 — Tenant-id access control = restricted-sink scoping, NOT a new RBAC surface
The realized control (the only one the substrate supports without a new read surface): high-cardinality ids live **only** in (a) FORCE-RLS `job_events` — a non-owner `aoa_app` read of a foreign org returns nothing — and (b) server structured logs (operator-only sink). They **never** reach a scrapable metric (D2 keeps metrics id-free). DEP-007 adds **no** new telemetry read endpoint; if one is ever added it must be `assertBoard` + `orgAccess.canOrg`-gated. The D1 test asserts both facets (foreign-org `job_events` read empty; metric lines id-free).

### D4 — High-cardinality discipline is already structural; ratify it
`JobControlMetrics` is compile-closed (adding an id field breaks `job-control-metrics.test.ts`'s `@ts-expect-error`), and the worker side throws at `assertBoundedLabels`. The new D2 methods follow the same pattern; the server unit test + the D1 test ratify that no id appears as a label. No new enforcement mechanism is invented.

### D5 — Fix the evidence collector so the trace is retained (in scope)
Repoint `scripts/collect-d1-evidence.mjs` `gatherEvents` from the non-existent `worker_events` (`ORDER BY seq`) to `job_events` (`ORDER BY sequence`). This is a latent DEP-004 bug: the retained failure-evidence `events` section has been silently empty. DEP-007's "evidence it retains" is unverifiable without it, so the fix is in scope; guard the section shape against `d1-evidence-bundle.mjs REQUIRED_SECTIONS` (unchanged).

### D6 — D1 telemetry-contract test (durable trace + tenant-scoping), discipline in-process
`tests/d1/e6f-<NN>-telemetry.test.mjs` (next free e6f index; foundation campaign, `--test-concurrency=1`, SKIP off `AOA_D1_LIVE`) clones the `e6f-03` fake-job flow (enroll→poll→lease→ack→attempt_started+terminal events), then asserts (a) **durable trace**: one `jobId`'s `job_events` (ordered by `sequence`) reconstruct exec-source→job→attempt→lease→sandbox (sandboxId parsed from `attempt_started`); (b) **tenant scoping**: a non-owner `aoa_app` read of a foreign org's `job_events` is empty; (c) **evidence**: the repointed collector returns the job's events. The **label-discipline (§2.3)** is proven in-process by `job-control-metrics.test.ts` (compile-closed + the new methods), and the **logger-spine binding (§2.2)** by a server unit test asserting the child logger carries the spine — the robust DB probe is the D1 anchor; fragile mid-test container-log scraping is avoided.

---

## 4. Slice plan (fail-first TDD; live proof CI-only under DEC-03)

**Slice A — the 4 metric families + label discipline.** Extend `JobControlMetrics` + NOOP + the `job-control-metrics.test.ts` mirror (incl. the `@ts-expect-error` id-rejection for each new method); emit at the 4 silent chokepoints (best-effort). RED: the new methods/emits absent; the mirror fails closed.

**Slice B — correlation logger-binding.** Hop-local `logger.child({…spine})` at `job-events.ts:166` ingest + the worker-control poll/ack routes; a server unit test asserts the bound child carries `jobId`+attempt+lease+`executionSourceKind`. RED: lines lack the spine.

**Slice C — evidence fix + the D1 telemetry-contract test.** Repoint `collect-d1-evidence.mjs` (a `d1-evidence-bundle` unit test covers the section shape); author `e6f-<NN>-telemetry.test.mjs` (durable trace + tenant-scoping + sandboxId-from-payload). `node --check` locally; **live proof = d1-merge-train**. One distinct reviewer reruns the focused suite + verifies the lane.

---

## 5. Gate + verification profile

| Lane | Command | Where |
|---|---|---|
| Metric methods + label discipline | `pnpm --filter @armyofagents/server exec vitest run …job-control-metrics.test.ts` (+ typecheck for the `@ts-expect-error` mirror) | **local + CI** |
| Correlation logger-binding unit | `pnpm --filter @armyofagents/server exec vitest run <logger-spine spec>` | **local + CI** |
| Evidence-bundle section shape | `node --test scripts/lib/__tests__/d1-evidence-bundle.test.mjs` (+ any collector unit) | **local + CI** |
| Static compose invariants (unchanged) | `node --test scripts/check-d1-compose.test.mjs` | **local + CI** |
| Telemetry-contract live trace | `node --check tests/d1/e6f-<NN>-telemetry.test.mjs`; live on `d1-merge-train` foundation | **Linux/CI only** (DEC-03) |
| brand-check env-doc | any new `AOA_*` documented (none planned) | CI |

---

## 6. Forward-wiring debt + non-goals

- **DEP-009 (2-replica HA)** depends on DEP-005 + DEP-007; it will need a per-replica `serviceInstance` dimension — expose it as a **log/trace field or a bounded low-cardinality label**, never a high-cardinality id label. Noted for DEP-009.
- **No** server `/metrics` endpoint / prom-client / new registry (extend logs; no new stack). **No** OpenTelemetry/span library. **No** id as a metric label. **No** frozen-protocol edit, new compose service, or trigger-level `paths:` filter.
- **Baseline, not exhaustive:** DEP-007 establishes the 4 families + one primary emit site each + the correlation binding + the contract test; exhaustive per-call-site instrumentation and a real scrape endpoint are later work.
- DE register: DEP-007 is a **consumer** of DE-22/07/08/13 (not an owner) — do NOT edit `distributed-execution-threat-controls.json`/`…threat-model.md` (the foundation checker rejects unknown-owner drift).

---

## 7. Load-bearing claims (re-verified) the implementer must not re-derive

1. No server `/metrics` / prom registry — server telemetry is pino log-lines (`job-control-metrics.ts`); verified empty grep.
2. `JobControlMetrics` compile-closed + count-only; new methods must be mirrored in `job-control-metrics.test.ts` — `job-control-metrics.ts:11-134`.
3. Evidence collector queries non-existent `worker_events` (`ORDER BY seq`); real table `job_events` col `sequence` — `collect-d1-evidence.mjs:85-86`, `job_events.ts:50`.
4. `job-events.ts:166` builds `fenceIdentity` (the spine) but never logs it — the trace anchor to bind.
5. `egress-proxy.ts`/`secret-broker.ts`/`artifact-commit.ts` are metric-silent — the emit sites to add.
6. Wire `correlationId` is a per-request nonce — `e6f-harness.mjs:439,469`; do NOT hang the trace on it.
7. `sandboxId`/`serviceInstanceId` are payload-only (no FK) — parse from `job_events.event` jsonb.
8. Foundation campaign auto-globs `tests/d1/e6f-*.test.mjs` serially; `docker/d1/campaign.env` selects it — `d1-merge-train.yml`.
