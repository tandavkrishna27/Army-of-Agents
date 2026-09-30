import { describe, expect, it } from "vitest";

import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { makeCtx, sampleLabels } from "./support/supervisor-fixtures.js";

describe("provider-idempotency-replay — a repeated idempotency key returns the recorded result", () => {
  it("create: a lost-response replay returns the SAME result and creates ONE sandbox", async () => {
    const fake = createFakeSandboxProvider();
    const labels = sampleLabels();
    const ctx = makeCtx("stable-create-key");

    const first = await fake.create(
      { resourceLabels: labels, command: "codex", args: [], env: {}, workloadType: "batch" },
      ctx,
    );
    const replay = await fake.create(
      { resourceLabels: labels, command: "codex", args: [], env: {}, workloadType: "batch" },
      ctx,
    );

    expect(replay).toEqual(first);
    // No double-apply: exactly one non-replayed create; the second is recorded as a replay.
    expect(fake.callCount("create")).toBe(1);
    expect(fake.calls().filter((c) => c.op === "create" && c.replayed)).toHaveLength(1);
    expect(fake.all()).toHaveLength(1);
  });

  it("destroy: a replay returns the recorded cleanupStatus and does not double-apply", async () => {
    const fake = createFakeSandboxProvider();
    const labels = sampleLabels();
    const created = await fake.create(
      { resourceLabels: labels, command: "x", args: [], env: {}, workloadType: "batch" },
      makeCtx(),
    );
    const destroyCtx = makeCtx("stable-destroy-key");
    const first = await fake.destroy(created.sandboxId, destroyCtx);
    const replay = await fake.destroy(created.sandboxId, destroyCtx);

    expect(first.cleanupStatus).toBe("success");
    expect(replay).toEqual(first);
    expect(fake.callCount("destroy")).toBe(1);
  });

  it("execute: a replay returns the recorded refs and records ONE execution inside the sandbox", async () => {
    const fake = createFakeSandboxProvider();
    const labels = sampleLabels();
    const created = await fake.create(
      { resourceLabels: labels, command: "x", args: [], env: {}, workloadType: "batch" },
      makeCtx(),
    );
    const execCtx = makeCtx("stable-exec-key");
    const first = await fake.execute({ sandboxId: created.sandboxId, command: "codex", args: ["exec"], env: {} }, execCtx);
    const replay = await fake.execute({ sandboxId: created.sandboxId, command: "codex", args: ["exec"], env: {} }, execCtx);

    expect(replay).toEqual(first);
    // The command ran inside the sandbox exactly once (not twice).
    expect(fake.executionsOf(created.sandboxId)).toHaveLength(1);
  });
});
