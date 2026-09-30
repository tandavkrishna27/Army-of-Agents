# Worker-daemon periodic heartbeat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a periodic heartbeat to the worker daemon so `worker.lastSeenAt`/`target.lastSeenAt` are seeded before the first poll and kept fresh, unblocking the poll authority and distributed job placement.

**Architecture:** Client-side only. A new transport method (`client.heartbeat`) POSTs a device-proof-signed request to the existing `POST /api/execution-targets/heartbeat` (returns 204, seeds both `lastSeenAt` rows via `registerProofBoundHeartbeat`). A small driver (`heartbeat-loop.ts`) beats immediately then every 2 min; the boot awaits the first successful beat before starting the poll loop (a poll before the seed returns a permanently-terminal `target_revoked`).

**Tech Stack:** TypeScript, Node, vitest; `@armyofagents/worker-protocol`; existing daemon primitives (`signDeviceProof`, `ControlPlaneClient`, `SessionProvider`).

**Spec:** `docs/replatform/2026-09-16-worker-daemon-heartbeat-design.md`

---

## File Structure

- **Modify** `packages/worker-daemon/src/transport/client.ts` — add `HEARTBEAT_PATH`, `HEARTBEAT_DESCRIPTOR`, `heartbeatPath` (interface + impl), and the `heartbeat(request)` method (mirrors `selfHelloRefresh`, returns `{ status }`).
- **Create** `packages/worker-daemon/src/identity/worker-heartbeat.ts` — `sendHeartbeat(deps)`: builds one signed heartbeat, POSTs it, returns `"ok" | "failed"`. Mirrors `identity/self-hello-refresh.ts`.
- **Create** `packages/worker-daemon/src/poll/heartbeat-loop.ts` — `createHeartbeatLoop(deps)`: `{ start, stop, firstBeat }`. Immediate + periodic beat; `firstBeat` resolves `"ok"` on first success or `"terminal"` on session terminal.
- **Modify** `packages/worker-daemon/src/bin/worker-daemon.ts` — construct + `start()` the loop after the session is acquired; `await` `firstBeat` (raced with a boot timeout) before starting the poll loop; register `stop()` in shutdown.
- **Modify** `scripts/check-worker-path-parity.mjs` — add the `HEARTBEAT_PATH` ↔ `/execution-targets/heartbeat` pair.
- **Create** `packages/worker-daemon/src/__tests__/worker-heartbeat.component.test.ts` — client + `sendHeartbeat` against `startFakeControlPlane`.
- **Create** `packages/worker-daemon/src/__tests__/heartbeat-loop.test.ts` — driver unit tests (injected clock/session/client).

**Test command (all tasks):** `pnpm --filter @armyofagents/worker-daemon exec vitest run <test-file>` (fall back to `pnpm exec vitest run <test-file>` if the filter form is unavailable). Type-check: `pnpm --filter @armyofagents/worker-daemon exec tsc --noEmit`.

---

## Task 1: Transport client — `heartbeat` method + path

**Files:**
- Modify: `packages/worker-daemon/src/transport/client.ts`
- Modify: `scripts/check-worker-path-parity.mjs`
- Test: `packages/worker-daemon/src/__tests__/worker-heartbeat.component.test.ts` (created in Task 2's test; Task 1 verified via tsc + the parity script)

- [ ] **Step 1: Add the path + descriptor constants** (near `SELF_HELLO_PATH`, ~line 124):

```ts
/** The worker execution-target heartbeat path. The device proof is signed OVER this exact
 * string (mount included), pinned by scripts/check-worker-path-parity.mjs. Server route:
 * server/src/routes/execution-targets.ts POST /execution-targets/heartbeat. Returns 204. */
export const HEARTBEAT_PATH = "/api/execution-targets/heartbeat";

/** Local descriptor for the heartbeat request (a tiny {status} body). */
export const HEARTBEAT_DESCRIPTOR = Object.freeze({
  maxRequestBytes: 4 * 1024,
  timeoutMs: 15_000,
});
```

- [ ] **Step 2: Add `heartbeatPath` to the `ControlPlaneClient` interface** (beside `selfHelloRefreshPath`):

```ts
  /** The heartbeat path the proof must be signed over (equals the request path). */
  readonly heartbeatPath: string;
  /** POST a signed heartbeat (204 on success). Returns the HTTP status only. */
  heartbeat(request: WorkerOperationHttpRequest): Promise<{ status: number }>;
```

- [ ] **Step 3: Wire the timeout + path + method in the factory.** Near `selfHelloTimeoutMs` add:

```ts
  const heartbeatTimeoutMs = HEARTBEAT_DESCRIPTOR.timeoutMs;
```

In the returned object, beside `selfHelloRefreshPath: SELF_HELLO_PATH,` add `heartbeatPath: HEARTBEAT_PATH,` and add the method (model on `selfHelloRefresh`, but there is no session header to read — heartbeat is 204):

```ts
    async heartbeat(request: WorkerOperationHttpRequest): Promise<{ status: number }> {
      if (request.bytes.byteLength > HEARTBEAT_DESCRIPTOR.maxRequestBytes) {
        throw new ControlPlaneTransportError(
          "request_too_large",
          `heartbeat request exceeds the ${HEARTBEAT_DESCRIPTOR.maxRequestBytes}-byte descriptor ceiling`,
        );
      }
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${request.sessionToken}`,
        ...request.proofHeaders,
      };
      if (request.requestId !== undefined) {
        headers[WORKER_CONTROL_HEADERS.requestId] = request.requestId;
      }
      let response: Response;
      try {
        response = await doFetch(new URL(HEARTBEAT_PATH, opts.baseUrl).toString(), {
          method: "POST",
          headers,
          body: new Uint8Array(request.bytes),
          signal: AbortSignal.timeout(heartbeatTimeoutMs),
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : "";
        if (name === "TimeoutError" || name === "AbortError") {
          throw new ControlPlaneTransportError("timeout", "heartbeat request timed out");
        }
        throw new ControlPlaneTransportError("network", "heartbeat request transport failure");
      }
      return { status: response.status };
    },
```

- [ ] **Step 4: Add the path-parity pair** in `scripts/check-worker-path-parity.mjs` `PAIRS` array:

```js
  {
    name: "worker execution-target heartbeat (Wave-4 session-lifetime)",
    daemonConst: "HEARTBEAT_PATH",
    serverFile: "server/src/routes/execution-targets.ts",
    serverRoute: "/execution-targets/heartbeat",
    mount: "/api",
  },
```

- [ ] **Step 5: Verify type-check + parity**

Run: `pnpm --filter @armyofagents/worker-daemon exec tsc --noEmit`
Expected: PASS (no type errors).
Run: `node scripts/check-worker-path-parity.mjs`
Expected: PASS (HEARTBEAT_PATH matches the route).

- [ ] **Step 6: Commit**

```bash
git add packages/worker-daemon/src/transport/client.ts scripts/check-worker-path-parity.mjs
git commit -m "feat(worker-daemon): add heartbeat transport client method + path parity"
```

---

## Task 2: `sendHeartbeat` caller

**Files:**
- Create: `packages/worker-daemon/src/identity/worker-heartbeat.ts`
- Test: `packages/worker-daemon/src/__tests__/worker-heartbeat.component.test.ts`

- [ ] **Step 1: Write the failing component test** (mirror `self-model-read.component.test.ts` harness: real fake CP + real signed request). Assert a heartbeat against the fake CP returns `"ok"` and the fake recorded a POST to the heartbeat path; and that a rejecting CP yields `"failed"` (never throws).

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sendHeartbeat } from "../identity/worker-heartbeat.js";
import { deviceKeyFromPkcs8Der } from "../identity/device-key.js";
import { startFakeControlPlane, type FakeControlPlane } from "./support/fake-control-plane.js";
import { enrollFixtureWorker, enrollmentCodeConfig } from "./support/poll-fixtures.js";

const CODE = "worker-heartbeat-code";
let fake: FakeControlPlane;
beforeEach(async () => { fake = await startFakeControlPlane({ enrollments: [enrollmentCodeConfig(CODE)] }); });
afterEach(async () => { await fake.close(); });

describe("sendHeartbeat", () => {
  it("returns ok and posts to the heartbeat path on a 204", async () => {
    const { session, record } = await enrollFixtureWorker(fake, CODE);
    const key = deviceKeyFromPkcs8Der(record.privateKeyPkcs8Der);
    const result = await sendHeartbeat({ client: fake.client, session, key });
    expect(result).toBe("ok");
    expect(fake.heartbeats.length).toBeGreaterThanOrEqual(1);
  });

  it("returns failed (never throws) when the CP rejects", async () => {
    const { session, record } = await enrollFixtureWorker(fake, CODE);
    const key = deviceKeyFromPkcs8Der(record.privateKeyPkcs8Der);
    fake.rejectHeartbeats(401);
    const result = await sendHeartbeat({ client: fake.client, session, key });
    expect(result).toBe("failed");
  });
});
```

> NOTE for implementer: `startFakeControlPlane` / `enrollFixtureWorker` / `poll-fixtures` are the existing test support in `packages/worker-daemon/src/__tests__/support/`. Read `support/fake-control-plane.ts` first — if it does not yet expose `heartbeats`/`rejectHeartbeats`, add a minimal heartbeat route to the fake (mirror its existing self-hello handling: verify Bearer + proof headers present, record the request, return 204; `rejectHeartbeats(status)` sets a one-shot status). This fake extension is part of Task 2.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/worker-daemon exec vitest run packages/worker-daemon/src/__tests__/worker-heartbeat.component.test.ts`
Expected: FAIL ("sendHeartbeat is not a function" / module not found).

- [ ] **Step 3: Implement `worker-heartbeat.ts`** (mirror `self-hello-refresh.ts`; body is the strict `{status}` schema; success is 204; best-effort):

```ts
// Wave-4 — the daemon-side heartbeat caller. Advances worker.lastSeenAt + target.lastSeenAt
// via POST /api/execution-targets/heartbeat (server seeds both through registerProofBoundHeartbeat).
// BEST-EFFORT, NEVER THROWS: a failure returns "failed" and the caller/loop decides.
import { randomBytes, randomUUID } from "node:crypto";
import type { ControlPlaneClient } from "../transport/client.js";
import type { DeviceKey } from "./device-key.js";
import { signDeviceProof } from "./device-proof.js";
import type { WorkerSession } from "../enrollment/enroll.js";

export interface SendHeartbeatDeps {
  readonly client: ControlPlaneClient;
  readonly session: WorkerSession;
  readonly key: DeviceKey;
  readonly now?: () => number;
  readonly newProofId?: () => string;
  readonly newCorrelationId?: () => string;
}

/** Send one heartbeat. "ok" on 204; "failed" on any other status or transport error. Never throws. */
export async function sendHeartbeat(deps: SendHeartbeatDeps): Promise<"ok" | "failed"> {
  const now = deps.now ?? (() => Date.now());
  const newProofId = deps.newProofId ?? (() => `prf_${randomBytes(24).toString("base64url")}`);
  const correlationId = (deps.newCorrelationId ?? (() => randomUUID()))();

  // Body MUST match workerExecutionTargetHeartbeatSchema (strict): only { status }.
  const bytes = Buffer.from(JSON.stringify({ status: "active" }), "utf8");
  const proof = signDeviceProof({
    method: "POST",
    path: deps.client.heartbeatPath,
    rawBody: bytes,
    correlationId,
    issuedAt: new Date(now()).toISOString(),
    proofId: newProofId(),
    key: deps.key,
  });

  try {
    const response = await deps.client.heartbeat({
      bytes,
      sessionToken: deps.session.token,
      proofHeaders: proof.headers,
      requestId: correlationId,
    });
    return response.status === 204 ? "ok" : "failed";
  } catch {
    return "failed"; // transport failure — best-effort
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/worker-daemon exec vitest run packages/worker-daemon/src/__tests__/worker-heartbeat.component.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add packages/worker-daemon/src/identity/worker-heartbeat.ts packages/worker-daemon/src/__tests__/worker-heartbeat.component.test.ts packages/worker-daemon/src/__tests__/support/fake-control-plane.ts
git commit -m "feat(worker-daemon): sendHeartbeat caller for the heartbeat endpoint"
```

---

## Task 3: Heartbeat loop driver

**Files:**
- Create: `packages/worker-daemon/src/poll/heartbeat-loop.ts`
- Test: `packages/worker-daemon/src/__tests__/heartbeat-loop.test.ts`

Design of the driver (`SessionProvider` is the same interface the poll loop uses — `get()` returns a `WorkerSession` or throws `SessionTerminalError`):

```ts
export interface HeartbeatLoopDeps {
  readonly session: import("./poll-loop.js").SessionProvider;
  readonly key: import("../identity/device-key.js").DeviceKey;
  readonly client: import("../transport/client.js").ControlPlaneClient;
  readonly intervalMs: number;                 // steady-state cadence (< maxHeartbeatAgeMs)
  readonly retryDelayMs?: number;              // delay after a transient failure (default 5_000)
  readonly sleep?: (ms: number) => Promise<void>;
  readonly send?: typeof import("../identity/worker-heartbeat.js").sendHeartbeat; // test seam
  readonly metrics?: import("../metrics/metrics.js").Metrics;
  readonly logger?: import("../logging/logger.js").Logger;
}
export interface HeartbeatLoop {
  start(): void;
  stop(): void;
  readonly firstBeat: Promise<"ok" | "terminal">;
}
```

- [ ] **Step 1: Write the failing tests** covering: immediate beat, periodic beat, `firstBeat` resolves "ok" on first success, `firstBeat` resolves "terminal" on `SessionTerminalError`, transient failure does not stop and does not resolve `firstBeat` early, and `stop()` halts beats.

```ts
import { describe, expect, it, vi } from "vitest";
import { createHeartbeatLoop } from "../poll/heartbeat-loop.js";
import { SessionTerminalError, type SessionProvider } from "../poll/poll-loop.js";
import type { WorkerSession } from "../enrollment/enroll.js";

const SESSION: WorkerSession = {
  token: "t", workerId: "w", targetId: "tgt", deviceGeneration: 1,
  obtainedAtMs: 0, ttlMs: 900_000, expiresAtMs: 900_000,
};
const liveProvider = (): SessionProvider => ({ get: async () => SESSION, recover: async () => SESSION });
const terminalProvider = (): SessionProvider => ({
  get: async () => { throw new SessionTerminalError(); },
  recover: async () => { throw new SessionTerminalError(); },
});
// A manual clock: sleep resolves only when advance() is called.
function manualSleep() {
  const waiters: Array<() => void> = [];
  return { sleep: (_ms: number) => new Promise<void>((r) => waiters.push(r)),
           advance: () => { const w = waiters.shift(); if (w) w(); } };
}
const stubKey = {} as any;
const stubClient = {} as any;

describe("createHeartbeatLoop", () => {
  it("beats immediately and firstBeat resolves ok", async () => {
    const send = vi.fn(async () => "ok" as const);
    const loop = createHeartbeatLoop({ session: liveProvider(), key: stubKey, client: stubClient, intervalMs: 1000, send });
    loop.start();
    await expect(loop.firstBeat).resolves.toBe("ok");
    expect(send).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it("beats again after the interval", async () => {
    const send = vi.fn(async () => "ok" as const);
    const clock = manualSleep();
    const loop = createHeartbeatLoop({ session: liveProvider(), key: stubKey, client: stubClient, intervalMs: 1000, sleep: clock.sleep, send });
    loop.start();
    await loop.firstBeat;
    clock.advance();                 // release the interval sleep
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    loop.stop();
  });

  it("firstBeat resolves terminal when the session is terminal", async () => {
    const send = vi.fn(async () => "ok" as const);
    const loop = createHeartbeatLoop({ session: terminalProvider(), key: stubKey, client: stubClient, intervalMs: 1000, send });
    loop.start();
    await expect(loop.firstBeat).resolves.toBe("terminal");
    expect(send).not.toHaveBeenCalled();
    loop.stop();
  });

  it("a transient failure does not resolve firstBeat and retries", async () => {
    const send = vi.fn().mockResolvedValueOnce("failed").mockResolvedValue("ok");
    const clock = manualSleep();
    const loop = createHeartbeatLoop({ session: liveProvider(), key: stubKey, client: stubClient, intervalMs: 1000, retryDelayMs: 100, sleep: clock.sleep, send });
    loop.start();
    // firstBeat not yet resolved (first send failed); release the retry sleep
    clock.advance();
    await expect(loop.firstBeat).resolves.toBe("ok");
    loop.stop();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @armyofagents/worker-daemon exec vitest run packages/worker-daemon/src/__tests__/heartbeat-loop.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `heartbeat-loop.ts`**:

```ts
// Wave-4 — the periodic heartbeat driver. Beats once immediately, then every intervalMs, so the
// server keeps worker.lastSeenAt fresh and the poll authority admits the worker. Fail-soft:
// transient failures retry; a terminal session stops the loop (daemon stays up, healthy-and-inert),
// mirroring the poll loop. The internal loop never rejects out of firstBeat/its own promise.
import { SessionTerminalError, type SessionProvider } from "./poll-loop.js";
import { sendHeartbeat as defaultSend } from "../identity/worker-heartbeat.js";
import type { DeviceKey } from "../identity/device-key.js";
import type { ControlPlaneClient } from "../transport/client.js";
import type { Metrics } from "../metrics/metrics.js";
import type { Logger } from "../logging/logger.js";

const HEARTBEAT_OUTCOME_METRIC = "heartbeat_outcome";

export interface HeartbeatLoopDeps {
  readonly session: SessionProvider;
  readonly key: DeviceKey;
  readonly client: ControlPlaneClient;
  readonly intervalMs: number;
  readonly retryDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly send?: typeof defaultSend;
  readonly metrics?: Metrics;
  readonly logger?: Logger;
}

export interface HeartbeatLoop {
  start(): void;
  stop(): void;
  readonly firstBeat: Promise<"ok" | "terminal">;
}

export function createHeartbeatLoop(deps: HeartbeatLoopDeps): HeartbeatLoop {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const send = deps.send ?? defaultSend;
  const retryDelayMs = deps.retryDelayMs ?? 5_000;
  let stopped = false;
  let resolveFirst: (v: "ok" | "terminal") => void;
  let firstResolved = false;
  const firstBeat = new Promise<"ok" | "terminal">((r) => { resolveFirst = r; });
  const settleFirst = (v: "ok" | "terminal") => { if (!firstResolved) { firstResolved = true; resolveFirst(v); } };

  async function loop(): Promise<void> {
    while (!stopped) {
      let session;
      try {
        session = await deps.session.get();
      } catch (err) {
        if (err instanceof SessionTerminalError) {
          deps.metrics?.inc(HEARTBEAT_OUTCOME_METRIC, { outcome: "terminal" });
          settleFirst("terminal");
          return; // stop: daemon stays up inert
        }
        deps.metrics?.inc(HEARTBEAT_OUTCOME_METRIC, { outcome: "session_unavailable" });
        await sleep(retryDelayMs);
        continue;
      }
      let outcome: "ok" | "failed";
      try {
        outcome = await send({ client: deps.client, session, key: deps.key });
      } catch {
        outcome = "failed"; // defensive; send is already best-effort
      }
      deps.metrics?.inc(HEARTBEAT_OUTCOME_METRIC, { outcome });
      if (outcome === "ok") {
        settleFirst("ok");
        await sleep(deps.intervalMs);
      } else {
        await sleep(retryDelayMs);
      }
    }
  }

  return {
    start(): void { void loop(); },
    stop(): void { stopped = true; },
    firstBeat,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @armyofagents/worker-daemon exec vitest run packages/worker-daemon/src/__tests__/heartbeat-loop.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/worker-daemon/src/poll/heartbeat-loop.ts packages/worker-daemon/src/__tests__/heartbeat-loop.test.ts
git commit -m "feat(worker-daemon): periodic heartbeat loop driver"
```

---

## Task 4: Boot wiring + config

**Files:**
- Modify: `packages/worker-daemon/src/bin/worker-daemon.ts` (the dispatch-compose block, ~lines 520-575)
- Modify: `packages/worker-daemon/src/config/config.ts` (add `heartbeatIntervalMs` from `AOA_WORKER_HEARTBEAT_INTERVAL_MS`, default 120_000, clamp [15_000, 240_000])
- Modify: `packages/worker-daemon/src/index.ts` (export `createHeartbeatLoop` if the package export barrel lists poll modules — match existing pattern)

- [ ] **Step 1: Add config** in `config/config.ts` next to the other numeric env reads. Read `AOA_WORKER_HEARTBEAT_INTERVAL_MS`; parse positive int; clamp to `[15_000, 240_000]`; default `120_000`. Add `heartbeatIntervalMs: number` to the resolved config type. (Follow the exact pattern the file already uses for a clamped ms value — e.g. how `pollTimeoutMs` is read.)

- [ ] **Step 2: Wire the loop in the boot** — inside `if (dispatch2.compose) {`, AFTER `refreshSelfHello` (line ~543) and BEFORE `runtime.start()` (line ~568). Construct the loop from the in-scope `sessionProvider`, `key`, `controlPlaneClient`, `config.heartbeatIntervalMs`, `logger`, `metrics`; start it; await `firstBeat` raced against a boot timeout; only call `runtime.start()` on `"ok"`:

```ts
        const heartbeatLoop = createHeartbeatLoop({
          session: sessionProvider,
          key,
          client: controlPlaneClient,
          intervalMs: config.heartbeatIntervalMs,
          logger,
          metrics,
        });
        heartbeatLoop.start();
        const HEARTBEAT_BOOT_TIMEOUT_MS = 30_000;
        const firstBeat = await Promise.race([
          heartbeatLoop.firstBeat,
          new Promise<"timeout">((r) => setTimeout(() => r("timeout"), HEARTBEAT_BOOT_TIMEOUT_MS)),
        ]);
        if (firstBeat === "ok") {
          runtime.start();
          logger.info(
            { workerId: identity.workerId, targetId: identity.targetId },
            "worker-daemon dispatch COMPOSED; heartbeat seeded; leasing through the poll loop",
          );
        } else {
          heartbeatLoop.stop();
          logger.warn(
            { workerId: identity.workerId, targetId: identity.targetId, firstBeat },
            "worker-daemon heartbeat did not seed before boot timeout; NOT starting the poll loop (healthy and inert)",
          );
        }
```

> IMPLEMENTER NOTES: (a) `import { createHeartbeatLoop } from "../poll/heartbeat-loop.js";` at the top. (b) The existing code currently calls `runtime.start()` then logs "dispatch COMPOSED…" unconditionally — REPLACE that pair with the gated block above (do not leave the old unconditional `runtime.start()`). (c) Register `heartbeatLoop.stop()` in the shutdown steps ahead of the health-server stop, mirroring the existing lease/poll stop registration (find where the poll loop / runtime stop is registered and add the heartbeat stop just before the health-server stop). Keep `heartbeatLoop` in the outer scope needed for the shutdown registration.

- [ ] **Step 3: Type-check**

Run: `pnpm --filter @armyofagents/worker-daemon exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Run the daemon's full test suite** (ensure no regression in boot/dispatch tests)

Run: `pnpm --filter @armyofagents/worker-daemon exec vitest run`
Expected: PASS (all green; if a boot/dispatch composition test asserts the old unconditional `runtime.start()` ordering, update it to the heartbeat-gated ordering — this is expected and correct).

- [ ] **Step 5: Commit**

```bash
git add packages/worker-daemon/src/bin/worker-daemon.ts packages/worker-daemon/src/config/config.ts packages/worker-daemon/src/index.ts
git commit -m "feat(worker-daemon): seed heartbeat before poll loop at boot (Wave-4 fix)"
```

---

## Task 5: Deploy + verify (operational — run by the operator, not a subagent)

- [ ] **Step 1:** Rebuild only the worker image from `docker/worker/Dockerfile` on the target host and restart the worker service (campaign overlay), reusing the durable `worker-state` volume.
- [ ] **Step 2:** Do a CLEAN fresh worker enrollment (fresh execution target + fresh worker identity via the runbook `docs/replatform/RUNBOOK-e7-1-keyed-run.md` §7) — NOT the gen-bump hand-recovery. Confirm `workers.last_seen_at` advances within ~2 min of boot (proves the heartbeat).
- [ ] **Step 3:** Refresh reconciliation (1-hr freshness) and confirm the canary preflight is `ok:true`.
- [ ] **Step 4:** Assign a no-bundle task to the org agent via the UI; watch for `[CLI-006] canary execution owner = DISTRIBUTED` (not `required_target_unavailable`), a real E2B sandbox, then `pnpm verify:e7-1-distributed-run <runId>` → `PASS (mechanism)`.
- [ ] **Step 5:** Also fix the separate provisioning gap: assign a human owner to the canary company (`user_roles`) so `Cannot emit a hub item: company has no human owner` stops.

---

## Self-Review

**1. Spec coverage:** component 1 (client) → Task 1; component 2 (driver) → Task 3; component 3 (boot wiring) → Task 4; data flow (heartbeat seeds lastSeenAt → poll passes) → Tasks 2+4; cadence 2 min / env override → Task 4 Step 1; error handling (fail-soft, terminal stop, never crashes) → Task 3 impl + tests; testing (client, immediate+periodic, firstBeat ok/terminal, fail-soft, boot ordering) → Tasks 2+3 tests + Task 4 Step 4; deploy/verify → Task 5. Boot-ordering test: covered by Task 3's `firstBeat` tests + Task 4's suite run asserting the gated `runtime.start()`.

**2. Placeholder scan:** no TBD/TODO; each code step has real code. The two "IMPLEMENTER NOTES" are concrete instructions tied to exact lines, not placeholders. The fake-CP heartbeat-route extension is called out explicitly in Task 2 (read the fake first; add a 204 route mirroring self-hello).

**3. Type consistency:** `HEARTBEAT_PATH`, `HEARTBEAT_DESCRIPTOR`, `client.heartbeat(request) → {status}`, `client.heartbeatPath`, `sendHeartbeat(deps) → "ok"|"failed"`, `createHeartbeatLoop(deps) → { start, stop, firstBeat: Promise<"ok"|"terminal"> }`, `config.heartbeatIntervalMs` — used consistently across Tasks 1-4. Body is the strict `{status:"active"}` schema throughout. `SessionProvider`/`SessionTerminalError` imported from `poll-loop.js` (their real home).

**Risk to watch during execution:** the fake-control-plane support may need a new heartbeat route (Task 2 note); and a boot/dispatch composition test may assert the pre-change `runtime.start()` ordering (Task 4 Step 4 note) — both anticipated.
