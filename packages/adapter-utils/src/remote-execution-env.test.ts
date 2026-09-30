import { describe, expect, it } from "vitest";
import { sanitizeRemoteExecutionEnv } from "./remote-execution-env.js";

describe("sanitizeRemoteExecutionEnv", () => {
  it("strips host identity values when they match the host env", () => {
    expect(
      sanitizeRemoteExecutionEnv(
        {
          HOME: "/Users/tk",
          PATH: "/usr/bin",
          AOA_RUN_ID: "run_1",
        },
        {
          HOME: "/Users/tk",
          PATH: "/usr/bin",
        },
      ),
    ).toEqual({ AOA_RUN_ID: "run_1" });
  });

  it("preserves explicit different identity values", () => {
    expect(
      sanitizeRemoteExecutionEnv(
        {
          HOME: "/sandbox/home",
          Path: "C:\\sandbox\\bin",
          TEMP: "/tmp/adapter",
        },
        {
          HOME: "/Users/tk",
          Path: "C:\\Windows",
          TEMP: "/tmp/adapter",
        },
      ),
    ).toEqual({
      HOME: "/sandbox/home",
      Path: "C:\\sandbox\\bin",
    });
  });

  it("drops host environment keys that cannot be exported by POSIX shells", () => {
    expect(
      sanitizeRemoteExecutionEnv(
        {
          "CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
          ProgramFiles: "C:\\Program Files",
          AOA_RUN_ID: "run_1",
        },
        {},
      ),
    ).toEqual({
      ProgramFiles: "C:\\Program Files",
      AOA_RUN_ID: "run_1",
    });
  });
});
