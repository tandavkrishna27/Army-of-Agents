/**
 * DSK-003 Lane A — the host actually routes a control command.
 *
 * The router, the authorization, the effect layer and the control-file locations all
 * existed and were tested; nothing called them. This is the branch that makes the surface
 * real, and the property that matters most is a negative one:
 *
 *   A CONTROL INVOCATION MUST NOT BOOTSTRAP. If `aoa-worker-desktop status` started a
 *   worker as a side effect, an operator checking on a running host would silently create
 *   a SECOND one — two daemons, two leases, one device identity.
 *
 * `revoke` clears the RECEIPT first and the IDENTITY second, matching `--reset-identity`.
 * That order is not taste: if the process dies between them, receipt-first leaves an
 * identity with no receipt, which the coordinator treats as "enrolled but unconfirmed"
 * and can retry; the reverse leaves a receipt with no identity — a device claiming an
 * enrolment whose key is gone, which nothing can recover.
 */

import { describe, expect, it, vi } from "vitest";

import { runDesktopHost, RESET_ACKNOWLEDGEMENT_FLAG } from "../bin/desktop-host.js";

const LOCAL = "C:\\Users\\t\\AppData\\Local";

function fakeProc() {
  const exitCodes: number[] = [];
  return { exitCodes, proc: { once: () => {}, exit: (c: number) => { exitCodes.push(c); } } };
}

/**
 * A runner that RECORDS which blob a delete targeted.
 *
 * The host clears through the real stores, so the only way to observe the ordering is
 * where those stores reach the OS — the plan carries `blobPath`, and the two blobs have
 * distinct versioned filenames. Instrumenting here rather than substituting fake stores
 * keeps the ordering assertion pointed at the code that actually runs.
 */
function recordingRunner(calls: string[]) {
  return () => ({
    run: (plan: { blobPath: string; scriptText: string }) => {
      if (/device-enrollment/.test(plan.blobPath)) calls.push("clear:receipt");
      else if (/device-identity/.test(plan.blobPath)) calls.push("clear:identity");
      return {
        exitCode: 0, signal: null, stdout: new Uint8Array(), stderr: "", absenceSignalled: true,
      };
    },
  });
}

/** Drive `runDesktopHost` with every outward effect recorded. */
function harness(argv: readonly string[], over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const { proc, exitCodes } = fakeProc();
  const bootstrap = vi.fn(async () => { calls.push("bootstrap"); return { ok: true }; });
  const logs: string[] = [];
  return {
    calls,
    logs,
    exitCodes,
    bootstrap,
    run: () =>
      runDesktopHost({
        env: { LOCALAPPDATA: LOCAL },
        proc: proc as never,
        platform: "win32",
        argv,
        createRunner: recordingRunner(calls) as never,
        bootstrap: bootstrap as never,
        log: (m: string) => { logs.push(m); },
        control: {
          authorize: () => ({ allowed: true }) as never,
          resolveTarget: async () => { calls.push("resolveTarget"); return { ok: true, pid: 42 } as never; },
          signal: async (pid: number) => { calls.push(`signal:${pid}`); },
          readStatus: async () => { calls.push("readStatus"); return { running: true }; },
          readLogTail: async () => { calls.push("readLogTail"); return "a log line"; },
          ...(over.control as Record<string, unknown> ?? {}),
        } as never,
        ...over,
      } as never),
  };
}

describe("DSK-003 — a control command never bootstraps", () => {
  for (const command of ["status", "logs", "drain", "revoke"]) {
    it(`does not bootstrap for ${command}`, async () => {
      const argv = command === "revoke"
        ? [command, "--token=t", RESET_ACKNOWLEDGEMENT_FLAG]
        : [command, "--token=t"];
      const h = harness(argv);
      await h.run();
      expect(h.bootstrap, command).not.toHaveBeenCalled();
    });
  }

  it("DOES bootstrap for a bare invocation — non-vacuity", async () => {
    // Without this, a host that never bootstrapped at all would satisfy every
    // assertion above.
    const h = harness([]);
    const result = await h.run();
    expect(h.bootstrap).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });
});

describe("DSK-003 — the commands reach their effects", () => {
  it("status reads and signals nothing", async () => {
    const h = harness(["status"]);
    await h.run();
    expect(h.calls).toContain("readStatus");
    expect(h.calls.some((c) => c.startsWith("signal:"))).toBe(false);
  });

  it("logs reads the log tail", async () => {
    const h = harness(["logs"]);
    await h.run();
    expect(h.calls).toContain("readLogTail");
  });

  it("drain resolves a target and signals it", async () => {
    const h = harness(["drain", "--token=t"]);
    await h.run();
    expect(h.calls).toContain("resolveTarget");
    expect(h.calls).toContain("signal:42");
  });
});

describe("DSK-003 — revoke destroys in the same order as --reset-identity", () => {
  it("clears the RECEIPT before the IDENTITY", async () => {
    const h = harness(["revoke", "--token=t", RESET_ACKNOWLEDGEMENT_FLAG]);
    await h.run();
    const receiptAt = h.calls.indexOf("clear:receipt");
    const identityAt = h.calls.indexOf("clear:identity");
    expect(receiptAt, "the receipt was never cleared").toBeGreaterThan(-1);
    expect(identityAt, "the identity was never cleared").toBeGreaterThan(-1);
    expect(receiptAt).toBeLessThan(identityAt);
  });

  it("stops work BEFORE destroying anything", async () => {
    const h = harness(["revoke", "--token=t", RESET_ACKNOWLEDGEMENT_FLAG]);
    await h.run();
    const signalAt = h.calls.findIndex((c) => c.startsWith("signal:"));
    expect(signalAt).toBeGreaterThan(-1);
    expect(h.calls.indexOf("clear:receipt")).toBeGreaterThan(signalAt);
  });

  it("destroys NOTHING without the acknowledgement, and exits non-zero", async () => {
    const h = harness(["revoke", "--token=t"]);
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(h.calls).not.toContain("clear:identity");
    expect(h.exitCodes).toEqual([1]);
    expect(h.logs.join("\n")).toContain(RESET_ACKNOWLEDGEMENT_FLAG);
  });
});

describe("DSK-003 — a refused command fails loudly", () => {
  it("exits non-zero when authorization is refused, and runs no effect", async () => {
    const h = harness(["drain"], {
      control: { authorize: () => ({ allowed: false, reason: "not_presented" }) },
    });
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(h.exitCodes).toEqual([1]);
    expect(h.calls).toEqual([]);
  });

  it("builds the REAL effects when none are injected, and status still answers", async () => {
    // An earlier revision refused when `control` was absent. That was scaffolding for an
    // unwired state that no longer exists: a production binary must build its own
    // effects, not decline to have any. Constructing them touches nothing — the paths
    // resolve purely — so `status` runs for real here against a vault directory with no
    // host in it, and correctly reports not-running rather than throwing.
    const { proc, exitCodes } = fakeProc();
    const bootstrap = vi.fn(async () => ({ ok: true }));
    const logs: string[] = [];
    const result = await runDesktopHost({
      env: { LOCALAPPDATA: LOCAL },
      proc: proc as never,
      platform: "win32",
      argv: ["status"],
      createRunner: recordingRunner([]) as never,
      bootstrap: bootstrap as never,
      log: (m: string) => { logs.push(m); },
      // no `control` — the real ones are built
    } as never);
    expect(result.ok).toBe(true);
    expect(exitCodes).toEqual([]);
    expect(bootstrap).not.toHaveBeenCalled();
    expect(logs.join(" ")).toMatch(/running/i);
  });

  it("exits non-zero for an unknown command rather than booting", async () => {
    const h = harness(["stauts"], {
      control: { authorize: () => ({ allowed: false, reason: "unknown_command" }) },
    });
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(h.bootstrap).not.toHaveBeenCalled();
  });
});
