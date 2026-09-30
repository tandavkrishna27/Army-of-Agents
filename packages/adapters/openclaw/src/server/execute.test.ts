import { describe, expect, it } from "vitest";
import { execute } from "./execute.js";

describe("openclaw execution target", () => {
  it("rejects AoA remote execution targets before making endpoint requests", async () => {
    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OpenClaw",
        adapterType: "openclaw",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        url: "http://127.0.0.1:18789/v1/responses",
      },
      context: {},
      executionTarget: {
        type: "sandbox-docker",
        image: "fixture",
        workdir: "/workspace",
      },
      onLog: async () => {},
      onMeta: async () => {},
    });

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "unsupported_execution_target",
      provider: "openclaw",
      resultJson: {
        supportedTargets: ["openclaw_endpoint"],
      },
    });
    expect(result.errorMessage).toContain("cannot execute inside sandbox-docker");
  });
});
