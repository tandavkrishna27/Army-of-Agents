import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDockerAvailable } from "@armyofagents/adapter-utils";
import { execute } from "../adapters/process/execute.js";

const dockerAvailable = process.platform !== "win32" && await isDockerAvailable().catch(() => false);
const dockerIt = dockerAvailable ? it : it.skip;

describe("process adapter sandbox-docker execution target", () => {
  dockerIt(
    "runs a process adapter command inside sandbox-docker",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-docker-execution-target-"));
      const workspace = path.join(root, "workspace");
      await fs.mkdir(workspace, { recursive: true });

      try {
        const result = await execute({
          runId: "run-docker-target",
          agent: {
            id: "agent-1",
            companyId: "company-1",
            name: "Process Runner",
            adapterType: "process",
            adapterConfig: {},
          },
          runtime: {
            sessionId: null,
            sessionParams: null,
            sessionDisplayId: null,
            taskKey: null,
          },
          config: {
            command: "node",
            args: ["-e", "console.log(process.env.AOA_RUN_ID ? 'ok' : 'missing')"],
            cwd: workspace,
            env: { AOA_RUN_ID: "run-docker-target" },
            timeoutSec: 60,
            graceSec: 2,
          },
          context: {},
          executionTarget: {
            type: "sandbox-docker",
            image: "node:22-bookworm",
            workdir: "/workspace",
          },
          runtimeCommandSpec: null,
          authToken: null,
          onLog: async () => {},
        });

        expect(result.exitCode).toBe(0);
        expect(result.resultJson?.stdout).toContain("ok");
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
