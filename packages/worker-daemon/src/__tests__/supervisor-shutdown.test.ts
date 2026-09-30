import { describe, expect, it } from "vitest";

import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { createSupervisor } from "../supervisor/supervisor.js";
import { collectingSink, makeGate, makeHandoff, SUPERVISOR_IDENTITY, waitFor } from "./support/supervisor-fixtures.js";

describe("supervisor-shutdown — shutdown cancels the tree and lets cleanup converge", () => {
  it("cancels an in-flight run's process tree, converges cleanup, and settles the run", async () => {
    const { gate, release } = makeGate();
    const fake = createFakeSandboxProvider({ executeGate: gate });
    const supervisor = createSupervisor({ provider: fake, identity: SUPERVISOR_IDENTITY, eventSink: collectingSink() });

    const done = supervisor.accept(makeHandoff());
    await waitFor(() => fake.callCount("execute") === 1);

    const sandboxId = fake.calls().find((c) => c.op === "create")?.sandboxId;
    expect(fake.processTreeAlive(sandboxId!)).toBe(true);
    expect(supervisor.activeRunCount()).toBe(1);

    // Shutdown: cancel the tree + converge cleanup for every live run.
    await supervisor.shutdown();

    // The tree was cancelled and the resource reclaimed (converged).
    const stopOps = fake
      .calls()
      .filter((c) => !c.replayed && (c.op === "cancel" || c.op === "destroy"))
      .map((c) => c.op);
    expect(stopOps).toContain("cancel");
    expect(stopOps).toContain("destroy");
    expect(fake.processTreeAlive(sandboxId!)).toBe(false);
    expect(fake.peek(sandboxId!)?.state).toBe("destroyed");

    // Release the in-flight execute; the accepted run settles cleanly.
    release();
    await done;
    expect(supervisor.activeRunCount()).toBe(0);
  });
});
