import { describe, expect, it } from "vitest";
import { testEnvironment } from "./test.js";

describe("cursor_cloud environment diagnostics", () => {
  it("fails AoA remote execution target diagnostics honestly", async () => {
    const result = await testEnvironment({
      adapterType: "cursor_cloud",
      companyId: "test-company",
      config: {
        env: { CURSOR_API_KEY: "" },
        repoUrl: "https://github.com/paperclipai/paperclip.git",
      },
      executionTarget: {
        type: "provider-sandbox",
        provider: "e2b",
        providerLeaseId: "sandbox-1",
        remoteCwd: "/home/user/aoa-workspace",
        shell: "bash",
        runner: {
          execute: async () => ({
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "",
            stderr: "",
          }),
        },
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "cursor_cloud_external_execution_target_unsupported",
        level: "error",
      }),
    );
    expect(result.checks.map((check) => check.code)).not.toContain(
      "cursor_cloud_sdk_unavailable",
    );
  });
});
