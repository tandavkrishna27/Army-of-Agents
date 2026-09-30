import { describe, expect, it } from "vitest";

import { createMetrics } from "../metrics/metrics.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { createSupervisor } from "../supervisor/supervisor.js";
import { collectingSink, makeGate, makeHandoff, SUPERVISOR_IDENTITY, waitFor } from "./support/supervisor-fixtures.js";

describe("supervisor-cancel-escalation — an ignored cancel escalates cancel → kill → destroy across the tree", () => {
  it("withdraws effect authority and escalates the whole process tree to destroy", async () => {
    const { gate, release } = makeGate();
    // Adversarial: the sandbox ignores BOTH cancel and kill → forced destroy.
    const fake = createFakeSandboxProvider({ ignoreCancel: true, ignoreKill: true, executeGate: gate });
    const metrics = createMetrics();
    const supervisor = createSupervisor({ provider: fake, identity: SUPERVISOR_IDENTITY, eventSink: collectingSink(), metrics });

    const handoff = makeHandoff();
    const done = supervisor.accept(handoff);
    // Hold until the run is executing INSIDE the sandbox.
    await waitFor(() => fake.callCount("execute") === 1);

    const sandboxId = fake.calls().find((c) => c.op === "create")?.sandboxId;
    expect(sandboxId).toBeTruthy();
    expect(fake.processTreeAlive(sandboxId!)).toBe(true);

    // Cancel the live run.
    await supervisor.cancel(handoff.leaseId, "cancel");

    // The stop ladder escalated cancel → kill → destroy across the tree.
    const stopOps = fake
      .calls()
      .filter((c) => !c.replayed && (c.op === "cancel" || c.op === "kill" || c.op === "destroy"))
      .map((c) => c.op);
    expect(stopOps).toEqual(["cancel", "kill", "destroy"]);

    // The process tree is gone and the resource reclaimed.
    expect(fake.processTreeAlive(sandboxId!)).toBe(false);
    expect(fake.peek(sandboxId!)?.state).toBe("destroyed");

    // The escalation reached the destroy rung.
    expect(metrics.renderPrometheus()).toContain('cleanup_escalation{escalation_stage="destroy"}');

    // Release the in-flight execute so the run settles without a double cleanup.
    release();
    await done;
    expect(supervisor.activeRunCount()).toBe(0);
  });
});
