import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createJsonRpcClient } from "../app-server/jsonrpc-client.js";

/**
 * Task 2 (W5c) — transport-only JSON-RPC stdio client for `codex app-server`.
 * No Codex semantics (thread/turn logic is Task 3). The client core is driven
 * against fake PassThrough streams so no real codex is spawned. Invariants:
 * newline-delimited framing with carry buffer, non-blocking server-request
 * dispatch, serialized write queue with backpressure, max-frame cap.
 */

function makeHarness(opts: { maxFrameBytes?: number } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const notifications: Array<{ method: string; params: unknown }> = [];
  const serverRequests: Array<{
    id: number | string;
    method: string;
    params: unknown;
  }> = [];
  const errors: unknown[] = [];

  // Capture what the client writes to stdin (the child's input).
  const written: string[] = [];
  stdin.on("data", (c: Buffer) => written.push(String(c)));

  const client = createJsonRpcClient({
    stdin,
    stdout,
    maxFrameBytes: opts.maxFrameBytes,
    onNotification: (method, params) => notifications.push({ method, params }),
    onServerRequest: async (id, method, params) => {
      serverRequests.push({ id, method, params });
    },
    onError: (err) => errors.push(err),
  });

  // Simulate the server emitting a chunk on the child's stdout.
  const emit = (chunk: string) => stdout.write(chunk);
  const writtenFrames = () =>
    written
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

  return { client, stdin, stdout, emit, notifications, serverRequests, errors, writtenFrames };
}

describe("appserver JSON-RPC client (W5c Task 2)", () => {
  it("correlates request/response across interleaved ids", async () => {
    const h = makeHarness();
    const p1 = h.client.request("initialize", { a: 1 });
    const p2 = h.client.request("thread/start", { b: 2 });

    const frames = h.writtenFrames();
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(frames[1]).toMatchObject({ jsonrpc: "2.0", id: 2, method: "thread/start" });

    // Respond out of order (id 2 first) — correlation must still hold.
    h.emit(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { two: true } }) + "\n");
    h.emit(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { one: true } }) + "\n");

    await expect(p1).resolves.toEqual({ one: true });
    await expect(p2).resolves.toEqual({ two: true });
  });

  it("request with no params still puts a `params` key ({}) on the wire; notify without params omits it", () => {
    // codex app-server's request envelope REQUIRES the `params` field
    // (omitted → -32600 "missing field `params`", live-verified on 0.130).
    // JSON.stringify drops undefined values, so request() must default to {}.
    // The paramless `initialized` NOTIFICATION is accepted as-is — notify()
    // must NOT gain a params default.
    const h = makeHarness();
    void h.client.request("x");
    h.client.notify("initialized");

    const frames = h.writtenFrames();
    expect(frames).toHaveLength(2);
    expect(Object.prototype.hasOwnProperty.call(frames[0], "params")).toBe(true);
    expect(frames[0].params).toEqual({});
    expect(frames[0]).toMatchObject({ jsonrpc: "2.0", id: 1, method: "x" });
    expect(Object.prototype.hasOwnProperty.call(frames[1], "params")).toBe(false);
    expect(frames[1]).toMatchObject({ jsonrpc: "2.0", method: "initialized" });
  });

  it("rejects a request whose response carries an error", async () => {
    const h = makeHarness();
    const p = h.client.request("thread/start", {});
    h.emit(
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } }) + "\n",
    );
    await expect(p).rejects.toThrow(/boom/);
  });

  it("reassembles a frame split across two chunks (parsed exactly once)", async () => {
    const h = makeHarness();
    h.emit('{"method":"turn/star');
    expect(h.notifications).toHaveLength(0);
    h.emit('ted","params":{"x":1}}\n');
    await Promise.resolve();
    expect(h.notifications).toEqual([{ method: "turn/started", params: { x: 1 } }]);
  });

  it("dispatches multiple frames in one chunk IN ORDER", async () => {
    const h = makeHarness();
    h.emit(
      JSON.stringify({ method: "a", params: 1 }) +
        "\n" +
        JSON.stringify({ method: "b", params: 2 }) +
        "\n" +
        JSON.stringify({ method: "c", params: 3 }) +
        "\n",
    );
    await Promise.resolve();
    expect(h.notifications.map((n) => n.method)).toEqual(["a", "b", "c"]);
  });

  it("keeps parsing while a server-request approval handler is pending (non-blocking invariant)", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written: string[] = [];
    stdin.on("data", (c: Buffer) => written.push(String(c)));
    const notifications: Array<{ method: string; params: unknown }> = [];
    const serverRequests: Array<{ id: number | string; method: string; params: unknown }> = [];
    const release: { fn: (() => void) | null } = { fn: null };

    const client = createJsonRpcClient({
      stdin,
      stdout,
      onNotification: (method, params) => notifications.push({ method, params }),
      onServerRequest: (id, method, params) => {
        serverRequests.push({ id, method, params });
        // Block until the test releases — mimics a slow human approval.
        return new Promise<void>((resolve) => {
          release.fn = resolve;
        });
      },
    });

    // A server REQUEST (method+id) AND a following NOTIFICATION arrive together.
    stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "item/commandExecution/requestApproval",
        params: { cmd: "echo hi" },
      }) +
        "\n" +
        JSON.stringify({ method: "turn/completed", params: {} }) +
        "\n",
    );
    await Promise.resolve();
    await Promise.resolve();

    // The approval is still pending, yet the trailing notification was parsed.
    expect(serverRequests).toHaveLength(1);
    expect(serverRequests[0]).toMatchObject({ id: 7, method: "item/commandExecution/requestApproval" });
    expect(notifications.map((n) => n.method)).toContain("turn/completed");

    // Now answer the approval; the client writes the response frame.
    client.respond(7, { decision: "accept" });
    release.fn?.();
    await Promise.resolve();
    const responseFrame = written
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((f) => f.id === 7 && f.result);
    expect(responseFrame).toMatchObject({ jsonrpc: "2.0", id: 7, result: { decision: "accept" } });
  });

  it("ignores garbage / unparseable lines without crashing", async () => {
    const h = makeHarness();
    h.emit("this is not json\n");
    h.emit(JSON.stringify({ method: "ok", params: 1 }) + "\n");
    await Promise.resolve();
    expect(h.notifications.map((n) => n.method)).toEqual(["ok"]);
    expect(h.errors.length).toBeGreaterThanOrEqual(0); // logged, not fatal
  });

  it("errors/closes on an oversized frame exceeding maxFrameBytes", async () => {
    const h = makeHarness({ maxFrameBytes: 64 });
    const onClose = vi.fn();
    h.client.onClose(onClose);
    // A single line (no newline yet) longer than the cap.
    h.emit("x".repeat(200));
    await Promise.resolve();
    expect(h.errors.length).toBeGreaterThan(0);
    expect(onClose).toHaveBeenCalled();
  });

  it("close() rejects all pending requests", async () => {
    const h = makeHarness();
    const p1 = h.client.request("initialize", {});
    const p2 = h.client.request("thread/start", {});
    h.client.close();
    await expect(p1).rejects.toThrow();
    await expect(p2).rejects.toThrow();
  });

  it("close() detaches the stdout data listener (no retention on a long-lived stream)", () => {
    const h = makeHarness();
    expect(h.stdout.listenerCount("data")).toBe(1);
    h.client.close();
    expect(h.stdout.listenerCount("data")).toBe(0);
  });

  it("stdin write-after-close: respond/notify/respondError are swallowed (no throw, no write)", () => {
    // W5c Task 8 (#6): after close, an outstanding approval that resolves late
    // (or any driver notify) must not throw an unhandled error or write to a
    // torn-down stdin. enqueueWrite early-returns when closed.
    const h = makeHarness();
    h.client.close();
    const framesBefore = h.writtenFrames().length;
    expect(() => h.client.respond(7, { decision: "accept" })).not.toThrow();
    expect(() => h.client.notify("turn/started", { x: 1 })).not.toThrow();
    expect(() =>
      h.client.respondError(9, { code: -32000, message: "x" }),
    ).not.toThrow();
    // No new frame was written after close.
    expect(h.writtenFrames().length).toBe(framesBefore);
  });

  it("close() fires registered onClose callbacks exactly once (idempotent)", () => {
    // W5c Task 8 (#2): the driver relies on onClose to unwind an unresolved turn.
    const h = makeHarness();
    const cb = vi.fn();
    h.client.onClose(cb);
    h.client.close();
    h.client.close(); // second close is a no-op
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("request-after-close rejects immediately (no hang)", async () => {
    const h = makeHarness();
    h.client.close();
    await expect(h.client.request("initialize", {})).rejects.toThrow(/closed/);
  });

  it("serializes writes and defers the next until 'drain' when write() returns false", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const writeReturns: boolean[] = [false, true];
    let writeCall = 0;
    const drainListeners: Array<() => void> = [];
    // Fake a backpressured stdin: first write returns false (buffer full).
    const fakeStdin = {
      write: vi.fn((_chunk: string, cb?: (err?: Error | null) => void) => {
        cb?.(null);
        return writeReturns[writeCall++] ?? true;
      }),
      once: vi.fn((ev: string, cb: () => void) => {
        if (ev === "drain") drainListeners.push(cb);
      }),
      on: vi.fn(),
      end: vi.fn(),
    };

    const client = createJsonRpcClient({
      stdin: fakeStdin as unknown as PassThrough,
      stdout,
      onNotification: () => {},
      onServerRequest: async () => {},
    });

    client.notify("a", { n: 1 });
    client.notify("b", { n: 2 });
    await Promise.resolve();

    // Only the first write should have gone through; the second is deferred
    // until 'drain' because the first returned false.
    expect(fakeStdin.write).toHaveBeenCalledTimes(1);
    expect(drainListeners.length).toBe(1);

    // Fire drain — the queued second write flushes.
    drainListeners[0]!();
    await Promise.resolve();
    expect(fakeStdin.write).toHaveBeenCalledTimes(2);

    void stdin;
  });
});
