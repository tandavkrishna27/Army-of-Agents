import os from "node:os";
import { describe, expect, it } from "vitest";
import { runningProcesses } from "@armyofagents/adapter-utils/server-utils";
import { spawnAppServerClient } from "../app-server/jsonrpc-client.js";

/**
 * W5c Task 8 (#7) — runningProcesses cleanup at the spawnAppServerClient level.
 *
 * spawnAppServerClient spawns the long-lived `codex app-server` child THROUGH
 * spawnTrackedChild (so heartbeat.cancelRun can find + kill it while it is
 * blocked on a human approval). This asserts the two coupled invariants after
 * the child exits:
 *   - the tracked child is REMOVED from `runningProcesses` (spawnTrackedChild's
 *     child.on("close") delete — the run is no longer un-reapable), AND
 *   - the JSON-RPC client is CLOSED (the wrapper's child.on("close") → client.close()),
 *     so a late `request` rejects instead of hanging (feeds the driver's unwind).
 *
 * We don't have a real `codex` binary in CI, so we spawn node with a bogus
 * "app-server" arg: node fails to find the script and exits promptly, firing the
 * SAME `close` event the real child would. The wire framing / approval semantics
 * are covered by the transport + driver unit tests; here we only exercise the
 * spawn wrapper's teardown wiring.
 */
describe("spawnAppServerClient teardown (W5c Task 8 #7)", () => {
  it("removes the tracked child from runningProcesses and closes the client on child exit", async () => {
    const runId = `appserver-teardown-${Date.now()}`;
    const spawned = spawnAppServerClient({
      runId,
      command: process.execPath, // node, in place of `codex`
      cwd: os.tmpdir(),
      env: {},
      graceSec: 1,
      shell: false, // spawn node directly (no shell quoting of the exec path)
    });

    // Registered at spawn.
    expect(runningProcesses.has(runId)).toBe(true);

    // Wait for the child to exit (node errors on the missing "app-server"
    // script and exits) — the close event drives both teardown paths.
    await new Promise<void>((resolve) => {
      spawned.child.on("close", () => resolve());
      spawned.child.on("error", () => resolve());
    });
    // Give the microtask/close listeners a tick to run their delete + close.
    await new Promise((r) => setTimeout(r, 20));

    // #7: no longer tracked → the run is reapable / not leaked.
    expect(runningProcesses.has(runId)).toBe(false);

    // The client closed too → a late request rejects (no hang).
    await expect(spawned.client.request("initialize", {})).rejects.toThrow();
  });

  it("attaches a stderr drain listener at spawn (deadlock fix — I1)", async () => {
    // I1: `codex app-server` writes to stderr during normal operation. Because a
    // supervised turn is long-lived (blocks up to the 300s approval SLA), an
    // UNCONSUMED stderr pipe fills the OS buffer (~64KB) and then BLOCKS the child
    // on its next stderr write → the turn deadlocks and degrades to a timeout.
    // The fix: spawnAppServerClient ALWAYS attaches a `data` listener to the
    // child's stderr (the listener EXISTING is what drains the pipe). This asserts
    // that wiring directly — the load-bearing property of the fix — and that a
    // provided `onStderr` receives the drained bytes.
    const runId = `appserver-stderr-drain-${Date.now()}`;
    const chunks: string[] = [];
    const spawned = spawnAppServerClient({
      runId,
      command: process.execPath, // node, in place of `codex`
      cwd: os.tmpdir(),
      env: {},
      graceSec: 1,
      shell: false,
      onStderr: (chunk) => {
        chunks.push(chunk);
      },
    });

    // The drain listener EXISTING is what prevents the deadlock. This is the
    // direct proof of the fix — regardless of what the fake child writes.
    expect(spawned.child.stderr?.listenerCount("data")).toBeGreaterThanOrEqual(1);

    // node errors on the missing "app-server" script and writes a diagnostic to
    // stderr before exiting — exercising the drain + forward path end-to-end.
    await new Promise<void>((resolve) => {
      spawned.child.on("close", () => resolve());
      spawned.child.on("error", () => resolve());
    });
    await new Promise((r) => setTimeout(r, 20));

    // The child wrote its "Cannot find module" diagnostic to stderr → drained +
    // forwarded to onStderr (best-effort; proves the wiring carries bytes).
    expect(chunks.join("").length).toBeGreaterThan(0);

    spawned.client.close();
  });
});
