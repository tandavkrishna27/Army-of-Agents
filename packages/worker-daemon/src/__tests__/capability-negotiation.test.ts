import { describe, expect, it } from "vitest";

import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { UnsupportedProviderOperation } from "../supervisor/provider.js";
import { makeCtx, sampleLabels } from "./support/supervisor-fixtures.js";

async function createOn(fake: ReturnType<typeof createFakeSandboxProvider>) {
  const created = await fake.create(
    { resourceLabels: sampleLabels(), command: "x", args: [], env: {}, workloadType: "batch" },
    makeCtx(),
  );
  return created.sandboxId;
}

describe("capability-negotiation — advertised vs unadvertised optional ops", () => {
  it("advertising checkpoint/restore gates them ON (with the negotiated checkpoint mode)", async () => {
    const fake = createFakeSandboxProvider({
      optionalOperations: ["checkpoint", "restore"],
      checkpointMode: "snapshot",
    });
    const id = await createOn(fake);
    expect(fake.advertisedOperations.has("checkpoint")).toBe(true);
    expect(fake.advertisedOperations.has("restore")).toBe(true);
    expect(fake.checkpointMode).toBe("snapshot");

    const cp = await fake.checkpoint(id, makeCtx());
    expect(cp.mode).toBe("snapshot");
    const restored = await fake.restore(id, makeCtx());
    expect(restored.restored).toBe(true);

    // health was NOT advertised → still gated OFF.
    expect(fake.advertisedOperations.has("health")).toBe(false);
    await expect(fake.health(id, makeCtx())).rejects.toBeInstanceOf(UnsupportedProviderOperation);
  });

  it("advertising health gates it ON (with the negotiated health mode); others stay OFF", async () => {
    const fake = createFakeSandboxProvider({ optionalOperations: ["health"], healthMode: "poll" });
    const id = await createOn(fake);
    expect(fake.healthMode).toBe("poll");
    const health = await fake.health(id, makeCtx());
    expect(health.mode).toBe("poll");
    expect(health.status).toBe("healthy");

    await expect(fake.checkpoint(id, makeCtx())).rejects.toBeInstanceOf(UnsupportedProviderOperation);
    await expect(fake.restore(id, makeCtx())).rejects.toBeInstanceOf(UnsupportedProviderOperation);
  });

  it("advertising NONE leaves every optional op gated OFF (default modes are 'none')", async () => {
    const fake = createFakeSandboxProvider();
    expect(fake.checkpointMode).toBe("none");
    expect(fake.healthMode).toBe("none");
    const id = await createOn(fake);
    await expect(fake.checkpoint(id, makeCtx())).rejects.toBeInstanceOf(UnsupportedProviderOperation);
    await expect(fake.restore(id, makeCtx())).rejects.toBeInstanceOf(UnsupportedProviderOperation);
    await expect(fake.health(id, makeCtx())).rejects.toBeInstanceOf(UnsupportedProviderOperation);
  });
});
