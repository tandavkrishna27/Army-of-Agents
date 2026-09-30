import { describe, expect, it, vi } from "vitest";
import {
  driveCodexAppServer,
  type AppServerDriverClient,
  type AppServerAccumulator,
  type NeutralIntermediate,
} from "../app-server/driver.js";
import { isCodexUnknownSessionError } from "../parse.js";

/**
 * W5c Task 8 — comprehensive failure-mode + cancel→teardown tests for the
 * `codex app-server` turn driver.
 *
 * These prove the driver stays SAFE (fail-closed, no hang, no double-settle,
 * no fail-open approval) under every abnormal path in the plan:
 *   1. user-never-answers (broker timeout → decline; turn still ends)
 *   2. run cancelled mid-approval (child dies → client closes → driver UNWINDS)
 *   3. codex crash / error-willRetry (error notification + hard close, once)
 *   4. malformed message (never turned into an accept)
 *   5. duplicate approval for the same itemId (answer each; no hang/crash)
 *   6. stdin write-after-close (respond/notify swallowed)
 *   7. runningProcesses cleanup — see appserver-spawn-teardown.test.ts
 *
 * The driver is driven against a SCRIPTED FAKE client that additionally
 * supports firing its `onClose` callbacks (simulating the JSON-RPC transport
 * closing when the tracked child dies) and rejecting outstanding requests.
 */

interface ScriptedRequest {
  method: string;
  params: unknown;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  __settled?: boolean;
}

function makeFakeClient() {
  const requests: ScriptedRequest[] = [];
  const notifies: Array<{ method: string; params: unknown }> = [];
  const responses: Array<{ id: number | string; result: unknown }> = [];
  const closeCallbacks: Array<() => void> = [];
  let onServerRequest:
    | ((id: number | string, method: string, params: unknown) => void | Promise<void>)
    | undefined;
  let onNotification: ((method: string, params: unknown) => void) | undefined;
  let closed = false;

  const client: AppServerDriverClient = {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const entry: ScriptedRequest = { method, params, resolve, reject };
        if (closed) {
          entry.__settled = true;
          reject(new Error("JSON-RPC client is closed"));
        }
        requests.push(entry);
      });
    },
    notify(method, params) {
      if (closed) return; // guarded write-after-close (mirrors real client)
      notifies.push({ method, params });
    },
    respond(id, result) {
      if (closed) return; // guarded write-after-close (mirrors real client)
      responses.push({ id, result });
    },
    respondError() {
      /* not exercised here */
    },
    onClose(cb) {
      closeCallbacks.push(cb);
    },
    close() {
      /* not exercised directly — use fireClose() */
    },
  };

  return {
    client,
    requests,
    notifies,
    responses,
    setServerRequestHandler(
      cb: (id: number | string, method: string, params: unknown) => void | Promise<void>,
    ) {
      onServerRequest = cb;
    },
    setNotificationHandler(cb: (method: string, params: unknown) => void) {
      onNotification = cb;
    },
    async serverRequest(id: number | string, method: string, params: unknown) {
      await onServerRequest?.(id, method, params);
    },
    /**
     * Fire-and-forget server request — mirrors the REAL transport, whose
     * `dispatch()` schedules `onServerRequest` via `void Promise.resolve().then`
     * and never awaits it on the read path. Use this for a SLOW / human-gated
     * approval so the test does not block on the handler settling.
     */
    dispatchServerRequest(id: number | string, method: string, params: unknown) {
      void Promise.resolve().then(() => onServerRequest?.(id, method, params));
    },
    deliverNotification(method: string, params: unknown) {
      onNotification?.(method, params);
    },
    /**
     * Simulate the transport closing (tracked child died): reject all
     * outstanding requests and fire every registered onClose callback —
     * exactly what `createJsonRpcClient.close()` does.
     */
    fireClose(err?: Error) {
      if (closed) return;
      closed = true;
      const rejection = err ?? new Error("JSON-RPC client closed");
      for (const req of requests) {
        if (!req.__settled) {
          req.__settled = true;
          req.reject(rejection);
        }
      }
      for (const cb of closeCallbacks) cb();
    },
    async waitForRequest(method: string): Promise<ScriptedRequest> {
      for (let i = 0; i < 50; i++) {
        const found = requests.find((r) => r.method === method && !r.__settled);
        if (found) return found;
        await Promise.resolve();
      }
      throw new Error(
        `request ${method} never sent; saw: ${requests.map((r) => r.method).join(",")}`,
      );
    },
  };
}

function resolveReq(req: ScriptedRequest, result: unknown) {
  req.__settled = true;
  req.resolve(result);
}

function makeAccumulator(result: Partial<NeutralIntermediate> = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const acc: AppServerAccumulator = {
    onNotification(method, params) {
      calls.push({ method, params });
    },
    result() {
      return {
        summary: "",
        usage: null,
        errorMessage: null,
        errorCode: null,
        ...result,
      };
    },
  };
  return { acc, calls };
}

function baseInput(fake: ReturnType<typeof makeFakeClient>, acc: AppServerAccumulator) {
  return {
    runId: "run-1",
    cwd: "/work/proj",
    input: [{ type: "text" as const, text: "do the thing" }],
    approvalPolicy: "untrusted" as const,
    timeoutSec: 0,
    client: fake.client,
    accumulator: acc,
    onServerApproval: async () => "accept" as const,
    registerServerRequestHandler: fake.setServerRequestHandler,
    registerNotificationHandler: fake.setNotificationHandler,
  };
}

/** Drive initialize→initialized→thread/start→turn/start, resolving the turn/start request. */
async function driveHandshake(
  fake: ReturnType<typeof makeFakeClient>,
  threadId: string,
) {
  const init = await fake.waitForRequest("initialize");
  resolveReq(init, { userAgent: "x" });
  const start = await fake.waitForRequest("thread/start");
  resolveReq(start, { thread: { id: threadId } });
  const turn = await fake.waitForRequest("turn/start");
  return { turn };
}

describe("driveCodexAppServer failure modes (W5c Task 8)", () => {
  // ---------------------------------------------------------------------------
  // #1 user-never-answers: broker returns { timedOut } → bridge decline → the
  //    approval is answered decline and the turn still ends normally (no hang).
  // ---------------------------------------------------------------------------
  it("#1 user never answers (broker timeout) → decline, turn still completes", async () => {
    const fake = makeFakeClient();
    const { acc } = makeAccumulator();
    // The real bridge maps { timedOut } → "decline"; here the injected
    // onServerApproval is the bridge, so it returns "decline".
    const onServerApproval = vi.fn(async () => "decline" as const);

    const promise = driveCodexAppServer({ ...baseInput(fake, acc), onServerApproval });
    const { turn } = await driveHandshake(fake, "thread-to");
    resolveReq(turn, { turn: { id: "t1" } });

    await fake.serverRequest(1, "item/commandExecution/requestApproval", { command: "x" });
    expect(fake.responses).toContainEqual({ id: 1, result: { decision: "decline" } });

    // The turn continues and ends — no hang.
    fake.deliverNotification("turn/completed", {});
    const result = await promise;
    expect(result.sessionId).toBe("thread-to");
    expect(result.timedOut).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // #2 (headline) run cancelled mid-approval: the tracked child dies → the
  //    transport closes → outstanding requests reject AND the driver's onClose
  //    fires → the driver UNWINDS (settles a synthesized turn/failed) instead of
  //    hanging until the timeout. Proven with fake timers: the promise settles
  //    BEFORE any timeout elapses.
  // ---------------------------------------------------------------------------
  it("#2 child dies mid-turn (after turn/start, before terminal) → driver unwinds, no hang", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeClient();
      const { acc, calls } = makeAccumulator();
      // A slow/human approval that never resolves before the cancel.
      let approvalReleased = false;
      const onServerApproval = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            // Only settles if the test releases (it won't — cancel comes first).
            void resolve;
            approvalReleased = true;
          }),
      );

      const promise = driveCodexAppServer({
        ...baseInput(fake, acc),
        timeoutSec: 600, // large — prove we settle WAY before this
        onServerApproval,
      });

      const init = await fake.waitForRequest("initialize");
      resolveReq(init, {});
      const start = await fake.waitForRequest("thread/start");
      resolveReq(start, { thread: { id: "thread-cancel" } });
      const turn = await fake.waitForRequest("turn/start");
      // turn/start RESOLVED (accepted) — but no turn/completed will ever come.
      resolveReq(turn, { turn: { id: "t1" } });

      // A slow approval is outstanding (fire-and-forget, like the real transport).
      fake.dispatchServerRequest(5, "item/commandExecution/requestApproval", { command: "x" });
      await Promise.resolve();
      await Promise.resolve();
      expect(approvalReleased).toBe(true); // the approval handler is now outstanding

      // The run is cancelled: heartbeat.cancelRun signals the tracked child, it
      // dies, the JSON-RPC transport closes → reject-pending + fire onClose.
      fake.fireClose(new Error("app-server closed"));

      // The driver must settle from the close hook — NOT from the timeout.
      // We do NOT advance timers past a tiny slice; if the driver hangs, this
      // await would never resolve.
      const result = await promise;

      expect(result.timedOut).toBe(false);
      expect(result.sessionId).toBe("thread-cancel");
      // A synthesized terminal turn event was fed to the accumulator so the
      // result surfaces the failure.
      expect(calls.some((c) => c.method === "turn/failed")).toBe(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("#2b close-then-real-terminal does not double-settle (idempotent)", async () => {
    const fake = makeFakeClient();
    const { acc, calls } = makeAccumulator();
    const promise = driveCodexAppServer({ ...baseInput(fake, acc), timeoutSec: 0 });

    const { turn } = await driveHandshake(fake, "thread-dbl");
    resolveReq(turn, { turn: { id: "t1" } });

    // Close first (settles once via the close hook)…
    fake.fireClose();
    // …then a stray real terminal notification arrives — must not re-resolve or
    // throw. settleTurn's turnResolved flag guards this.
    fake.deliverNotification("turn/failed", { turn: { error: { message: "late" } } });

    const result = await promise;
    // Exactly ONE synthesized close turn/failed + the late one were both routed
    // to the accumulator, but the driver resolved exactly once.
    expect(result.sessionId).toBe("thread-dbl");
    expect(calls.filter((c) => c.method === "turn/failed").length).toBeGreaterThanOrEqual(1);
  });

  it("#2c close BEFORE the handshake finishes rejects and does not hang", async () => {
    const fake = makeFakeClient();
    const { acc } = makeAccumulator();
    const promise = driveCodexAppServer({ ...baseInput(fake, acc), timeoutSec: 0 });

    // The very first request (initialize) is outstanding when the child dies.
    await fake.waitForRequest("initialize");
    fake.fireClose(new Error("app-server closed"));

    // initialize rejects → the driver's await client.request("initialize")
    // rejects → driveCodexAppServer rejects (the caller/Task-5 wrapper handles
    // it). It must not hang.
    await expect(promise).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // #3 codex crash / error willRetry: an `error` notification (willRetry) is
  //    routed to the accumulator (sets errorMessage), then a hard child exit
  //    closes the transport once → single settle, no double-answer.
  // ---------------------------------------------------------------------------
  it("#3 error(willRetry) notification then hard close → single settle", async () => {
    const fake = makeFakeClient();
    const { acc, calls } = makeAccumulator({ errorMessage: "retrying" });
    const promise = driveCodexAppServer({ ...baseInput(fake, acc), timeoutSec: 0 });

    const { turn } = await driveHandshake(fake, "thread-err");
    resolveReq(turn, { turn: { id: "t1" } });

    // A non-terminal error notification (willRetry) — routed but NOT terminal.
    fake.deliverNotification("error", { message: "network blip", willRetry: true });
    // Hard child exit closes the transport.
    fake.fireClose(new Error("app-server closed"));

    const result = await promise;
    expect(calls.some((c) => c.method === "error")).toBe(true);
    expect(result.errorMessage).toBe("retrying");
    // The close settled exactly one synthesized turn/failed.
    expect(calls.filter((c) => c.method === "turn/failed").length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // #4 malformed message: a garbage approval request (unknown method, no known
  //    shape) must NEVER become an accept. The driver routes it to the bridge;
  //    with no bridge or a throwing bridge it declines. Here we prove the driver
  //    never auto-accepts a malformed request on its own.
  // ---------------------------------------------------------------------------
  it("#4 malformed / unknown approval request → never fail-open (decline)", async () => {
    const fake = makeFakeClient();
    const { acc } = makeAccumulator();
    // Bridge throws on the weird method — driver must fail closed.
    const onServerApproval = vi.fn(async () => {
      throw new Error("unrecognized");
    });
    const promise = driveCodexAppServer({ ...baseInput(fake, acc), onServerApproval });

    const { turn } = await driveHandshake(fake, "thread-mal");
    resolveReq(turn, { turn: { id: "t1" } });

    await fake.serverRequest(99, "item/somethingWeird/requestApproval", { junk: true });
    // Fail-closed: decline, NEVER accept.
    expect(fake.responses).toContainEqual({ id: 99, result: { decision: "decline" } });
    expect(fake.responses.some((r) => {
      const res = r.result as { decision?: string };
      return res.decision === "accept" || res.decision === "acceptForSession";
    })).toBe(false);

    fake.deliverNotification("turn/completed", {});
    await promise;
  });

  // ---------------------------------------------------------------------------
  // #5 duplicate approval for the same itemId: the server (re)sends an approval
  //    request for the same itemId. The driver answers EACH independently — no
  //    hang, no crash. (Decision: answer-each-independently; no caching needed —
  //    the bridge is idempotent and fail-closed, so a re-ask is simply re-asked.)
  // ---------------------------------------------------------------------------
  it("#5 duplicate approval for same itemId → each answered (no hang/crash)", async () => {
    const fake = makeFakeClient();
    const { acc } = makeAccumulator();
    const onServerApproval = vi.fn(async () => "accept" as const);
    const promise = driveCodexAppServer({ ...baseInput(fake, acc), onServerApproval });

    const { turn } = await driveHandshake(fake, "thread-dup");
    resolveReq(turn, { turn: { id: "t1" } });

    fake.deliverNotification("item/started", {
      item: { type: "fileChange", id: "call_D", changes: [{ path: "src/d.ts" }] },
    });

    // Two approval requests for the SAME itemId but distinct request ids.
    await fake.serverRequest(20, "item/fileChange/requestApproval", { itemId: "call_D", turnId: "t1" });
    await fake.serverRequest(21, "item/fileChange/requestApproval", { itemId: "call_D", turnId: "t1" });

    // BOTH answered (distinct response ids); neither hangs.
    expect(fake.responses).toContainEqual({ id: 20, result: { decision: "accept" } });
    expect(fake.responses).toContainEqual({ id: 21, result: { decision: "accept" } });
    expect(onServerApproval).toHaveBeenCalledTimes(2);

    fake.deliverNotification("turn/completed", {});
    await promise;
  });

  // ---------------------------------------------------------------------------
  // #6 stdin write-after-close: once the transport closed, respond()/notify()
  //    from the driver are swallowed (no throw / unhandled rejection). Here the
  //    approval resolves AFTER the close; the respond is a no-op.
  // ---------------------------------------------------------------------------
  it("#6 respond after close is swallowed (no unhandled rejection)", async () => {
    const fake = makeFakeClient();
    const { acc } = makeAccumulator();
    let releaseApproval!: (d: string) => void;
    const onServerApproval = vi.fn(
      () => new Promise<string>((resolve) => { releaseApproval = resolve; }),
    );
    const promise = driveCodexAppServer({ ...baseInput(fake, acc), timeoutSec: 0, onServerApproval });

    const { turn } = await driveHandshake(fake, "thread-wac");
    resolveReq(turn, { turn: { id: "t1" } });

    // Approval is outstanding (fire-and-forget, like the real transport).
    fake.dispatchServerRequest(30, "item/commandExecution/requestApproval", { command: "x" });
    await Promise.resolve();
    await Promise.resolve();

    // The transport closes (child died) — driver unwinds.
    fake.fireClose();
    const result = await promise;
    expect(result.sessionId).toBe("thread-wac");

    // NOW the slow approval resolves — the driver's respond(30, …) must be
    // swallowed by the (closed) client, not throw.
    releaseApproval("accept");
    await Promise.resolve();
    await Promise.resolve();
    // No response was recorded because the client is closed (guarded write).
    expect(fake.responses.some((r) => r.id === 30)).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// BUG-1 secondary: the REAL codex 0.130 app-server rejection texts must classify
// as unknown-session so the driver's resume→fresh-thread fallback fires instead
// of rethrowing and failing the run (protocol doc §8b). Live-captured:
//   turn/start      → "thread not found: <uuid>"
//   thread/resume   → "no rollout found for thread id <uuid>"
// Neither matches the pre-existing alternations (`thread .* not found` needs
// text BETWEEN "thread" and "not found").
// -----------------------------------------------------------------------------
describe("isCodexUnknownSessionError — real codex 0.130 app-server texts (BUG-1)", () => {
  it("classifies turn/start's 'thread not found: <id>' as unknown-session", () => {
    expect(
      isCodexUnknownSessionError(
        "thread not found: 00000000-0000-0000-0000-000000000000",
        "",
      ),
    ).toBe(true);
  });

  it("classifies thread/resume's 'no rollout found for thread id <id>' as unknown-session", () => {
    expect(
      isCodexUnknownSessionError(
        "no rollout found for thread id 00000000-0000-0000-0000-000000000000",
        "",
      ),
    ).toBe(true);
  });
});
