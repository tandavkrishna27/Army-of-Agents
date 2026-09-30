import { describe, expect, it } from "vitest";

import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { UnsupportedProviderOperation } from "../supervisor/provider.js";
import type { SandboxProvider } from "../supervisor/provider.js";
import { makeCtx, sampleLabels } from "./support/supervisor-fixtures.js";

// The 8 core ops from the frozen vocabulary the fake must satisfy.
import { CORE_PROVIDER_OPERATIONS } from "@armyofagents/worker-protocol";
const FROZEN_CORE = CORE_PROVIDER_OPERATIONS;

describe("provider-contract — the fake satisfies the 8 core ops + explicit unsupported optionals", () => {
  it("exposes exactly the 8 frozen core ops and returns the documented typed results", async () => {
    const fake = createFakeSandboxProvider();
    const labels = sampleLabels();

    // create → {sandboxId, providerOpId, resourceLabels}
    const created = await fake.create(
      { resourceLabels: labels, command: "codex", args: ["exec"], env: {}, workloadType: "batch" },
      makeCtx(),
    );
    expect(created.sandboxId).toMatch(/^fake-sbx-/);
    expect(created.providerOpId).toMatch(/^fake-op-/);
    expect(created.resourceLabels).toEqual(labels);
    const id = created.sandboxId;

    // execute → runs INSIDE the sandbox; output is a REF, never inline bytes
    const exec = await fake.execute({ sandboxId: id, command: "codex", args: ["exec"], env: {} }, makeCtx());
    expect(exec.exitCode).toBe(0);
    expect(exec.timedOut).toBe(false);
    expect(exec.stdoutRef).toBe(`sandbox://${id}/stdout`);
    expect(exec.stderrRef).toBe(`sandbox://${id}/stderr`);
    expect(fake.executionsOf(id)).toEqual([{ command: "codex", args: ["exec"], insideSandbox: true }]);

    // list → paginated summaries; inspect → full detail
    const listed = await fake.list({ ownershipSelector: labels, pageSize: 10 }, makeCtx());
    expect(listed.resources.map((r) => r.sandboxId)).toContain(id);
    const inspected = await fake.inspect(id, makeCtx());
    expect(inspected.sandboxId).toBe(id);
    expect(inspected.state).toBe("running");

    // cancel → stops the tree
    const cancelled = await fake.cancel(id, makeCtx());
    expect(cancelled.outcome).toBe("stopped");

    // kill → idempotent stop
    const killed = await fake.kill(id, makeCtx());
    expect(killed.outcome).toBe("stopped");

    // destroy / reconcile_cleanup → {cleanupStatus, providerOpId}
    const destroyed = await fake.destroy(id, makeCtx());
    expect(destroyed.cleanupStatus).toBe("success");
    const reconciled = await fake.reconcileCleanup(id, makeCtx());
    expect(reconciled.cleanupStatus).toBe("success");
  });

  it("advertises all 8 core ops (and only core ops when no optional is scripted)", () => {
    const fake = createFakeSandboxProvider();
    for (const core of CORE_PROVIDER_OPERATIONS) {
      expect(fake.advertisedOperations.has(core)).toBe(true);
    }
    // frozen source of truth agrees
    expect([...FROZEN_CORE].sort()).toEqual([...CORE_PROVIDER_OPERATIONS].sort());
    expect(fake.advertisedOperations.has("checkpoint")).toBe(false);
    expect(fake.advertisedOperations.has("restore")).toBe(false);
    expect(fake.advertisedOperations.has("health")).toBe(false);
  });

  it("throws UnsupportedProviderOperation for every UNADVERTISED optional op", async () => {
    const fake = createFakeSandboxProvider();
    const labels = sampleLabels();
    const created = await fake.create(
      { resourceLabels: labels, command: "x", args: [], env: {}, workloadType: "batch" },
      makeCtx(),
    );
    await expect(fake.checkpoint(created.sandboxId, makeCtx())).rejects.toBeInstanceOf(UnsupportedProviderOperation);
    await expect(fake.restore(created.sandboxId, makeCtx())).rejects.toBeInstanceOf(UnsupportedProviderOperation);
    await expect(fake.health(created.sandboxId, makeCtx())).rejects.toBeInstanceOf(UnsupportedProviderOperation);
  });

  it("is structurally a SandboxProvider", () => {
    const fake: SandboxProvider = createFakeSandboxProvider();
    expect(typeof fake.create).toBe("function");
    expect(typeof fake.reconcileCleanup).toBe("function");
  });
});
