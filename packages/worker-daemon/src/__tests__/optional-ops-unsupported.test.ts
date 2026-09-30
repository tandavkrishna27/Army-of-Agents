import { describe, expect, it } from "vitest";

import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { UnsupportedProviderOperation } from "../supervisor/provider.js";
import { makeCtx, sampleLabels } from "./support/supervisor-fixtures.js";

describe("optional-ops-unsupported — an unsupported optional op fails EXPLICITLY, never guessed", () => {
  it("names the exact operation on the thrown UnsupportedProviderOperation", async () => {
    const fake = createFakeSandboxProvider();
    const created = await fake.create(
      { resourceLabels: sampleLabels(), command: "x", args: [], env: {}, workloadType: "batch" },
      makeCtx(),
    );
    const id = created.sandboxId;

    for (const op of ["checkpoint", "restore", "health"] as const) {
      let thrown: unknown;
      try {
        await fake[op](id, makeCtx());
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(UnsupportedProviderOperation);
      expect((thrown as UnsupportedProviderOperation).operation).toBe(op);
    }
  });

  it("does NOT silently succeed or return a fabricated result for an unsupported op", async () => {
    const fake = createFakeSandboxProvider();
    const created = await fake.create(
      { resourceLabels: sampleLabels(), command: "x", args: [], env: {}, workloadType: "batch" },
      makeCtx(),
    );
    // A guessed op would resolve; the contract REJECTS.
    await expect(fake.checkpoint(created.sandboxId, makeCtx())).rejects.toThrow(/not advertised/);
    // The op is never recorded as an applied call.
    expect(fake.callCount("checkpoint")).toBe(0);
  });
});
