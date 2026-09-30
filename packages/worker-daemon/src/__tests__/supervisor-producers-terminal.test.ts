import { describe, expect, it } from "vitest";

import { verifyWorkerEventDigestV1 } from "@armyofagents/worker-protocol";

import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { createSupervisor } from "../supervisor/supervisor.js";
import { collectingSink, makeGate, makeHandoff, SUPERVISOR_IDENTITY, waitFor } from "./support/supervisor-fixtures.js";
import { sha256hex } from "./support/poll-fixtures.js";

// -----------------------------------------------------------------------------
// CLI-003/D3+D5 — the log/progress/usage producers wired around execute, and the
// ENRICHED terminal (signal/timedOut folded into the frozen errorCode/errorMessage,
// which supervisor.ts:299 previously hardcoded to null). The producers ride the
// injectable `observeRun` seam (populated from the D1 transport stream + adapter
// usage in the wired world; unit-driven here). Absent the seam, behaviour is
// unchanged (existing supervisor-happy stays green).
// -----------------------------------------------------------------------------

describe("CLI-003/D3 — producers wired around execute", () => {
  it("emits attempt_started → log → progress → usage → terminal, contiguous + digest-valid", async () => {
    const fake = createFakeSandboxProvider();
    const sink = collectingSink();
    const supervisor = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      observeRun: () => ({
        logs: [
          { stream: "stdout", level: "info", message: "building" },
          { stream: "stderr", level: "warn", message: "deprecated" },
        ],
        progress: [{ message: "compiling", percent: 50 }],
        usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 5, runtimeMillis: 900 },
      }),
    });

    await supervisor.accept(makeHandoff());

    expect(sink.events.map((e) => e.eventType)).toEqual([
      "attempt_started",
      "log",
      "log",
      "progress",
      "usage",
      "terminal",
    ]);
    expect(sink.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const event of sink.events) {
      expect(await verifyWorkerEventDigestV1(event, sha256hex)).toBe(true);
    }
    const usage = sink.events.find((e) => e.eventType === "usage");
    if (usage && usage.eventType === "usage") {
      // Evidentiary-only — the frozen .strict() schema guarantees no cost field.
      expect(Object.keys(usage.payload).sort()).toEqual([
        "cachedInputTokens",
        "inputTokens",
        "outputTokens",
        "runtimeMillis",
      ]);
    }
  });

  it("without observeRun the sequence is unchanged (attempt_started → terminal)", async () => {
    const fake = createFakeSandboxProvider();
    const sink = collectingSink();
    const supervisor = createSupervisor({ provider: fake, identity: SUPERVISOR_IDENTITY, eventSink: sink });
    await supervisor.accept(makeHandoff());
    expect(sink.events.map((e) => e.eventType)).toEqual(["attempt_started", "terminal"]);
  });

  it("instrumentation is best-effort: an observeRun throw never fails the run or its terminal", async () => {
    const fake = createFakeSandboxProvider();
    const sink = collectingSink();
    const supervisor = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      observeRun: () => {
        throw new Error("instrumentation boom");
      },
    });
    await supervisor.accept(makeHandoff());
    // The run still reaches a succeeded terminal; only the producer events are absent.
    expect(sink.events.map((e) => e.eventType)).toEqual(["attempt_started", "terminal"]);
    expect(fake.callCount("destroy")).toBe(1);
  });
});

describe("CLI-003/D3 — terminal enrichment (signal/timedOut → errorCode/errorMessage)", () => {
  it("folds a signalled exec into the terminal errorCode/errorMessage", async () => {
    const fake = createFakeSandboxProvider({ exitCode: 137, execSignal: "SIGKILL" });
    const sink = collectingSink();
    const supervisor = createSupervisor({ provider: fake, identity: SUPERVISOR_IDENTITY, eventSink: sink });
    await supervisor.accept(makeHandoff());
    const terminal = sink.events.find((e) => e.eventType === "terminal");
    expect(terminal?.eventType).toBe("terminal");
    if (terminal && terminal.eventType === "terminal") {
      expect(terminal.payload.status).toBe("failed");
      expect(terminal.payload.exitCode).toBe(137);
      expect(terminal.payload.errorCode).toBe("exec_signalled");
      expect(terminal.payload.errorMessage).toBe("signal:SIGKILL");
    }
  });

  it("folds a timed-out exec into the terminal errorCode", async () => {
    const fake = createFakeSandboxProvider({ exitCode: 0, execTimedOut: true });
    const sink = collectingSink();
    const supervisor = createSupervisor({ provider: fake, identity: SUPERVISOR_IDENTITY, eventSink: sink });
    await supervisor.accept(makeHandoff());
    const terminal = sink.events.find((e) => e.eventType === "terminal");
    if (terminal && terminal.eventType === "terminal") {
      expect(terminal.payload.status).toBe("failed");
      expect(terminal.payload.errorCode).toBe("exec_timeout");
    }
  });

  it("a clean exit stays succeeded with null errorCode/errorMessage (unchanged)", async () => {
    const fake = createFakeSandboxProvider();
    const sink = collectingSink();
    const supervisor = createSupervisor({ provider: fake, identity: SUPERVISOR_IDENTITY, eventSink: sink });
    await supervisor.accept(makeHandoff());
    const terminal = sink.events.find((e) => e.eventType === "terminal");
    if (terminal && terminal.eventType === "terminal") {
      expect(terminal.payload.status).toBe("succeeded");
      expect(terminal.payload.errorCode).toBeNull();
      expect(terminal.payload.errorMessage).toBeNull();
    }
  });
});

describe("CLI-003/D3+D6 — a cancelled run reaches a durable cancelled terminal", () => {
  it("emits terminal(cancelled) when a run is cancelled mid-execute", async () => {
    const { gate, release } = makeGate();
    const fake = createFakeSandboxProvider({ executeGate: gate });
    const sink = collectingSink();
    const supervisor = createSupervisor({ provider: fake, identity: SUPERVISOR_IDENTITY, eventSink: sink });

    const handoff = makeHandoff();
    const done = supervisor.accept(handoff);
    await waitFor(() => fake.callCount("execute") === 1);
    await supervisor.cancel(handoff.leaseId, "cancel");
    release();
    await done;

    const terminal = sink.events.find((e) => e.eventType === "terminal");
    expect(terminal?.eventType).toBe("terminal");
    if (terminal && terminal.eventType === "terminal") {
      expect(terminal.payload.status).toBe("cancelled");
    }
    expect(supervisor.activeRunCount()).toBe(0);
  });

  it("still reaches a durable terminal when execute REJECTS after cancel (cleanup killed the sandbox)", async () => {
    // The realistic path: cancel → escalateCleanup destroys the sandbox → the in-flight
    // execute REJECTS. Before the §2.1 fix this landed in the execute-catch with NO
    // terminal, stranding the attempt non-terminal until the reaper.
    let rejectExecute!: (err: Error) => void;
    const rejectingGate = new Promise<void>((_, reject) => { rejectExecute = reject; });
    const fake = createFakeSandboxProvider({ executeGate: rejectingGate });
    const sink = collectingSink();
    const supervisor = createSupervisor({ provider: fake, identity: SUPERVISOR_IDENTITY, eventSink: sink });

    const handoff = makeHandoff();
    const done = supervisor.accept(handoff);
    await waitFor(() => fake.callCount("execute") === 1);
    await supervisor.cancel(handoff.leaseId, "cancel");
    rejectExecute(new Error("sandbox destroyed during cancel"));
    await done;

    const terminal = sink.events.find((e) => e.eventType === "terminal");
    expect(terminal?.eventType).toBe("terminal");
    if (terminal && terminal.eventType === "terminal") {
      expect(terminal.payload.status).toBe("cancelled");
    }
    expect(supervisor.activeRunCount()).toBe(0);
  });

  it("forces a terminal within the op deadline when execute HANGS (supervisor-side backstop)", async () => {
    // A provider that ignores its op budget and never returns must STILL reach a
    // terminal within a bound (§2.1 within-policy). The supervisor races execute
    // against opDeadlineMs via an injected scheduler; firing the pending deadline
    // simulates the wall-clock elapsing.
    const scheduled: Array<() => void> = [];
    const fakeSchedule = (fn: () => void): number => { scheduled.push(fn); return scheduled.length; };
    const fakeCancel = (): void => { /* leave fired-once semantics to the test */ };
    const neverResolves = new Promise<void>(() => { /* hang */ });
    const fake = createFakeSandboxProvider({ executeGate: neverResolves });
    const sink = collectingSink();
    const supervisor = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      setTimeoutFn: fakeSchedule as unknown as typeof setTimeout,
      clearTimeoutFn: fakeCancel as unknown as typeof clearTimeout,
    });

    const done = supervisor.accept(makeHandoff());
    await waitFor(() => fake.callCount("execute") === 1);
    // Fire the pending execute deadline (create's already resolved + its timer no-op'd).
    scheduled[scheduled.length - 1]?.();
    await done;

    const terminal = sink.events.find((e) => e.eventType === "terminal");
    expect(terminal?.eventType).toBe("terminal");
    if (terminal && terminal.eventType === "terminal") {
      expect(terminal.payload.status).toBe("failed");
      expect(terminal.payload.errorCode).toBe("execute_timeout");
    }
    expect(supervisor.activeRunCount()).toBe(0);
  });
});
