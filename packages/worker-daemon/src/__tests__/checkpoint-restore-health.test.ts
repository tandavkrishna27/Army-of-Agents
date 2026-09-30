import { describe, expect, it } from "vitest";

import { EffectAuthority } from "../supervisor/effect-authority.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { makeCtx, sampleLabels } from "./support/supervisor-fixtures.js";

const fence = {
  jobId: "job-1",
  attempt: 1,
  leaseId: "lease-1",
  fenceToken: "f".repeat(40),
  deviceGeneration: 1,
  observedSeq: 0,
};

describe("checkpoint-restore-health — advertised optional ops behave per negotiated modes", () => {
  it("checkpoint returns the negotiated snapshot mode + a ref; restore resumes", async () => {
    const fake = createFakeSandboxProvider({
      optionalOperations: ["checkpoint", "restore"],
      checkpointMode: "application",
      restoreResumed: true,
    });
    const id = (
      await fake.create({ resourceLabels: sampleLabels(), command: "svc", args: [], env: {}, workloadType: "service" }, makeCtx())
    ).sandboxId;

    const cp = await fake.checkpoint(id, makeCtx());
    expect(cp.mode).toBe("application");
    expect(cp.checkpointRef).toBe(`sandbox://${id}/checkpoint`);

    const restored = await fake.restore(id, makeCtx());
    expect(restored.restored).toBe(true);
  });

  it("health returns the negotiated poll/stream mode + status", async () => {
    const fake = createFakeSandboxProvider({ optionalOperations: ["health"], healthMode: "stream", healthStatus: "unhealthy" });
    const id = (
      await fake.create({ resourceLabels: sampleLabels(), command: "svc", args: [], env: {}, workloadType: "service" }, makeCtx())
    ).sandboxId;
    const health = await fake.health(id, makeCtx());
    expect(health.mode).toBe("stream");
    expect(health.status).toBe("unhealthy");
  });

  it("resume/checkpoint/health under EFFECT authority route to the advertised ops", async () => {
    const fake = createFakeSandboxProvider({
      optionalOperations: ["checkpoint", "restore", "health"],
      checkpointMode: "snapshot",
      healthMode: "poll",
    });
    const id = (
      await fake.create({ resourceLabels: sampleLabels(), command: "svc", args: [], env: {}, workloadType: "service" }, makeCtx())
    ).sandboxId;
    const effect = new EffectAuthority(fake, fence);

    expect((await effect.checkpoint(id, makeCtx())).mode).toBe("snapshot");
    expect((await effect.resume(id, makeCtx())).restored).toBe(true);
    expect((await effect.health(id, makeCtx())).mode).toBe("poll");
  });
});
