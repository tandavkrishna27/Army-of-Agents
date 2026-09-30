import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { __testables } from "../services/internal-agent/cli-mode.js";
import { logger } from "../middleware/logger.js";

/**
 * Fake ChildProcess for the ordinary case: stdout drains, THEN the process
 * signals termination. Emits `exit` followed by `close`, mirroring Node, which
 * emits `close` only once every stdio stream has been flushed.
 */
function fakeProc(
  exitCode: number | null,
  stdout: string,
  opts: { withStdout?: boolean; stderr?: string } = {},
) {
  const withStdout = opts.withStdout !== false;
  const proc = new EventEmitter() as any;
  proc.stderr = Readable.from(opts.stderr ? [opts.stderr] : []);
  proc.exitCode = exitCode;
  proc.kill = () => {};

  const terminate = () => {
    proc.emit("exit", exitCode);
    proc.emit("close", exitCode);
  };

  if (withStdout) {
    const s = Readable.from(stdout ? [stdout] : []);
    proc.stdout = s;
    s.once("end", () => setImmediate(terminate));
  } else {
    proc.stdout = null;
    setImmediate(terminate);
  }
  return proc;
}

/**
 * Fake ChildProcess reproducing the REAL Node ordering for a fast-failing CLI:
 * `exit` fires BEFORE stdout is flushed (Node calls flushStdio() *after*
 * emitting `exit`), and `close` fires only once the pipe has drained.
 *
 * This is the maximum-probability ordering for `claude --print
 * --output-format stream-json` failing on auth: it writes its whole result in
 * one small buffer microseconds before exiting nonzero.
 */
function racingProc(exitCode: number | null, stdout: string) {
  const proc = new EventEmitter() as any;
  const s = new PassThrough();
  proc.stdout = s;
  proc.stderr = Readable.from([]);
  proc.exitCode = exitCode;
  proc.kill = () => {};

  s.once("end", () => proc.emit("close", exitCode));
  setImmediate(() => {
    proc.emit("exit", exitCode);       // stdio NOT yet flushed
    setImmediate(() => {
      s.write(stdout);
      s.end();
    });
  });
  return proc;
}

async function collect(proc: any) {
  const chunks: any[] = [];
  for await (const c of __testables.streamProcessOutput(proc, true)) chunks.push(c);
  return chunks;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("streamProcessOutput failure handling", () => {
  it("emits an error chunk when the CLI exits nonzero with no content", async () => {
    expect((await collect(fakeProc(1, ""))).some((c) => c.type === "error")).toBe(true);
  });

  it("does not emit an error chunk on a clean exit", async () => {
    expect((await collect(fakeProc(0, ""))).some((c) => c.type === "error")).toBe(false);
  });

  it("still errors when only a progress chunk preceded a nonzero exit", async () => {
    const line = JSON.stringify({ type: "system", subtype: "init", session_id: "x" });
    expect((await collect(fakeProc(1, line + "\n"))).some((c) => c.type === "error")).toBe(true);
  });

  it("does not double-report when an explicit error already arrived", async () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 401,
      result: "Failed to authenticate.",
      usage: {},
      duration_ms: 1,
    });
    const errs = (await collect(fakeProc(1, line + "\n"))).filter((c) => c.type === "error");
    expect(errs).toHaveLength(1);
  });

  it("errors on signal termination (null exit code)", async () => {
    expect((await collect(fakeProc(null, ""))).some((c) => c.type === "error")).toBe(true);
  });

  it("errors when the child emits an error event (spawn failure)", async () => {
    const proc = fakeProc(0, "");
    setImmediate(() => proc.emit("error", new Error("ENOENT")));
    expect((await collect(proc)).some((c) => c.type === "error")).toBe(true);
  });

  it("errors when the process has no stdout", async () => {
    const proc = fakeProc(1, "", { withStdout: false });
    expect((await collect(proc)).some((c) => c.type === "error")).toBe(true);
  });

  it("does not double-report when both error and exit fire", async () => {
    const proc = fakeProc(1, "");
    setImmediate(() => proc.emit("error", new Error("boom")));
    expect((await collect(proc)).filter((c) => c.type === "error")).toHaveLength(1);
  });

  it("does not double-report when error and exit fire in the SAME tick", async () => {
    // The ordering that actually exercises the idempotency guard: both events
    // land before the consumer resumes, so both terminal chunks would be queued
    // and drained. With `error`-then-`exit` on separate ticks the generator has
    // already returned by the second event, and a missing guard is invisible.
    // Built by hand: fakeProc schedules its own exit, which would terminate the
    // consumer before the same-tick pair below could be observed.
    const proc = new EventEmitter() as any;
    proc.stdout = Readable.from([]);
    proc.stderr = Readable.from([]);
    proc.exitCode = 1;
    setImmediate(() => {
      proc.emit("error", new Error("boom"));
      proc.emit("close", 1);
    });
    expect((await collect(proc)).filter((c) => c.type === "error")).toHaveLength(1);
  });

  it("does not error when real assistant text was streamed before a nonzero exit", async () => {
    // NOTE: an `assistant` event's text block emits NO chunk — parse-stream-json
    // skips it because text streams incrementally via stream_event text_delta
    // (parse-stream-json.ts:202). The real text-producing shape is stream_event.
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hello" },
      },
    });
    const chunks = await collect(fakeProc(1, line + "\n"));
    expect(chunks.some((c) => c.type === "text" && c.delta === "hello")).toBe(true);
    expect(chunks.some((c) => c.type === "error")).toBe(false);
  });

  it("does not treat an empty text delta as content", async () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "" } },
    });
    expect((await collect(fakeProc(1, line + "\n"))).some((c) => c.type === "error")).toBe(true);
  });

  it("never emits a done chunk (the caller owns the single-done invariant)", async () => {
    expect((await collect(fakeProc(1, ""))).some((c) => c.type === "done")).toBe(false);
  });
});

describe("streamProcessOutput exit/stdout race (I1)", () => {
  // Node emits `exit` BEFORE flushing stdio. Terminating on `exit` alone
  // destroys output that was already written but not yet delivered.
  const AUTH_FAILURE_LINE = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    api_error_status: 401,
    result: "Failed to authenticate.",
    usage: {},
    duration_ms: 1,
  });

  it("preserves a real result event that lands AFTER exit fires", async () => {
    const chunks = await collect(racingProc(1, AUTH_FAILURE_LINE + "\n"));
    const errs = chunks.filter((c) => c.type === "error");

    // The CLI's own reason must survive — not be replaced by the generic text.
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain("Failed to authenticate");
    expect(errs[0].message).not.toContain("without producing output");
  });

  it("preserves assistant text that lands AFTER a clean exit fires", async () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
    });
    const chunks = await collect(racingProc(0, line + "\n"));
    expect(chunks.some((c) => c.type === "text" && c.delta === "hello")).toBe(true);
    expect(chunks.some((c) => c.type === "error")).toBe(false);
  });

  it("still reports the failure when the late-flushed output is genuinely empty", async () => {
    const chunks = await collect(racingProc(1, ""));
    expect(chunks.filter((c) => c.type === "error")).toHaveLength(1);
  });

  it("does not hang when close never arrives (grandchild holds the pipe)", async () => {
    // A grandchild (MCP server, bash tool) inheriting stdout keeps the pipe
    // open, so `close` never fires. The bounded grace timer must still finish.
    vi.useFakeTimers();
    try {
      const proc = new EventEmitter() as any;
      proc.stdout = new PassThrough();   // never ends
      proc.stderr = Readable.from([]);
      proc.exitCode = 1;

      const collected = collect(proc);
      await Promise.resolve();
      proc.emit("exit", 1);              // exit only — no close, ever
      await vi.advanceTimersByTimeAsync(__testables.STDIO_DRAIN_GRACE_MS + 10);

      expect((await collected).some((c) => c.type === "error")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("streamProcessOutput failure message content", () => {
  it("names termination for a signalled death", async () => {
    const errs = (await collect(fakeProc(null, ""))).filter((c) => c.type === "error");
    expect(errs[0].message).toMatch(/terminated/i);
  });

  it("names the exit code for a nonzero exit", async () => {
    const errs = (await collect(fakeProc(3, ""))).filter((c) => c.type === "error");
    expect(errs[0].message).toContain("code 3");
    expect(errs[0].message).not.toMatch(/terminated/i);
  });

  it("reports a missing stdout pipe as such, not as a termination", async () => {
    const errs = (await collect(fakeProc(1, "", { withStdout: false }))).filter(
      (c) => c.type === "error",
    );
    expect(errs[0].message).toMatch(/no output stream/i);
    expect(errs[0].message).not.toMatch(/terminated/i);
  });
});

describe("streamProcessOutput stderr logging", () => {
  it("redacts secrets from the stderr log line", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation((() => {}) as any);
    const secret = "sk-ant-oat01-ABCDEFGHIJKLMNOP1234";

    await collect(fakeProc(0, "", { stderr: `auth failed using ${secret}\n` }));

    const stderrCalls = warn.mock.calls.filter(
      (c) => (c[0] as any)?.service === "commander-cli",
    );
    expect(stderrCalls.length).toBeGreaterThan(0);
    const logged = JSON.stringify(stderrCalls);
    expect(logged).not.toContain(secret);
    expect(logged).toContain("***REDACTED***");
  });
});
