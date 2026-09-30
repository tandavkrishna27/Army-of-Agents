// CLI-008 Unit B / P1-b — a staging step that never returns must still terminalize.
//
// ★★★ THE DEFECT THIS PINS. `stageFiles` and `resolveStagedFiles` were the only unbounded
// awaits in `accept()`. Every neighbour is raced against a deadline — secrets, create, execute —
// and staging was not. A stalled fetch or a sandbox filesystem that never returns meant
// `accept()` NEVER TERMINALIZED: no terminal event, an active sandbox retained for the life of
// the process, and the lease left non-terminal until a reaper that has no production caller.
//
// That is strictly worse than the failure the fail-closed arms were written for. A staging
// FAILURE produces `stage_input_failed` and escalates cleanup; a staging HANG produced nothing
// at all, so nothing downstream could even know the attempt was stuck.
//
// ★ Both halves are covered, because they hang for different reasons: the resolve is a network
// fetch of the bytes, the write is a push into the sandbox. Bounding one and not the other
// leaves the hang reachable.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { createMetrics } from "../metrics/metrics.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { createSupervisor } from "../supervisor/supervisor.js";
import { collectingSink, makeHandoff, SUPERVISOR_IDENTITY } from "./support/supervisor-fixtures.js";
import type { StagedFileRequest } from "../supervisor/provider.js";

const BODY = "# instructions\n";
const OBJECT_KEY = "organizations/org-1/jobs/job-1/attempts/1/00000000-0000-4000-8000-0000000000a1";

const REQUEST: StagedFileRequest = {
  path: "/home/user/.aoa/AGENTS.md",
  grant: {
    protocolVersion: 1,
    operation: "download",
    artifactId: "00000000-0000-4000-8000-0000000000a1",
    method: "GET",
    url: "https://store.example/get?sig=abc",
    headers: {},
    issuedAt: "2026-09-03T12:00:00.000Z",
    expiresAt: "2126-09-03T12:05:00.000Z",
    maxBytes: Buffer.byteLength(BODY),
    expectedSha256: createHash("sha256").update(BODY).digest("hex"),
    objectKey: OBJECT_KEY,
    redaction: "secret",
  } as never,
};

describe("supervisor-hung-stage-input — an unbounded staging step must not strand the attempt", () => {
  it("★ a hanging stageFiles fires the staging deadline, terminalizes, and tears the sandbox down", async () => {
    const fake = createFakeSandboxProvider({
      fileStagingMode: "grant_download",
      hangStageFiles: true,
      stagedObjects: { [OBJECT_KEY]: "x" },
    });
    const sink = collectingSink();
    const metrics = createMetrics();
    const supervisor = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      metrics,
      // Small and deterministic: the hung write never wins the race.
      stageInputDeadlineMs: 20,
      resolveStagedFiles: async () => [REQUEST],
    });

    // ★ The assertion is that this RESOLVES AT ALL. Before the race it did not: without a
    //   deadline this await never settles and the test times out rather than failing.
    await supervisor.accept(makeHandoff());
    expect(supervisor.activeRunCount()).toBe(0);

    // A timed-out stage is RECORDED as a terminal, not swallowed.
    expect(sink.events).toHaveLength(1);
    const terminal = sink.events[0];
    expect(terminal.eventType).toBe("terminal");
    if (terminal.eventType === "terminal") {
      expect(terminal.payload.status).toBe("failed");
      expect(terminal.payload.errorCode).toBe("stage_input_timeout");
    }

    // ★ A timeout that did not clean up would trade a hang for a LEAK. The sandbox the write
    //   targeted is destroyed, which is also what makes the possibly-still-in-flight transport
    //   write harmless.
    const ops = fake.calls().filter((c) => !c.replayed).map((c) => c.op);
    expect(ops).toContain("destroy");

    expect(metrics.renderPrometheus()).toContain('sandbox_op{operation="stage_files",outcome="timed_out"}');
  });

  it("★ a hanging RESOLVE fires the same deadline — before any sandbox write is attempted", async () => {
    const fake = createFakeSandboxProvider({ fileStagingMode: "grant_download", stagedObjects: { [OBJECT_KEY]: "x" } });
    const sink = collectingSink();
    const metrics = createMetrics();
    const supervisor = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      metrics,
      stageInputDeadlineMs: 20,
      resolveStagedFiles: () => new Promise<never>(() => {}),
    });

    await supervisor.accept(makeHandoff());
    expect(supervisor.activeRunCount()).toBe(0);

    expect(sink.events).toHaveLength(1);
    const terminal = sink.events[0];
    if (terminal.eventType === "terminal") {
      expect(terminal.payload.status).toBe("failed");
      expect(terminal.payload.errorCode).toBe("stage_input_timeout");
    }
    // Nothing was staged: the resolve never produced a request to stage.
    // ★ Asserted on the METRIC, not on `fake.callCount("stage_files")` — the double does not
    //   record stageFiles among its ops, so that count is vacuously 0 whether or not the write
    //   happened, and would have passed against a broken fix.
    const rendered = metrics.renderPrometheus();
    expect(rendered).toContain('sandbox_op{operation="stage_files",outcome="timed_out"}');
    expect(rendered).not.toContain('sandbox_op{operation="stage_files",outcome="success"}');
  });

  it("the deadline is ONE budget across both halves, not one each", async () => {
    // ★ The resolve deliberately consumes MOST of the step budget and then succeeds. If the
    //   write were given a fresh 40 ms the step's real bound would be 80 ms while the knob read
    //   40 — a bound nobody can compute from the config. With the budget subtracted, the write
    //   gets what is left and the step still terminalizes inside its stated bound.
    const fake = createFakeSandboxProvider({
      fileStagingMode: "grant_download",
      hangStageFiles: true,
      stagedObjects: { [OBJECT_KEY]: "x" },
    });
    const sink = collectingSink();
    const supervisor = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      metrics: createMetrics(),
      stageInputDeadlineMs: 40,
      resolveStagedFiles: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return [REQUEST];
      },
    });

    const startedAt = Date.now();
    await supervisor.accept(makeHandoff());
    const elapsed = Date.now() - startedAt;

    expect(sink.events).toHaveLength(1);
    const terminal = sink.events[0];
    if (terminal?.eventType !== "terminal") throw new Error("expected a terminal event");
    expect(terminal.payload.errorCode).toBe("stage_input_timeout");
    // Generous upper bound — the point is that it is nowhere near 30 + 40, not the exact number.
    expect(elapsed).toBeLessThan(70);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A SECOND defect, found only because the tests above used a REAL metrics registry.
// ─────────────────────────────────────────────────────────────────────────────
describe("supervisor stage_files metric — the label must be REGISTERED, or a staged run strands", () => {
  it("★★★ a SUCCESSFUL stage emits its metric and reaches a normal terminal", async () => {
    // ★★★ WHAT THIS CAUGHT. `emitOp` calls `metrics.inc(SANDBOX_OP_METRIC, {operation, outcome})`
    // and the `operation` label is a CLOSED allow-list mirroring the frozen PROVIDER_OPERATIONS
    // vocabulary. `stage_files` is deliberately NOT in that vocabulary — the Unit B decision was
    // to grow the non-frozen port and leave the wire alone — so it was never registered, and
    // `assertBoundedLabels` THREW on every emit.
    //
    // The throw is not caught by the staging arms: it happens INSIDE them, so the failure arm
    // re-throws from its own emit, and the escape lands in `accept`'s last-resort catch, which
    // emits NO TERMINAL. The success path at the end of a healthy stage threw just as readily.
    // In production `dispatch-runtime.ts:205` passes a real registry, so EVERY distributed run
    // carrying staged files would have been torn down and stranded non-terminal — the exact
    // outcome the fail-closed arms exist to prevent, reached by the happy path.
    //
    // It was invisible because no staging test composed a real registry: the server-side
    // integration test passes none, so `deps.metrics?.inc` was a silent no-op everywhere the
    // channel was exercised. A metric nothing ever emits against a real registry is not a
    // metric; it is a line of code that has never run.
    const fake = createFakeSandboxProvider({
      fileStagingMode: "grant_download",
      stagedObjects: { [OBJECT_KEY]: BODY },
    });
    const sink = collectingSink();
    const metrics = createMetrics();
    const supervisor = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      metrics,
      resolveStagedFiles: async () => [REQUEST],
    });

    await supervisor.accept(makeHandoff());

    // The run completed normally — no lifecycle escape, and the stage did happen. The metric
    // itself is the evidence on both counts: it is emitted only after a successful write, and
    // emitting it at all is what used to throw.
    expect(metrics.renderPrometheus()).toContain('sandbox_op{operation="stage_files",outcome="success"}');
    // It got past staging to the actual work — the ordering the channel exists to serve.
    expect(fake.calls().map((c) => c.op)).toContain("execute");
    const terminal = sink.events.find((e) => e.eventType === "terminal");
    expect(terminal).toBeDefined();
    if (terminal?.eventType !== "terminal") throw new Error("expected a terminal event");
    // ★ The load-bearing part: a terminal EXISTS and is not a staging failure. Before the label
    //   was registered there was no terminal at all.
    expect(terminal.payload.errorCode).not.toBe("stage_input_failed");
  });
});
