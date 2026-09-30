import { describe, expect, it } from "vitest";
import { createEnvironmentSchema } from "./environment.js";

describe("gvisor environment config + executionTargetId", () => {
  it("accepts a gvisor sandbox environment with an isolation profile", () => {
    const parsed = createEnvironmentSchema.safeParse({
      name: "pool",
      driver: "sandbox",
      config: {
        provider: "gvisor",
        image: "aoa/agent-base:latest",
        runtime: "runsc",
        network: "none",
        isolation: { user: "1000:1000", capDropAll: true, readOnlyRootfs: true, memory: "2g", cpus: "2", pidsLimit: 512 },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a gvisor config missing an image", () => {
    const parsed = createEnvironmentSchema.safeParse({
      name: "pool",
      driver: "sandbox",
      config: { provider: "gvisor", runtime: "runsc" },
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts an environment pinned to an executionTargetId", () => {
    const parsed = createEnvironmentSchema.safeParse({
      name: "pinned",
      driver: "sandbox",
      config: { provider: "gvisor", image: "aoa/agent-base:latest" },
      executionTargetId: "11111111-1111-1111-1111-111111111111",
    });
    expect(parsed.success).toBe(true);
  });
});
