import { describe, expect, it } from "vitest";
import { testEnvironment } from "./test.js";

describe("openclaw_gateway environment diagnostics", () => {
  it("fails AoA remote execution target diagnostics without probing from the host", async () => {
    const result = await testEnvironment({
      adapterType: "openclaw_gateway",
      companyId: "test-company",
      config: {
        url: "ws://127.0.0.1:18789/gateway",
      },
      executionTarget: {
        type: "sandbox-docker",
        image: "fixture",
        workdir: "/workspace",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual([
      expect.objectContaining({
        code: "openclaw_gateway_external_execution_target_unsupported",
        level: "error",
      }),
    ]);
  });
});
