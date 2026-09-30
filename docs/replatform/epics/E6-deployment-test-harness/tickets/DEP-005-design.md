# DEP-005 Design — Network failure and clock-control harness

**Status:** `design` (reviewable artifact; implementation via per-slice fail-first TDD + distinct adversarial review; live proof is Linux-CI `d1-merge-train` only)
**Epic:** `E6-deployment-test-harness` (remainder; after DEP-008). **Authoritative source:** `program-design.md:718-723`.
**Depends on (complete):** DEP-002 (D1 compose + Toxiproxy — three in-path proxies), JOB-006 (lease/ACK), plus JOB-003/004/005 (enroll/poll/lease/ack/event/reap). Frozen worker-protocol v1 SHA `b7a842870ce7509d8baa75409e0ab19da375c88a` (consumed, never edited).
**Grounded by:** the DEP-005 terrain-map (5 readers + synth) with the load-bearing claims **independently re-verified** in `C:\e3`: the reaper has **no live trigger** (`index.ts:619` schedules only `outbox.tick`; `worker-control.ts` uses `reconciliation` only for cancellation at `:642`); `createJobLeasingService` is wired with **no timeout overrides** (`worker-control.ts:80-85`, defaults 15s/300s at `job-leasing.ts:365-378`); the reap predicate keys on `clock_timestamp()` with the `ack_deadline` (offered) vs `expires_at` (offered|active) split (`job-control.ts:3125-3131`); the ack path rejects on **non-`offered` status**, not on `expires_at<now` (`job-leasing.ts:778`); the idempotency-replay path returns the identical prior outcome for a stable key (`job-leasing.ts:746-764`); `reconciliation.reapOrganization(org,{limit})` runs `runInTenant` + a fresh DB clock (`job-reconciliation.ts:90-103`); the three proxies (`control-plane-to-postgres`, `worker-to-control-plane`, `worker-to-minio`) map exactly to the three cuttable links (`docker/d1/toxiproxy.json`); `d1-merge-train` path-filters `tests/d1/**` and runs every `e6f-*.test.mjs` serially under the `foundation` campaign with `AOA_DISTRIBUTED_EXECUTION_ENABLED=true` on the control plane (`d1-merge-train.yml:40,123-155`, `docker-compose.d1.yml:143`).

---

## 1. Scope + framing

**Outcome (program-design.md:721):** deterministic **latency / partition / disconnect / time-boundary** controls on the D1 stack, with the three named links cuttable **independently, without sleeps as assertions**, plus **three demonstration tests**: (1) pre-ACK disconnect, (2) lost completion ACK, (3) expired lease.

**The one architectural fact that decides the design (verified).** The whole ticket is a **runtime extension of the standing DEP-002 substrate** — all three links already have distinct in-path Toxiproxy proxies, so no compose service / network / upstream is added and the static compose-invariant checker stays byte-for-byte green. The only genuinely missing pieces are **time control** and a **reaper trigger**: the durable job-control plane derives "now" **only** from the Postgres `clock_timestamp()` (re-read inside each locked mutation), there is **no injectable clock or shortenable-deadline config in the running stack**, and the lease reaper (`reapOrganization`/`reapExpiredLeases`) has **no scheduled or HTTP trigger** in the live container. So a back-dated lease never converges on its own. DEP-005 therefore adds exactly two capabilities — a SQL **clock helper** that back-dates the durable lease deadline columns, and **one dormant, flag-gated reaper trigger** — then drives the three cases with the existing Toxiproxy admin client.

| Component | Runs / lane | Kind | Responsibility |
|---|---|---|---|
| Clock helper `expireLeaseDeadlines(...)` | `tests/d1/lib/e6f-harness.mjs` (additive) | test-only | `UPDATE leases SET ack_deadline / expires_at = clock_timestamp() - interval` via `dexecModule('control-plane', …)` under the owner DSN — server-relative, never a host `Date` |
| Reaper trigger `POST /api/worker-control/_test/reap` | `server/src/routes/worker-control.ts` (additive) | **dormant server route** | flag-gated on `AOA_DISTRIBUTED_EXECUTION_ENABLED`; 404 when off; calls the already-instantiated `reconciliation.reapOrganization(orgId,{limit})` (proper `runInTenant`/RLS + fresh DB clock) |
| `setProxyEnabled({proxy,enabled})` | `tests/d1/lib/e6f-harness.mjs` (additive) | test-only | clean bidirectional partition via the Toxiproxy proxy-toggle endpoint (a link-sever the latency/limit toxics can't do) |
| Stable-key `ack` variant + terminal-events client | `tests/d1/lib/e6f-harness.mjs` (additive) | test-only | case-2 needs a stable `idempotencyKey` (the current `ack` mints a fresh UUID per call) and a `/worker-control/events` client (the harness has none) |
| `tests/d1/e6f-09-lease-faults.test.mjs` | live D1, `foundation` campaign | test | the three demonstration cases + positive controls |

**Dormant + additive.** The reap route is gated behind `AOA_DISTRIBUTED_EXECUTION_ENABLED` (already `true` only in the D1 compose, off in prod), path `_test/`-namespaced, and calls an existing service method — it adds no authority, no new table, no migration, and cannot fire in production. Everything else is `tests/d1`.

---

## 2. Invariants (every one gets a demonstration test; live lane is Linux-CI only)

1. **Independent link cuts.** Toxic-ing / disabling one of the three named proxies severs exactly that link and provably not the other two (topology guarantee — three distinct proxies).
2. **Pre-ACK disconnect → clean reclaim.** A worker that leases then disconnects before ack: after `ack_deadline` back-date + reap, the lease is `expired`, the attempt `expired`, a new attempt `N+1` (`pending` + one `attempt_ready` outbox row, immutable backoff) exists, the job stays `queued`, and a late ack under the revoked fence is refused `stale_fence`/`attempt_terminal`. Reaper counters `{revoked:1, retried:1}`.
3. **Lost completion ACK → idempotent, no duplicate effect.** A terminal event uploaded twice with the **same `eventId` + stable `idempotencyKey`** produces one `job_events` row + one projection receipt and the identical cumulative ACK on replay — never a duplicate attempt/projection.
4. **Expired lease → single-winner convergence.** An acked/active lease whose worker stops renewing: after `expires_at` back-date + reap, the lease/attempt are `expired`, exactly one of retry-`N+1` / `dead_letter(retry_exhausted)` results, and a late renew/event is refused `stale_fence` (winner never overwritten).
5. **No sleeps as assertions.** Every boundary is crossed by toxic-toggle + row back-date + a **synchronous** reap call — never `setTimeout`/poll-waiting for a natural deadline or a sweeper interval.
6. **Fault dormancy + teardown.** The reap route 404s unless BOTH the distributed flag and the dedicated test flag are on; every **global** fault (toxic / disabled proxy) is undone in a `finally` (mandatory under `--test-concurrency=1` on the shared stack). Clock back-dates are hermetic per-test-org (a fresh `uuid()` org per case) and need no teardown.

---

## 3. Decisions

### D1 — Clock control = SQL back-date of the durable lease deadline columns (reject config/injected-clock)
The control plane's only time source is the Postgres `clock_timestamp()` re-read per locked mutation (`job-control.ts:2055`, reap at `:3129-3130`); the leasing service's timeout params are never overridden live and the worker-daemon's injectable clock is not env-threaded into the container. So the sole deterministic, sleep-free lever is to **rewrite the row**: `UPDATE leases SET ack_deadline = clock_timestamp() - interval '2 seconds', expires_at = clock_timestamp() - interval '1 second' WHERE id = $leaseId` (the proven idiom from `job-reconciliation.integration.test.ts:28-33`). **Column subtlety (load-bearing):** back-date **`ack_deadline`** for the pre-ACK/offered case (leave `expires_at` future), **`expires_at`** for the expired/active case; always keep `ack_deadline < expires_at` (the `leases.authority_atomic_check`, `leases.ts:53-67`). The helper runs via `dexecModule('control-plane', …)` under the **owner DSN** (seeding channel), never a host-computed timestamp.

### D2 — Reaper trigger = one dormant, flag-gated test-only route (recommended over a timer or in-container dexec)
Add `POST /api/worker-control/_test/reap` (body `{organizationId, limit?}`) that, **only when BOTH `AOA_DISTRIBUTED_EXECUTION_ENABLED` AND a dedicated test-only `AOA_D1_TEST_REAP_ENABLED` are set** (else 404), calls the already-instantiated `reconciliation.reapOrganization(organizationId, {limit})` and returns its `ReapExpiredLeasesResult`. The two flags are **decoupled on purpose**: the route has no authentication (the harness calls it as an unauthenticated control-net peer), so it must not become reachable merely because a real deployment turns distributed execution on — `AOA_D1_TEST_REAP_ENABLED` is set only in `docker-compose.d1.yml`. Rationale: it reuses the existing service (proper `runInTenant`/RLS + fresh DB clock, `job-reconciliation.ts:90-103`), is explicit + synchronous (cleanest determinism, no reintroduced interval), and is trivially dormant. Rejected: wiring `createJobControlSweeper` on a timer (reintroduces an interval + timing nondeterminism); an in-container dexec constructing the `aoa_app` Drizzle db (re-implements `runInTenant`/RLS wiring — a footgun that could bypass the RLS the ticket exercises).

### D3 — Case-2 framing = event-ingest idempotency-replay (primary), control-command ACK noted
"Lost completion ACK" is modeled as the **deterministic replay** of a terminal event upload: the same `eventId` + a **stable `idempotencyKey`** yields the identical `acknowledged` outcome with no duplicate `job_events`/projection row (`job-leasing.ts:746-764`, event-ingest idempotency `job-control.ts:1057-1069`). This is sleep-free and needs no dropped-response timing. The design **notes** the sibling framing (a lost worker→server control-command ACK, `ackControlCommand` first-terminal-wins) as an alternative the reviewer may prefer; an **optional** secondary flourish drops the HTTP response via a downstream `worker-to-control-plane` toxic to prove the physical retry, but the assertion of record is the idempotent replay.

### D4 — Partition primitive = Toxiproxy proxy-toggle (`enabled:false`) for clean cuts; toxics for degraded
A `latency` toxic delays but does not sever, and a byte-count toxic on the TLS-opaque `:19000`/`:15432` links counts record bytes, not plaintext. For a genuine disconnect DEP-005 adds `setProxyEnabled({proxy,enabled:false})` (proxy-toggle admin endpoint) for a clean bidirectional cut, and uses `timeout`/`reset_peer` toxics + `setToxiproxyToxic` (already proven) for degraded/latency scenarios. The design **verifies the running toxiproxy image accepts the toggle endpoint** before committing (open question §6).

### D5 — Live test layout: one cohesive file in the `foundation` campaign
The three cases share the clock+reap+toxic machinery, so they live in one `tests/d1/e6f-09-lease-faults.test.mjs` (next free `e6f-` index; auto-run by the `foundation` glob `d1-merge-train.yml:152`, `--test-concurrency=1`), each as an independent `node:test` with a **unique `seedTenancyOrg` issuePrefix** for hermetic isolation and the `e6f-08` positive-control → fault → equality structure, SKIP-guarded off-CI (`AOA_D1_LIVE`). Bump `docker/d1/campaign.env` to re-trigger the lane. No `bounded`-subset change (these need the full stack).

---

## 4. Slice plan (fail-first TDD; live cases authored-then-CI-run under DEC-03)

**Slice A — the dormant reaper trigger + its unit proof.** Add the flag-gated `_test/reap` route; a server unit/integration test asserts it 404s with the flag off and, with the flag on + a back-dated lease (embedded-PG), returns the expected `{revoked,retried,...}` counters (reuse the `job-reconciliation.integration.test.ts` idiom). RED first (route absent → 404 always / handler missing).

**Slice B — harness primitives.** Additive `expireLeaseDeadlines` (clock helper), `setProxyEnabled` (partition), the stable-`idempotencyKey` `ack` variant, and the `/worker-control/events` terminal-event client (matching `eventUploadOperationRequestV1` + `canonicalEventDigestInputV1` so it never `hash_mismatch`es). Pure-shape unit coverage where possible; the SQL/admin calls are exercised by the live lane.

**Slice C — the three demonstration tests.** `e6f-09-lease-faults.test.mjs`: pre-ACK disconnect, lost-ACK replay, expired-lease convergence, each with its positive control, correct back-dated column, synchronous reap, fault teardown in `finally`. `node --check` locally; **live proof is the `d1-merge-train` run** (no Windows-local substitute — DEC-03). One distinct reviewer reruns the focused suite + verifies the CI lane.

---

## 5. Gate + verification profile

| Lane | Command | Where |
|---|---|---|
| Reaper-route unit/integration | `pnpm --filter @armyofagents/server exec vitest run <reap-route + reap-integration specs>` (`Invoke-E3Integration` for embedded-PG) | **local + CI** |
| Static compose invariants (must stay green, unchanged) | `node --test scripts/check-d1-compose.test.mjs` | **local + CI** |
| Demo test parse | `node --check tests/d1/e6f-09-lease-faults.test.mjs` | **local** |
| **Live D1 fault demos** | `d1-merge-train` `foundation` campaign (`tests/d1/e6f-09-*.test.mjs`, `--test-concurrency=1`) | **Linux/CI only** — DEC-03 authority, no Windows-local substitute |

Windows-local integration only via `Invoke-E3Integration` (`AOA_RUN_WIN_INTEGRATION=1`, embedded-postgres `--encoding=UTF8 --locale=C`). The live compose lane is the formal proof.

---

## 6. Open design questions

1. **Toggle endpoint support** — confirm the pinned Toxiproxy image accepts the proxy-toggle (`enabled:false`) admin call; else fall back to `timeout`/`reset_peer` toxics for the "disconnect" cut.
2. **Case-2 depth** — idempotent-replay assertion only (recommended), or also the dropped-response physical retry? Confirm the reviewer's bar.
3. **Reap route shape** — `_test/`-namespaced under `/worker-control` (recommended) vs a separate admin surface; confirm the flag-gate returns 404 (not 403) with the flag off for a clean "route does not exist when dormant" semantic.
4. **CP↔DB cut observable** — during the `control-plane-to-postgres` cut the control plane cannot serve poll/ack or reap; the natural assertion is "poll/ack returns `internal_unavailable`", not a reaper outcome. Confirm that is the intended link-3 demonstration (and sequence seed/back-date/inspect **before** cutting, since harness SQL routes through `:15432`).
5. **Scope** — strictly the three mandated cases, or also the operator-cancel path (`requestCancellation → cancelled`) as a 4th? Recommend: strictly three; note cancel as DEP-005-adjacent.

---

## 7. Forward-wiring debt + non-goals

- **DEP-009 (2-replica HA)** depends on DEP-005 (`program-design.md:748`); the clock helper + reap trigger + partition primitive are the substrate DEP-009 reuses per-replica — keep them endpoint-parameterizable, not single-replica-hardcoded.
- **No** frozen worker-protocol edit; **no** new compose service/network/Toxiproxy upstream (three proxies suffice — the `EXPECTED_*` pins stay untouched); **no** trigger-level `paths:` filter; **no** sleeps-as-assertions; **no** production reachability of the reap route (flag-gated dormant).
- Real fault volume (10⁴ lost-ACK / 100-race campaigns per `test-gates.md` D1-02/03) is the D1 gate's job; DEP-005 delivers the **controls + three demonstrations**, not the full volume.

---

## 8. Load-bearing claims (re-verified) the implementer must not re-derive

1. Reaper has NO live trigger; `reconciliation` exists but is cancellation-only — `server/src/index.ts:619`, `server/src/routes/worker-control.ts:99,642`.
2. `createJobLeasingService` wired with no timeout overrides (defaults 15s/300s) — `worker-control.ts:80-85`, `job-leasing.ts:365-378`.
3. Reap predicate = `clock_timestamp()` with `ack_deadline`(offered) vs `expires_at`(offered|active) split — `job-control.ts:3125-3131`.
4. Ack rejects on non-`offered` status, not `expires_at<now` (so back-date alone won't fail an ack — must drive the reaper) — `job-leasing.ts:778`.
5. Idempotency-replay returns the identical prior outcome for a stable key — `job-leasing.ts:746-764`.
6. `reapOrganization` runs `runInTenant` + fresh DB clock — `job-reconciliation.ts:90-103`.
7. Three proxies map to the three links; adding a fourth trips the invariant — `docker/d1/toxiproxy.json`, `scripts/lib/d1-compose-invariants.mjs` `EXPECTED_TOXIPROXY_UPSTREAMS`.
8. `d1-merge-train` path-filters `tests/d1/**` + runs `e6f-*.test.mjs` serially under `foundation`; distributed flag true on the control plane — `d1-merge-train.yml:40,152`, `docker-compose.d1.yml:143`.
9. The back-date+reap idiom is proven deterministic at embedded-PG level — `server/src/__tests__/job-reconciliation.integration.test.ts:28-33,75-132`.
