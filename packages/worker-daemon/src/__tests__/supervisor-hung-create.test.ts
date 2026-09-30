import { describe, expect, it } from "vitest";

import { createMetrics } from "../metrics/metrics.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { createSupervisor } from "../supervisor/supervisor.js";
import { collectingSink, makeHandoff, SUPERVISOR_IDENTITY } from "./support/supervisor-fixtures.js";

describe("supervisor-hung-create — a create past its deadline escalates to cancel/kill + records a failed create", () => {
  it("fires the create deadline, tears the labeled resource down, and emits a failed terminal", async () => {
    const fake = createFakeSandboxProvider({ hangCreate: true });
    const sink = collectingSink();
    const metrics = createMetrics();
    const supervisor = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      metrics,
      createDeadlineMs: 20, // small, deterministic (the hung create never wins the race)
    });

    await supervisor.accept(makeHandoff());
    expect(supervisor.activeRunCount()).toBe(0);

    // The hung create was attempted exactly once.
    expect(fake.callCount("create")).toBe(1);

    // Deadline → cleanup discovered the labeled (still "creating") resource by
    // ownership label and escalated cancel → destroy across it.
    const ops = fake.calls().filter((c) => !c.replayed).map((c) => c.op);
    expect(ops).toContain("list"); // discovered by ownership label (no sandboxId yet)
    expect(ops).toContain("cancel");
    expect(ops).toContain("destroy");

    // A failed create is RECORDED as a terminal event (create_timeout).
    expect(sink.events).toHaveLength(1);
    const terminal = sink.events[0];
    expect(terminal.eventType).toBe("terminal");
    if (terminal.eventType === "terminal") {
      expect(terminal.payload.status).toBe("failed");
      expect(terminal.payload.errorCode).toBe("create_timeout");
    }

    // sandbox_op{create,timed_out} recorded.
    expect(metrics.renderPrometheus()).toContain('sandbox_op{operation="create",outcome="timed_out"}');
  });
});
