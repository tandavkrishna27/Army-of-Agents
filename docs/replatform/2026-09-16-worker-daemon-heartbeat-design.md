# Worker-daemon periodic heartbeat — design spec

**Date:** 2026-09-16
**Status:** approved (design), pending spec review
**Area:** `packages/worker-daemon` (client-side only; no server changes)
**Ticket context:** Wave-4 worker-session-lifetime blocker (`docs/replatform/WAVE-4-BLOCKER-worker-session-lifetime.md`)

## Problem (verified, code + runtime)

A freshly enrolled worker can never complete its first lease poll, so no distributed job is ever placed to it.

- The poll authority `authorityCurrent` (`server/src/services/job-leasing.ts:263-285`) requires `oldestHeartbeat !== null` **and** `databaseNow - oldestHeartbeat <= maxHeartbeatAgeMs`, where `oldestHeartbeat = min(worker.lastSeenAt, target.lastSeenAt)` and is `null` if **either** is null. `maxHeartbeatAgeMs` defaults to **300000 (5 min)** (`job-leasing.ts:504`).
- `workers.lastSeenAt` is advanced by **only two paths** (`server/src/services/device-liveness.ts:46`): the session-heartbeat endpoint (`heartbeatSessionProfile`) and active lease work (`touchWorkerLeaseProfile`).
- The worker daemon **has no client for the heartbeat endpoint and no timer to call it** — its transport knows only enroll / poll / session-renew / self-hello (`packages/worker-daemon/src/transport/client.ts`). The code authors state this explicitly: "THERE IS NO PERIODIC HEARTBEAT SCHEDULER in `packages/worker-daemon`… no dedicated timer that drives `POST /execution-targets/heartbeat`" (`device-liveness.ts:44`).
- `rotateWorker` deliberately never writes `lastSeenAt` (`device-liveness.ts:113`).

Result: `worker.lastSeenAt` is permanently null → `authorityCurrent` always false → the single poll the daemon makes is denied and returned to the daemon as `terminal target_revoked` → the poll loop's `stopReason = "target_revoked"` exits the loop → the daemon is up but inert. Runtime-confirmed: `poll_outcome{outcome="target_revoked"} 1`, `workers.last_seen_at` and `execution_targets.last_seen_at` both NULL.

The server side is already built and correct: `POST /execution-targets/heartbeat` (`server/src/routes/execution-targets.ts:583`, schema `workerExecutionTargetHeartbeatSchema`, guarded by `requireWorkerHeartbeatAuthority`) seeds both `target.lastSeenAt` (via `registerWorkerHeartbeat`) and `worker.lastSeenAt` (via `heartbeatSessionProfile`). The only missing piece is the daemon calling it.

## Approach (approved)

Add a **periodic heartbeat to the worker daemon** that calls the existing `POST /execution-targets/heartbeat` endpoint. Client-side change against a proven server endpoint; does **not** touch poll authority or DE-18/DE-04 audit semantics. This is exactly what the authors anticipated (`AOA_DEVICE_LIVENESS_DEADLINE_MS` hook, "an operator who ships a real periodic heartbeat").

Rejected alternatives: seeding `lastSeenAt` at enroll (breaks the deliberate "generation boundary → never_seen" staleness invariant, `device-liveness.ts`); relaxing `authorityCurrent` for the first poll (touches security-sensitive poll authority + DE audits — wrong place for a missing client heartbeat).

## Components

### 1. Heartbeat transport client
- Add `HEARTBEAT_PATH = "/api/execution-targets/heartbeat"` and a `HEARTBEAT_DESCRIPTOR` (timeout + maxRequestBytes) in `transport/client.ts`, mirroring `SELF_HELLO_PATH` / `SELF_HELLO_DESCRIPTOR`.
- Add `heartbeatPath` to the proof-path set (the object exposing `pollPath`, `selfHelloRefreshPath`, …) so the device proof is signed over the exact request path.
- Add a client method `heartbeat(request: WorkerOperationHttpRequest)` mirroring `selfHelloRefresh` (bounded body, device-proof headers, classified transport failure, same response-handling shape as the existing `selfHelloRefresh` method — do not invent a new response type).
- Request body: `workerExecutionTargetHeartbeatSchema` = `{ status?: "active"|"draining"|"offline", capabilities?: record }`. Send `status: "active"` and omit capabilities (target capabilities are set at ratify time; the heartbeat only needs to advance liveness). Body stays well under the descriptor ceiling.

### 2. Heartbeat driver (new module `packages/worker-daemon/src/poll/heartbeat-loop.ts`)
- Pure-ish driver modeled on `lease/lease-renewal.ts` / `events/event-outbox-drain.ts` timer patterns (injected `sleep`/timers for testability).
- Inputs: the session provider (`createSessionProvider(store).get()` for a live `WorkerSession`), the device `key`, the transport `client`, an interval, and `metrics`/`logger`.
- Behavior:
  - `start()` begins an internal loop that sends **one heartbeat immediately**, then re-sends every `intervalMs` (default **120000 = 2 min**, safely under the 5-min `maxHeartbeatAgeMs`; env-overridable via a new `AOA_WORKER_HEARTBEAT_INTERVAL_MS`, clamped `[15s, 4min]`).
  - Exposes a `firstBeat: Promise<"ok" | "terminal">` that resolves on the **first successful** heartbeat (`"ok"`), or `"terminal"` if the session goes terminal before any success. The boot uses this to gate the poll loop **lazily** (§3) — it does not race a boot timeout.
  - Fail-soft: a transient failure (network/timeout/5xx) is a metric + bounded backoff retry and does **not** stop the loop; a terminal session (`SessionTerminalError` from `session.get()`) **stops** the driver (daemon stays up inert, same discipline as the poll loop). The internal loop is wrapped in an outer try/catch AND every metric emit goes through a swallowing helper, so it never rejects out (cannot become an unhandled rejection — see Error handling for why this is load-bearing).
  - `stop()` clears the timer for graceful shutdown; registered in the shutdown sequence ahead of the health-server stop, mirroring the existing lease-stop ordering.
  - **Metric outcomes are registered.** The driver emits `heartbeat_outcome{outcome}` with `outcome ∈ {ok, failed, terminal, session_unavailable}`. `outcome` is a **closed** label allow-list in `metrics/metrics.ts` (`inc` throws on an unregistered value, on the happy path as readily as on failure), so the three new tokens (`ok`, `terminal`, `session_unavailable`; `failed` pre-exists) are registered there in the same change. The swallowing emit helper is defence-in-depth on top of that.

### 3. Boot wiring (`bin/worker-daemon.ts`)
- After the session is acquired and dispatch composes (right where `runtime.start()` was called), construct and `start()` the heartbeat driver, then **start the poll loop LAZILY from the driver's first-successful-beat callback** (`void heartbeatLoop.firstBeat.then(...)`). Boot does **not** block on the beat, so the health server and shutdown handlers come up immediately.
  - `firstBeat === "ok"` → start the poll loop (now `lastSeenAt` is seeded → the first `pollOnce` passes `authorityCurrent`). Guarded by `pollLoopStarted` (start at most once) and `shuttingDown` (never start a poll loop a shutdown already tore down; `shuttingDown` is set at the very start of any shutdown, signal or programmatic).
  - `firstBeat === "terminal"` → **do not start the poll loop**; log the reason and stay healthy-and-inert. A control plane that is briefly slow at boot no longer strands the worker: because the gate is lazy (not a bounded boot race), the poll loop simply starts whenever the first beat eventually lands, rather than a >30s boot blip permanently disabling an otherwise-healthy, actively-beating worker until an operator restart.
- **Why strict ordering, not "start both and let it heal":** the poll loop exits permanently on a `target_revoked` poll outcome (`poll-loop.ts run()` sets `stopReason = "target_revoked"` and breaks). The server returns the coarse `target_revoked` code for a heartbeat-stale/authority-not-current denial too (it deliberately does not distinguish, to avoid a target-existence oracle). So a poll issued before the first heartbeat seed would kill the loop for good. Gating the poll loop on the first successful heartbeat is what makes the fix robust without changing the poll loop's (correct) terminal handling of a genuine revocation.
- Register `heartbeatDriver.stop()` in the shutdown steps ahead of the health-server stop, mirroring the existing lease-stop ordering.

> **Revised after code review (2026-09-16).** Two confirmed defects in the first implementation were fixed before merge and this section reflects the as-built: (a) the driver emitted `heartbeat_outcome` values not in the closed `outcome` metrics allow-list, so a real `metrics` instance made `inc` throw on the first successful beat — orphaning the fire-and-forget loop and leaving `firstBeat` unresolved (the fix inert). Fixed by registering the tokens + a swallowing emit helper + an outer loop try/catch. (b) The original bounded-boot `await Promise.race([firstBeat, 30s timeout])` permanently stranded a worker whose control plane was slow for >30s at boot; replaced with the lazy start above.

**Poll-loop `target_revoked` handling is intentionally left UNCHANGED.** A genuinely revoked target must stay terminal; the fix removes the *cause* of a spurious `target_revoked` (missing heartbeat) rather than making the loop retry a terminal signal it cannot disambiguate.

## Data flow

session acquired → heartbeat POST (device-proof signed) → server `registerWorkerHeartbeat` + `heartbeatSessionProfile` seed `target.lastSeenAt` + `worker.lastSeenAt` → poll loop `authorityCurrent` passes → lease offer → `touchWorkerLeaseProfile` keeps `lastSeenAt` fresh during active work → adapter-manager → E2B.

## Error handling

- Transient heartbeat failure (network/timeout/5xx): metric + bounded backoff retry; does not stop the driver.
- Terminal session (401 stop-and-backoff surfaced as `SessionTerminalError`): stop the driver; daemon stays up serving health (consistent with poll-loop terminal handling).
- The driver never rejects out of its own promise chain. Three things guarantee it: (1) every I/O await is guarded; (2) the whole loop body sits in an outer try/catch that logs and leaves the daemon healthy-and-inert; (3) metric emits go through a swallowing helper so a metrics-contract fault (e.g. future `outcome` vocabulary drift) can never throw synchronously into the loop. Point (3) is load-bearing: `metrics.inc` throws on an unregistered closed-label value, and without the swallow that throw — on the happy path — would orphan the fire-and-forget loop AND leave `firstBeat` unresolved, so the poll loop would never start.
- `sendHeartbeat` itself never throws (signing + transport both inside its try/catch), and the loop's default `sleep` uses an `.unref()`ed timer so the heartbeat's own timer never independently keeps the process (or a test runner) alive.

## Testing (TDD)

Unit tests in `packages/worker-daemon/src/__tests__/` matching existing patterns:
1. **Client:** `heartbeat()` builds a request signed over `HEARTBEAT_PATH`, with the correct body and device-proof headers; rejects a body over the descriptor ceiling.
2. **Driver — immediate + periodic:** with an injected clock, `start()` issues one beat immediately and one per `intervalMs`; each uses a freshly `get()`-ed session.
3. **Driver — `firstBeat` resolves `"ok"` on first success**, and `"terminal"` when `session.get()` throws `SessionTerminalError` before any success.
4. **Driver — terminal stop:** on `SessionTerminalError` the driver stops and issues no further beats.
5. **Driver — fail-soft:** a transient client error does not stop the driver and does not resolve `firstBeat`; the next tick still beats and a subsequent success resolves `firstBeat = "ok"`. Also: a non-terminal `session.get()` error records `session_unavailable`, retries, then succeeds; the loop stops after a live-then-terminal session.
6. **Driver — metrics under the real closed allow-list:** run the loop WITH a real `createMetrics()` (not a no-op stub) and assert `heartbeat_outcome{outcome="ok"|"terminal"|"session_unavailable"}` counters are actually recorded — this fails if a token is unregistered (regression guard for the closed-label defect).
7. **Boot ordering (lazy):** with a 204-heartbeat fake, the boot starts the poll loop after the first beat (`vi.waitFor` on the `runtime.start` spy); with a non-204 heartbeat the poll loop is never started and `result.ok === true`. The existing compose-reaching bootstrap fakes gained a 204 `heartbeat`/`heartbeatPath` so they exercise the real success path.

## Deploy / verify (proper process)

1. Land the change on the feature branch with green tests; self-review + code-review skill.
2. Rebuild + redeploy **only the worker image** (`docker/worker/Dockerfile`).
3. Do a **clean fresh** worker enrollment (fresh target + worker, not the gen-bump hand-recovery), assign the canary task to the org agent via the UI, and run `pnpm verify:e7-1-distributed-run <runId>` for the mechanism proof.

## Out of scope (YAGNI)

No changes to poll authority, DE audits, or any server code; no general periodic scheduler beyond this one heartbeat timer; no capability re-measurement in the heartbeat (self-hello already handles matchability).
