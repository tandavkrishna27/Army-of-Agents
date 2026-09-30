import { describe, expect, it, vi } from "vitest";
import { testEnvironment } from "./test.js";

describe("process adapter environment test", () => {
  it("probes command resolution inside a provider-sandbox execution target", async () => {
    const execute = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "/usr/bin/pwd\n",
      stderr: "",
    }));

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "process",
      config: { command: "pwd" },
      environmentName: "E2B Cloud QA",
      executionTarget: {
        type: "provider-sandbox",
        provider: "e2b",
        providerLeaseId: "sandbox-1",
        remoteCwd: "/home/user/aoa-workspace",
        shell: "bash",
        env: {},
        runner: { execute },
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "process_environment_target",
          message: "Probing inside environment: E2B Cloud QA",
        }),
        expect.objectContaining({
          code: "process_command_resolvable",
        }),
      ]),
    );
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      provider: "e2b",
      providerLeaseId: "sandbox-1",
      cwd: "/home/user/aoa-workspace",
    }));
  });
});
