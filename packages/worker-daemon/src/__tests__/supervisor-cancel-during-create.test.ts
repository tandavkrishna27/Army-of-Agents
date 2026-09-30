import { describe, expect, it } from "vitest";

import { createMetrics } from "../metrics/metrics.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { createSupervisor } from "../supervisor/supervisor.js";
import { collectingSink, makeGate, makeHandoff, SUPERVISOR_IDENTITY, waitFor } from "./support/supervisor-fixtures.js";

/**
 * Containment must NOT fail open when a cancel / onLeaseLost / shutdown arrives
 * while `create` is IN-FLIGHT against a provider that only registers the sandbox
 * on resolve (the real E2B runtime — `sandbox-provider-runtime.ts`). The empty
 * cleanup pass (nothing is listable yet) must NOT consume the run's terminal
 * cleanup latch, so the post-create pass reclaims the now-known live sandbox.
 *
 * The `createGate` fake models that DEFERRED REGISTRATION: while create is
 * in-flight the sandbox is not listable/inspectable, and it becomes a real
 * running sandbox only when the gate releases and create resolves. Without the
 * fix, the pre-resolve empty pass latches `cleanedUp` and the post-create
 * `if (run.cancelled)` escalation short-circuits — leaking a live tenant sandbox
 * past lease loss. These tests assert the sandbox is ALWAYS reclaimed.
 */
describe("supervisor-cancel-during-create — a sandbox created after an empty cleanup pass is still reclaimed", () => {
  it("reclaims (cancel → destroy) a sandbox whose create resolves AFTER an in-flight cancel", async () => {
    const { gate, release } = makeGate();
    // Deferred-registration provider: create only resolves after the gate, and
    // the sandbox is not listable until then (the honest E2B model).
    const fake = createFakeSandboxProvider({ createGate: gate });
    const metrics = createMetrics();
    const supervisor = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: collectingSink(),
      metrics,
    });

    const handoff = makeHandoff();
    const done = supervisor.accept(handoff);

    // create is in-flight (recorded) but the sandbox is NOT yet registered — a
    // label-scoped list finds nothing. This is the fidelity that reproduces the
    // leak; assert it so the test is non-vacuous.
    await waitFor(() => fake.callCount("create") === 1);
    expect(fake.all()).toHaveLength(0);
    const sandboxId = fake.calls().find((c) => c.op === "create")?.sandboxId;
    expect(sandboxId).toBeTruthy();

    // Cancel WHILE create is in-flight — the cleanup pass lists [] (nothing
    // registered) and must NOT consume the terminal latch.
    await supervisor.cancel(handoff.leaseId, "cancel");

    // Now let create resolve into a REAL running sandbox.
    release();
    await done;

    // The post-create pass reclaimed the now-known sandbox: it is destroyed and no
    // sandbox is left running/leaked.
    expect(fake.peek(sandboxId!)?.state).toBe("destroyed");
    expect(fake.processTreeAlive(sandboxId!)).toBe(false);
    expect(fake.all()).toHaveLength(0);
    // A real teardown ran (not just an empty no-op pass).
    expect(fake.callCount("destroy")).toBeGreaterThanOrEqual(1);

    expect(supervisor.activeRunCount()).toBe(0);
  });

  it("reclaims a sandbox whose create resolves AFTER an in-flight onLeaseLost", async () => {
    const { gate, release } = makeGate();
    const fake = createFakeSandboxProvider({ createGate: gate });
    const supervisor = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: collectingSink(),
    });

    const handoff = makeHandoff();
    const done = supervisor.accept(handoff);

    await waitFor(() => fake.callCount("create") === 1);
    expect(fake.all()).toHaveLength(0);
    const sandboxId = fake.calls().find((c) => c.op === "create")?.sandboxId;
    expect(sandboxId).toBeTruthy();

    // Lease loss while create is in-flight (effect withdrawn, empty cleanup pass).
    await supervisor.onLeaseLost(handoff.leaseId);

    release();
    await done;

    // The created sandbox is reclaimed — nothing leaks past lease loss.
    expect(fake.peek(sandboxId!)?.state).toBe("destroyed");
    expect(fake.processTreeAlive(sandboxId!)).toBe(false);
    expect(fake.all()).toHaveLength(0);
    expect(supervisor.activeRunCount()).toBe(0);
  });
});
