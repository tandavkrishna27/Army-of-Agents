# CLI-003 Design — Logs, cancellation, usage, and result collection

**Status:** `design` (reviewable artifact; implementation via fail-first TDD + distinct adversarial review). **Scope: no-key core (lands on the PR gate) + keyed real-E2B tail** (the `program-design.md:774` real-E2B success/cancellation/forced-timeout/lost-ACK cases ride the operator-dispatched `keyed-e2b-conformance.yml`).
**Epic:** `E7 — Coding/CLI workload on E2B` (third ticket). **Authoritative source:** `program-design.md:769-774`.
**Depends on (status verified):** CLI-002 (staging + the `readFile`/`listDir` capture seam — landed `cb1a6c972`), JOB-005 (idempotent event/terminal ingest — landed), DAT-003 (patch output + conflict quarantine — landed). Frozen worker-protocol v1 SHA `b7a842870ce7509d8baa75409e0ab19da375c88a` (the `log`/`progress`/`usage`/`terminal` event schemas — CONSUMED, never edited) + the frozen worker-daemon `SandboxProvider` port — never edited.
**Grounded by:** the CLI-003 terrain-map (5 readers + synth) with load-bearing claims **independently re-verified** in `C:\e3`: this is a **WIRING ticket** over a near-complete substrate. The `Supervisor` already sequences the run (`supervisor.ts:248-299`: `run.effect.create → events.attemptStarted → run.effect.execute → events.terminal`), so CLI-003 wires INTO it; line 299 drops `exec.signal`/`exec.timedOut` (the terminal-enrichment gap). The `E2bTransport.runCommand` returns only `{exitCode, signal, timedOut, crashed}` — **no stdout/stderr/stream** (`transport.ts:35,126`), so a streaming exec seam must be added. `EventSequencer` exposes only `attemptStarted/networkDenied/terminal` — **no `.log/.progress/.usage`** (`events.ts:98-156`). The frozen protocol ALREADY defines `logPayloadV1Schema`/`progressPayloadV1Schema`/`usagePayloadV1Schema` (`events.ts:60/72/82`, `usage` is `.strict()` evidentiary-only — no cost/provider/model field). The `Supervisor` takes an injectable `eventSink` (`supervisor.ts:55`); `DurableWorkerEventSink` (WRK-006) is not instantiated in the live path (E4-D12 inert), so the no-key core uses a fake sink + unit-tests the durable sink separately. The server commit halves (`artifact-commit.ts`/`artifact-transfer-grant.ts`/`patch-apply.ts`) are DONE + `guardActiveFence`-first (DAT-002/003) with a deferred worker-daemon consumer = CLI-003; the daemon transport client (`transport/client.ts`) already carries an `artifact_commit`/`event_upload`/`grant` request kind; `buildWorkspacePatch` (`build-patch.ts:159`) is a producer with no consumer; `FenceCloseProxy.commit()` is the worker-side fence gate. CLI-003 owns no `DE-*`.

---

## 1. Scope + framing

**Outcome (program-design.md:772):** stream durable events, cancel the process tree, collect bounded usage evidence for JOB-012 to price server-side, and commit patch/artifact results.

**Acceptance (program-design.md:773):** cancellation reaches terminal state within policy; duplicate result delivery is harmless; output cannot commit after lease loss.

**The thesis.** Every mechanism CLI-003 needs is built (JOB-005 idempotent ingest, the fence gates, WRK-006 durable sink, the cancel chain, DAT-002/003 commit halves). What is missing is the **producer + capture side inside the worker path**: the execute primitive discards stdout/stderr, `EventSequencer` has no log/progress/usage emitter, the terminal event omits signal/timedOut/usage/result refs, and `buildWorkspacePatch`/the commit path has no worker-daemon caller. CLI-003 wires these — additively, without touching the frozen event schema or provider port. The acceptance state machines are provable no-key (mock transport + mocked/integration DB); the real E2B success/cancel/timeout/lost-ACK run rides the keyed lane.

| Workstream | Lane | Kind | Responsibility |
|---|---|---|---|
| Streaming exec seam on `E2bTransport` (+ real + mock) | `sandbox-e2b-provider` | new | `runCommand` gains `onStdout`/`onStderr` streaming (real via the `e2b` SDK; mock replays deterministic chunks) so a coding run's output is capturable |
| `EventSequencer.log/.progress/.usage` emitters | `worker-daemon` | new | stamp seq+eventDigest + validate `workerEventV1Schema`, consuming the FROZEN log/progress/usage schemas — never edit them |
| Wire producers + terminal enrichment into `Supervisor.run` | `worker-daemon` | wire | emit log/progress/usage around `execute`; the terminal event now carries `exec.signal`/`timedOut` + a usage ref + result refs (fix `supervisor.ts:299`) |
| Fenced, idempotent result commit | `worker-daemon` | wire | capture result files via the CLI-002 `readFile`/`listDir` seam → `buildWorkspacePatch` → `FenceCloseProxy.commit()` (worker gate) → the daemon client `artifact_commit`/patch-apply (server `guardActiveFence`-first, done) |
| Bounded usage evidence (no pricing) | `worker-daemon` | new | collect `usagePayloadV1` {inputTokens, outputTokens, cachedInputTokens, runtimeMillis}; emit as a `usage` event; NEVER assert a price (JOB-012 prices server-side) |
| Cancellation-within-policy + CI + keyed lane | tests/CI | test | assert cancel→terminal within the chosen deadline bound; keyed real-E2B cases |

**Additive.** No frozen worker-protocol event-schema or `SandboxProvider`-port edit; no `DE-*` threat edit. Reuse the cancel chain, the fence gates, JOB-005 ingest, and the DAT-002/003 commit halves.

---

## 2. Invariants (each gets a test; real-E2B rerun is the keyed lane)

1. **Cancellation reaches terminal within policy.** `Supervisor.cancel → EffectAuthority.withdraw → CleanupAuthority.converge` (cancel→kill→destroy) against `MockE2bTransport` `StopOutcome`; `FenceCloseProxy.close()` is terminal + idempotent; the terminal event is emitted within the chosen deadline bound.
2. **Duplicate result delivery is harmless.** A re-delivered event/terminal/commit is a no-op: JOB-005 idempotent ingest (per-event digest, `(org,event_id)` uniqueness, cumulative-ACK replay) + DAT-002 `onConflictDoNothing`-returns-existing + DAT-003 sticky quarantine — against a mocked/integration DB.
3. **Output cannot commit after lease loss.** `FenceCloseProxy.commit()` rejects `FenceClosedError` once closed (worker-side, BEFORE the round-trip); `guardActiveFence` throws `stale_fence`/`target_revoked`/`attempt_terminal` before any append/commit (server-side).
4. **Durable event streaming.** The producer emitters stamp seq+eventDigest and validate the frozen schema; the fsync durable sink commits before emit returns; the drain flushes contiguous-seq to a fake JOB-005 endpoint (accepted/gap/stale-fence handling).
5. **Usage evidence is evidentiary-only.** `usagePayloadV1Schema.strict()` rejects any cost/provider/model/billing field; CLI-003 emits bounded token/runtime evidence and never prices.
6. **Real-E2B (keyed lane).** Success / cancellation / forced-timeout / lost-ACK against a live sandbox (forced-timeout's positive-budget path is only truly exercised with the key).

---

## 3. Decisions

### D1 — Add a streaming exec seam to `E2bTransport` (real + mock)
`runCommand` gains optional `onStdout`/`onStderr` callbacks (and returns the same `E2bCommandResult`); `real-transport.ts` binds them to the `e2b` SDK command-run stream; `MockE2bTransport` replays deterministic stdout/stderr chunks from a reserved directive (mirroring the CLI-002 fs-write directive) so log capture is no-key-testable. Inside the CLI-001 package (the seam is CLI-001's, not the frozen port).

### D2 — `EventSequencer.log/.progress/.usage` emitters (consume the frozen schemas)
Add `.log({stream, level, message})`, `.progress({percent})`, `.usage({inputTokens, outputTokens, cachedInputTokens, runtimeMillis})` to `EventSequencer`, each stamping contiguous seq + eventDigest, scrubbing secret canaries before the digest, and validating `workerEventV1Schema` — exactly like the existing emitters. The payloads are the FROZEN `logPayloadV1`/`progressPayloadV1`/`usagePayloadV1` (bounds enforced: message ≤ 65536, percent integer 0–100, usage `.strict()`). Never edit `worker-protocol/events.ts`.

### D3 — Wire producers + terminal enrichment into `Supervisor.run`
Around `run.effect.execute` (`supervisor.ts:279`), stream stdout/stderr → `events.log(...)` (batched/throttled onto the 1–500-event/≤3.75 MiB envelope), emit progress/usage as available, and **enrich the terminal event** (`supervisor.ts:299`) to carry `exec.signal` + `exec.timedOut` + a usage ref + result refs (today it hardcodes them away). Backpressure respects the outbox caps.

### D4 — Fenced, idempotent result commit (connect the deferred consumer)
After `execute`, capture result files via the CLI-002 `readFile`/`listDir` seam, build a `WorkspacePatchManifestV1` via `buildWorkspacePatch`, and commit through `FenceCloseProxy.commit()` (worker-side fence gate — a lost lease denies locally BEFORE the round-trip) into the daemon transport client's `artifact_commit`/patch-apply path (the server halves are `guardActiveFence`-first + idempotent, DAT-002/003). Verify the exact client method surface; extend the client only if a `transfer_grant` kind is genuinely missing. Idempotency keys on the artifact identity, NOT on the non-unique `versionNumber` (`job-control.ts:2489`).

### D5 — Bounded usage evidence, priced server-side by JOB-012
Collect the adapter run's token/runtime usage into `usagePayloadV1` (evidentiary-only), emit it as a `usage` event, and stop there — CLI-003 asserts NO price. JOB-012's `run-cost`/`cost_events`/`budgets` lineage prices server-side; how the new `usage` wire evidence bridges into `cost_events`/`finance_events` is a JOB-012 seam, documented as a deferral (not CLI-003's to build).

### D6 — Cancellation deadline + CI + keyed lane
Pick the governing deadline bound (`Supervisor.cleanupDeadlineMs`/`opDeadlineMs` vs the JOB-006 reaper) for "within policy" and assert it. CI: the `pr.yml:102` provider glob already matches `^server/src/services/sandbox-coding-` and the worker-daemon/sandbox-e2b-provider packages are in `verify`/`vitest`, so the no-key units auto-gate; add a `policy` checker only for a new lint-guardable invariant. Append the four real-E2B cases (success/cancel/forced-timeout/lost-ACK) to `keyed-real-e2b.test.ts`, SKIP-guarded off `E2B_API_KEY`, `e2b` dynamically imported.

---

## 4. Non-goals / scope honesty

1. **Leaked-sandbox reconciliation is CLI-004**, not CLI-003 (both ride the same monotonic `CleanupAuthority`).
2. **`usage`→`cost_events`/`finance_events` pricing bridge is JOB-012's** — CLI-003 emits unpriced evidence only. `cachedInputTokens` pricing fidelity is a JOB-012 gap.
3. **Live wiring of `DurableWorkerEventSink`+drain into the poll loop / canary seeding is E4-D12** — CLI-003 unit-tests the sink+drain and emits via the injectable sink; if the live wiring is not landed, that dependency is documented.
4. **Direct presigned-upload round-trip (DAT-002 slice 7)** is unproven end-to-end — CLI-003 commits already-staged bytes / patch manifests rather than a live transfer-grant→PUT→commit unless that path is confirmed.
5. **No frozen worker-protocol event-schema or `SandboxProvider`-port edit; no `DE-*` threat edit.**

---

## 5. CI + acceptance mapping

| Acceptance clause (L773) | Where satisfied | Gate |
|---|---|---|
| cancellation reaches terminal within policy | cancel chain + `FenceCloseProxy` + deadline assert | no-key (mock) + keyed lane |
| duplicate result delivery is harmless | JOB-005 idempotent ingest + DAT-002/003 idempotent commit | `verify` (mocked/integration DB) |
| output cannot commit after lease loss | `FenceCloseProxy.commit` reject + `guardActiveFence` | `verify` |
| stream durable events | producer emitters + fsync sink + drain | `verify` |
| bounded usage evidence, priced server-side | `usagePayloadV1` `.strict()` emit; JOB-012 prices | `verify` |
| **real E2B success/cancel/forced-timeout/lost-ACK** | live sandbox | **keyed lane** |

**Gate recommendation for implementation:** fail-first — write the emitter + terminal-enrichment + cancel-within-policy + fence-blocks-commit + idempotent-delivery tests RED before wiring, then GREEN; author the four keyed real-E2B cases SKIP-guarded + parse-verified; distinct adversarial review before the result doc. Disposition = scope-honest `pass` on in-process + mocked/integration evidence for the no-key core, with the real-E2B rerun runnable on operator key.
