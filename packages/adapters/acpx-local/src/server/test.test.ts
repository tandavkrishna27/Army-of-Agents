import { afterEach, describe, expect, it } from "vitest";
import { testEnvironment } from "./test.js";

const originalNodeVersion = process.version;

function setNodeVersion(version: string): void {
  Object.defineProperty(process, "version", {
    configurable: true,
    enumerable: true,
    value: version,
  });
}

afterEach(() => {
  setNodeVersion(originalNodeVersion);
});

describe("acpx_local environment diagnostics", () => {
  it("does not force healthy default Claude diagnostics to warn", async () => {
    setNodeVersion("v22.12.0");

    const result = await testEnvironment({
      adapterType: "acpx_local",
      companyId: "test-company",
      config: { agent: "claude" },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "acpx_agent_selected",
        level: "info",
        message: "ACP agent selected: claude",
      }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "acpx_runtime_scaffold",
        level: "info",
      }),
    );
    expect(result.checks).not.toContainEqual(
      expect.objectContaining({
        code: "acpx_runtime_scaffold",
        level: "warn",
      }),
    );
  });

  it("fails remote execution target diagnostics honestly", async () => {
    setNodeVersion("v22.12.0");

    const result = await testEnvironment({
      adapterType: "acpx_local",
      companyId: "test-company",
      config: { agent: "claude" },
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
        code: "acpx_remote_execution_target_unsupported",
        level: "error",
      }),
    );
  });
});
