import os from "node:os";
import { describe, expect, it } from "vitest";
import { runChildProcess } from "../server-utils.js";

/**
 * A-H11 — An unhandled `error` event on the child's stdin writable crashes the
 * whole server. When the child exits before the parent finishes writing a large
 * prompt (one that exceeds the ~64KB OS pipe buffer), the stdin stream emits
 * EPIPE / ERR_STREAM_DESTROYED. A Node writable that emits `error` with NO
 * listener throws it as an UNCAUGHT exception — and there is no
 * `uncaughtException` handler in the server, so a single bad run takes the whole
 * process down (server-wide DoS).
 *
 * This test spawns a child that exits immediately WITHOUT reading stdin and
 * feeds it a 5MB prompt. The write cannot flush before the child is gone, so the
 * pre-fix code path emits an unhandled `error` and crashes the test process.
 * After the fix (error listener + try/catch around write/end) the promise must
 * still RESOLVE with the captured exit code and nothing crashes.
 */
describe("runChildProcess stdin EPIPE (A-H11)", () => {
  const noopLog = async () => {};

  it("resolves (does not crash) when the child exits before a large stdin write flushes", async () => {
    // 5MB — far larger than the ~64KB OS pipe buffer, so the write can't flush
    // before the fast-exiting child closes its stdin.
    const bigStdin = "x".repeat(5 * 1024 * 1024);

    const result = await runChildProcess(
      "test-epipe-exit0",
      process.execPath,
      ["-e", "process.exit(0)"],
      {
        cwd: os.tmpdir(),
        env: {},
        timeoutSec: 30,
        graceSec: 1,
        onLog: noopLog,
        stdin: bigStdin,
        // Pass args directly to the node binary; do not wrap in a shell.
        shell: false,
      },
    );

    // The exact exit code may surface as 0 or null depending on whether the
    // child died via close before/after the broken pipe — the contract is that
    // the promise RESOLVES and the process survives.
    expect(result).toBeDefined();
    expect(result.timedOut).toBe(false);
    expect(typeof result.exitCode === "number" || result.exitCode === null).toBe(true);
  });

  it("resolves with a non-zero exit code when the child exits 1 without reading stdin", async () => {
    const bigStdin = "y".repeat(5 * 1024 * 1024);

    const result = await runChildProcess(
      "test-epipe-exit1",
      process.execPath,
      ["-e", "process.exit(1)"],
      {
        cwd: os.tmpdir(),
        env: {},
        timeoutSec: 30,
        graceSec: 1,
        onLog: noopLog,
        stdin: bigStdin,
        shell: false,
      },
    );

    expect(result).toBeDefined();
    expect(result.timedOut).toBe(false);
    // Exit code is 1 when close reports it; null if the pipe broke first. Either
    // way the process did not crash.
    expect(result.exitCode === 1 || result.exitCode === null).toBe(true);
  });
});
