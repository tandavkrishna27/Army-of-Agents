# DEP-009 Design — Two-replica control-plane HA and shared admission

**Status:** `design` (reviewable artifact; implementation via per-slice fail-first TDD + distinct adversarial review; live proof is Linux-CI `d1-merge-train` only). **Scope: FULL acceptance** (operator-directed 2026-08-16 — build the shared rate limiter + org-capacity admission, not just prove the free invariants).
**Epic:** `E6-deployment-test-harness` (remainder; LAST DEP before DEP-006). **Authoritative source:** `program-design.md:746-751`.
**Depends on (complete):** TEN-005, JOB-007, JOB-009, DEP-005 (fault harness), DEP-007 (observability), E6-D1-FOUNDATION. Frozen worker-protocol v1 SHA `b7a842870ce7509d8baa75409e0ab19da375c88a` (consumed, never edited).
**Grounded by:** the DEP-009 terrain-map (5 readers + synth) with the load-bearing claims **independently re-verified** in `C:\e3`: `admitAttemptCapacity` has **no live caller** and org-capacity at the offer is a documented JOB-007 deferral blocked by the frozen JOB-003 poll contract (`job-leasing.ts:658-664`, `org-concurrency.ts:213`); `rate-limit.ts` is an **in-memory** express-rate-limit bucket with no shared store and is **not applied to worker-control** at all (`rate-limit.ts:1-18`); the single-live-lease unique index `leases_active_per_attempt_idx` exists (`leases.ts:113`); the device proof is host-agnostic (`e6f-harness.mjs:247` `new URL(url).pathname`) with a shared `AOA_WORKER_SESSION_SIGNING_KEY` (`docker-compose.d1.yml:175`); and the owner participant boots under `pg_try_advisory_xact_lock_shared` with a per-process random key (`distributed-execution-databases.ts:1254,1335`) — a shared, non-blocking lock, so two replicas boot on one DB without deadlock.

---

## 1. Scope + framing

**Outcome (program-design.md:749):** two interchangeable control-plane replicas over one PostgreSQL/shared store for placement, lease, quota, rate-limit, and admission. **Acceptance:** replicas cannot double-place/lease, exceed Organization capacity, or disagree on an accepted event/terminal; polling is replica-agnostic; replica loss preserves correctness + bounded progress; **process-local admission state is forbidden**.

**The thesis that shapes the design (verified by three readers).** ~90% of two-replica correctness is **already free**: every control-plane mutation runs inside one `runInTenant(appDb, org, fn)` PostgreSQL transaction over `FOR UPDATE [SKIP LOCKED]`, partial-unique indexes, `ON CONFLICT DO NOTHING`, status-pinned conditional UPDATEs, `pg_advisory_xact_lock`, and DB `clock_timestamp()` — never process memory. PostgreSQL is the single writer and is inherently replica-agnostic; two OS processes racing the same job yield exactly one winner by construction. The `job-ready-scheduler` in-memory map is a **non-authoritative poll-backoff hint** (it "carries NO lease authority", `job-ready-scheduler.ts:36-39`; its only consumer picks `retryAfterMs`), so it is allowed to be process-local. **What DEP-009 must actually build** is (a) the 2nd compose service + lockstep invariant update, (b) a **new PostgreSQL-backed shared rate limiter** (the one genuine process-local gap), (c) **submit-time org-capacity admission** (wiring the deferred `admitAttemptCapacity`), and (d) the 2-replica concurrency test.

| Workstream | Lane | Kind | Responsibility |
|---|---|---|---|
| `control-plane-b` + `worker-to-control-plane-b` toxiproxy + lockstep invariants | compose / static | additive | a 2nd interchangeable replica; the `EXPECTED_*` pins move in the SAME commit |
| PG-backed shared rate limiter | `server/src` + `packages/db` | **new production** | per-org admission rate over a shared DB window; fail-CLOSED (no in-memory fallback); dormant behind the flag |
| Submit-time org-capacity admission | `server/src` | **new production** | wire `admitAttemptCapacity` at submit (before leasable) — enforces org capacity across replicas without touching the frozen poll contract |
| Harness per-replica + `e6f-11` concurrency test | `tests/d1` | test | drive concurrent A/B traffic in one serial test; assert the 6 acceptance invariants |

**Additive + dormant** behind `AOA_DISTRIBUTED_EXECUTION_ENABLED` (default-off, fail-closed); no frozen-protocol edit; no trigger-level `paths:` filter; DEP-009 is the central **implementer** of DE-27 but is **NOT its owner** (owners: FND-005, REL-002) — do NOT edit `distributed-execution-threat-controls.json`/`…threat-model.md`.

---

## 2. Invariants (each gets a test; live 2-replica lane is Linux-CI only)

1. **No double-place/lease.** Two replicas racing the same job → exactly one lease (disjoint `SKIP LOCKED` candidates + `pending→offered` CAS + `leases_active_per_attempt_idx`).
2. **No capacity exceed.** Concurrent submits across A+B cannot admit more than the org cap (shared `pg_advisory_xact_lock('aoa:org-capacity', org)` count-then-claim, idempotent per attempt).
3. **No terminal/event disagreement.** `guardActiveFence` (FOR UPDATE + DB clock) + `job_projection_receipts` unique → replicas converge on one terminal, one accepted-event sequence.
4. **Replica-agnostic polling + no process-local admission.** The DB claim is the sole authority; the scheduler is a pure hint. The rate limiter + capacity are DB-backed; concurrent A+B requests share ONE limit/cap. Fail-closed on shared-store error (never fall back to per-process memory).
5. **Replica loss → correctness + bounded progress.** Cut/stop one replica (DEP-005 `setProxyEnabled`); the surviving replica + the visibility-timeout reap converge the work with no double-effect.
6. **Compose adds exactly one legit service.** The 32→(new) invariant suite passes with 2 replicas; the lockstep `EXPECTED_*` pins match reality; the reject-clones prove the invariants are non-vacuous.

---

## 3. Decisions

### D1 — `control-plane-b` (keep `control-plane`, add asymmetric `control-plane-b`) + per-replica worker proxy + lockstep invariants
Clone the `control-plane` block (following worker-a/worker-b), differing ONLY by: its own state volume `d1-control-plane-b-state` (a shared rw mount is rejected by `checkNoSharedRwVolume`) and `AOA_ALLOWED_HOSTNAMES` adding `control-plane-b` (else worker-control 400s on Host — health bypasses, a silent live-only failure). Identical image, all env (incl. the SAME `AOA_WORKER_SESSION_SIGNING_KEY` — the cross-replica session-portability premise), the 4 networks, `depends_on migrate: service_completed_successfully` (migrate is a dedicated one-shot — control-plane-b runs NO migrations), own healthcheck. The DB proxy stays **shared** (both dial `control-plane-to-postgres:15432`); add a **per-replica** `worker-to-control-plane-b` (listen `:13101` → `control-plane-b:3100`) so each replica's worker link is independently cuttable. **Lockstep (ONE commit)** in `scripts/lib/d1-compose-invariants.mjs`: `EXPECTED_NETWORKS += control-plane-b`; `CONTROL_PLANE_SERVICE` → `CONTROL_PLANE_SERVICES` iterated in `checkMigrateGate`/`checkToxiproxyInPath`/`checkPresignEndpoint`/`checkAdmittedImageRefs`/`checkFakeProviderCtlAllowlist` (control-plane-b also FORBIDDEN from scripting the fake); `EXPECTED_TOXIPROXY_UPSTREAMS += worker-to-control-plane-b`; plus `check-d1-compose.test.mjs` (valid-compose gains the replica+volume, the "N matrix services" count, new reject-clones), `check-d1-compose.mjs` banner, `collect-d1-evidence.mjs D1_SERVICES += control-plane-b`, `docker/d1/README.md`.

### D2 — PostgreSQL-backed shared rate limiter (the one process-local gap), fail-closed
`rate-limit.ts` is per-process and unapplied to worker-control; DEP-009 adds a **shared** limiter for the distributed admission path (the worker poll — the highest-frequency admission request). A new tenant-scoped table (Drizzle `db:generate`; RLS via the C14 `--custom` route per TEN-005) holds a per-`(organizationId, window)` fixed-window counter; the limiter does an **atomic UPSERT-and-increment returning the new count** (single statement, no read-then-write race) inside the request's tenant tx and rejects over the cap. It is **fail-CLOSED**: a shared-store error denies (429/`internal_unavailable`), NEVER a per-process fallback (DEP-006 line 729 requires no in-memory fast-path even on transient shared-store failure). Dormant behind the flag; the scheduler hint is untouched. Because the counter is a shared DB row, two replicas incrementing it observe ONE limit — the acceptance's "shared rate-limit behavior".

### D3 — Submit-time org-capacity admission (wire the deferred `admitAttemptCapacity`)
Org-capacity at the offer is blocked by the frozen JOB-003 poll contract (one repository selection, no injected guard — `job-leasing.ts:658-664`). The lower-risk seam is **admission at submit**: call `admitAttemptCapacity` (the existing shared `pg_advisory_xact_lock('aoa:org-capacity', org)` authority, idempotent on `jobAttempts.capacityClaimState`) when the job's first attempt is created in `submitJobWithinTenant` (`job-submission.ts:101`), composed into the SAME `runInTenant` tx (admitAttemptCapacity's own `db.transaction` participates in the outer tenant tx). Over-cap submit → reject before the job is leasable; the advisory lock serializes count-then-claim across BOTH replicas, so concurrent A+B submits cannot exceed the cap. `releaseAttemptCapacity` on terminal/revoke (already wired from revocation-fanout) balances it.

### D4 — Harness per-replica addressing + `e6f-11` two-replica concurrency test
Parameterize `CONTROL_PLANE_URL`/`WORKER_CONTROL`/`EVENTS_URL` into a `workerControlFor(base)` factory + `CONTROL_PLANE_B_URL="http://control-plane-b:3100"` (the HTTP clients already take a `url` param — no signature change). New `tests/d1/e6f-11-two-replica.test.mjs` (foundation glob; SKIP off `AOA_D1_LIVE`) with a `runReplicaRace` helper (clone of `runLeaseRace` — `Promise.all` of poll/ack across A/B **inside one `dexecModule("test-runner")` exec**, since the campaign is `--test-concurrency=1` serial). Sub-tests: single-winner lease race (A vs B) → `queryLeaseFaultState` one lease; concurrent over-cap submit across A/B → capacity not exceeded; consistent terminal (`queryJobEventTrace`); replica-agnostic (enroll at A, poll/ack at B — one session, host-agnostic proof); replica-loss (`setProxyEnabled` cut B's `worker-to-control-plane-b` → reap → the work converges via A); shared rate-limit (concurrent A+B polls hit ONE window counter). Every fault restored in `finally`; assert `attempts.length===2` after concurrent reaps (not `>=1`) so a double-retry defect can't hide.

### D5 — No-process-local-admission proof
The rate limiter (D2) + capacity (D3) are the only admission gates and both are DB rows; the scheduler is a non-authoritative hint. A unit/static check asserts the limiter denies from either replica's config (identical shared-store DSN, no per-replica limiter env) and that concurrent A/B admission observes one shared count/cap. New admission code stays out of the flag-off module graph (type-only imports where a value would pull it in — the DEP-007 dormancy lesson).

---

## 4. Slice plan (fail-first TDD; live 2-replica proof CI-only under DEC-03)

**Slice A — compose replica + lockstep invariants (static).** `control-plane-b` + `worker-to-control-plane-b` + all `d1-compose-invariants.mjs`/`check-d1-compose.test.mjs`/`collect-d1-evidence.mjs` edits in ONE change; RED first (a replica with no lockstep update fails `checkServiceSet`; a wrong net-set/un-migrate-gated/shared-volume replica fails its reject-clone). GREEN: the suite passes at the new service count.

**Slice B — PG shared rate limiter.** Schema table (`db:generate` + C14 custom RLS migration) + the atomic UPSERT-increment limiter service + fail-closed wiring on the worker poll; pure/unit tests (over-cap denies; idempotent window; fail-closed on injected store error; two "replicas" share one counter via one DB). RED first.

**Slice C — submit-time org-capacity admission.** Wire `admitAttemptCapacity` into `submitJobWithinTenant`; embedded-PG integration (over-cap submit denies; idempotent re-submit; release on terminal; concurrent admit serialized by the advisory lock). RED first.

**Slice D — harness per-replica + `e6f-11`.** `workerControlFor` + `CONTROL_PLANE_B_URL`; the `runReplicaRace` concurrency test (all 6 invariants). `node --check` locally; **live proof = d1-merge-train 2-replica lane**. One distinct reviewer reruns the focused suites + verifies the live lane.

---

## 5. Gate + verification profile

| Lane | Command | Where |
|---|---|---|
| Compose lockstep invariants | `node --test scripts/check-d1-compose.test.mjs` (new service count + reject-clones) | **local + CI** |
| Shared rate limiter | `pnpm --filter @armyofagents/server exec vitest run <limiter unit + integration>` (`Invoke-E3Integration` for embedded-PG) | **local + CI** |
| Org-capacity admission | `pnpm --filter @armyofagents/server exec vitest run <submit-capacity integration>` | **local + CI** |
| Migration (new table) | `pnpm db:generate` clean; migration idempotent; `distributed-execution-db-startup.integration.test.ts` (serving-role/RLS consumers) green | **local + CI** |
| Full server suite (dormancy + no regression) | `pnpm --filter @armyofagents/server exec vitest run` (the DEP-007 lesson: run the WHOLE verify suite before pushing distributed-plane imports) | **local + CI** |
| Live 2-replica correctness | `d1-merge-train` foundation (`e6f-11`, `--test-concurrency=1`) | **Linux/CI only** — DEC-03 |

Migration follows Critical Rule #1 (Drizzle `db:generate`; C14 hand-append ONLY for the idempotent RLS role/GRANT/POLICY, always commented). The new `AOA_*` (if any limiter env) is documented in `environment-variables.md` (brand-check).

---

## 6. Load-bearing invariants & hazards

- **Do NOT edit frozen worker-protocol** (2-replica correctness is below the wire, in the DB) or the **threat register** (DEP-009 implements DE-27 but does not own it — the JSON↔MD parity checker rejects non-owner drift).
- **Lockstep or nothing:** a compose service added without the `EXPECTED_NETWORKS`/`checkServiceSet`/`EXPECTED_TOXIPROXY_UPSTREAMS` + test-baseline update reddens the gate. All move in ONE commit.
- **No process-local admission, no in-memory fallback:** the limiter fails CLOSED on shared-store error; no per-replica limiter/cap state.
- **No replica affinity:** control-plane-b must NOT `depends_on control-plane` (breaks replica-loss independence); own state volume; own hostname allowlist entry; SAME signing key.
- **Serial campaign:** all A/B concurrency lives inside one `dexecModule("test-runner")` exec; restore every proxy/fault in `finally`.
- **Migrate-once:** only the `migrate` one-shot runs migrations; both replicas gate on it.
- **2-replica boot:** the owner participant uses a shared, non-blocking advisory lock (verified) — but the implementer MUST confirm on the live lane that both replicas reach healthy (the app-layer boot path is surfaced, not fixed, by compose).
- **Module-graph dormancy (DEP-007 lesson):** new admission code additive + dormant + type-only imports where a value would pull it into the flag-off graph; run the FULL verify suite before pushing.
- **2-replica reap race:** assert exactly-one retry attempt after concurrent reaps (not `>=1`).
- **Distinct adversarial reviewer** on the shared-admission concurrency paths (double-admit under partition, capacity release-twice, limiter fail-open, lost-ACK terminal disagreement) — the recurring lesson: adversarial re-tracing catches real HIGH concurrency/cross-tenant defects a first read misses.

---

## 7. Open design questions (resolve in implementation)

1. **Rate-limit target + budget:** per-org poll rate (recommended) vs also enroll/submit; the window size + cap default (env-configurable, documented). Confirm the exact worker-control request(s) to gate.
2. **Capacity claim timing:** `admitAttemptCapacity` claims a slot on an ATTEMPT — confirm the first attempt exists at `submitJobWithinTenant` (vs created later by the ready-scheduler); wire the claim where the attempt first becomes leasable, staying inside the tenant tx.
3. **New table RLS:** the C14 custom-migration RLS shape (aoa_app read/write scoped to the tenant GUC; no owner-pool bridge) — mirror TEN-005/the DAT-003 cutover-marker pattern.
4. **e6f-11 structure:** one file, ≥6 `test()` cases (one per invariant), each hermetic org + `runReplicaRace`; confirm the free slot (`e6f-11`).

---

## 8. Load-bearing claims (re-verified) the implementer must not re-derive

1. `admitAttemptCapacity` has NO live caller; org-capacity-at-offer is a JOB-003-frozen deferral — `org-concurrency.ts:213`, `job-leasing.ts:658-664`. Wire it at SUBMIT.
2. `rate-limit.ts` is in-memory + not applied to worker-control — `rate-limit.ts:1-18`; the shared limiter is genuinely net-new.
3. Two replicas boot without deadlock — `distributed-execution-databases.ts:1254,1335` (`pg_try_advisory_xact_lock_shared`, per-process random key). Confirm live.
4. `leases_active_per_attempt_idx` single-live-lease unique index — `leases.ts:113`.
5. Device proof host-agnostic (`new URL(url).pathname`) + shared signing key → cross-replica sessions — `e6f-harness.mjs:247`, `docker-compose.d1.yml:175`. control-plane-b MUST keep the same key.
6. `checkServiceSet` strictly rejects any service not in `EXPECTED_NETWORKS` (the lockstep tripwire) — `d1-compose-invariants.mjs:26-52,142-151`, `check-d1-compose.test.mjs` "N matrix services".
7. The atomic lease/offer/projection/outbox/reap mechanisms are all `FOR UPDATE [SKIP LOCKED]`/unique/CAS (2-replica-free) — `job-control.ts:1673-1744,2071-2117,1033-1090,2840-2928,3109-3248`.
8. The scheduler map is a non-authoritative hint (allowed process-local) — `job-ready-scheduler.ts:36-142`, `job-leasing.ts:478-481`.
