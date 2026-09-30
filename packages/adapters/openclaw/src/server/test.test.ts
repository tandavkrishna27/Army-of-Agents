import { describe, expect, it } from "vitest";
import { testEnvironment } from "./test.js";

describe("openclaw environment diagnostics", () => {
  it("fails AoA remote execution target diagnostics without probing from the host", async () => {
    const result = await testEnvironment({
      adapterType: "openclaw",
      companyId: "test-company",
      config: {
        url: "http://127.0.0.1:18789/v1/responses",
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
        code: "openclaw_external_execution_target_unsupported",
        level: "error",
      }),
    ]);
  });
});
