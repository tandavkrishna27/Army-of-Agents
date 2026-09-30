import { describe, expect, it } from "vitest";

import { getAdapterResultOutput } from "../pages/AgentDetail";

describe("getAdapterResultOutput", () => {
  it("returns process stdout and stderr from successful adapter result JSON", () => {
    expect(
      getAdapterResultOutput(
        {
          status: "succeeded",
          resultJson: {
            stdout: "/home/user/aoa-workspace\nAOA_RUN_ID=run-123\n",
            stderr: "profile warning\n",
          },
        },
        "process",
      ),
    ).toEqual({
      stdout: "/home/user/aoa-workspace\nAOA_RUN_ID=run-123\n",
      stderr: "profile warning\n",
    });
  });

  it("does not duplicate failed result JSON or non-process adapter output", () => {
    const run = {
      status: "failed",
      resultJson: {
        stdout: "hidden on failure",
      },
    } as const;

    expect(getAdapterResultOutput(run, "process")).toBeNull();
    expect(
      getAdapterResultOutput(
        { status: "succeeded", resultJson: { stdout: "codex jsonl" } },
        "codex_local",
      ),
    ).toBeNull();
  });
});
