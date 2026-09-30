import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "../adapters/process/execute.js";
import type { AdapterInvocationMeta } from "../adapters/types.js";

async function expectSameRealPath(actual: string, expected: string): Promise<void> {
  await expect(fs.realpath(actual)).resolves.toBe(await fs.realpath(expected));
}

async function writeFakeProcessCommand(commandPath: string): Promise<string> {
  const script = `#!/usr/bin/env node
console.log(JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  custom: process.env.CUSTOM_ENV,
}));
`;
  const jsPath = commandPath + ".js";
  await fs.writeFile(jsPath, script, "utf8");
  await fs.chmod(jsPath, 0o755);

  if (process.platform === "win32") {
    const cmdPath = commandPath + ".cmd";
    await fs.writeFile(cmdPath, `@node "%~dp0process-agent.js" %*\r\n`, "utf8");
    return cmdPath;
  }

  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

describe("process adapter local execution target", () => {
  it("uses explicit local target without changing command, args, env, or metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-process-execute-target-"));
    const workspace = path.join(root, "workspace");
    const commandBase = path.join(root, "process-agent");
    await fs.mkdir(workspace, { recursive: true });
    const commandPath = await writeFakeProcessCommand(commandBase);

    let meta: AdapterInvocationMeta | null = null;

    try {
      const result = await execute({
        runId: "run-process-target",
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
          command: commandPath,
          args: ["arg-one"],
          cwd: workspace,
          env: {
            CUSTOM_ENV: "custom-value",
          },
          timeoutSec: 10,
          graceSec: 1,
        },
        context: {},
        executionTarget: { type: "local" },
        runtimeCommandSpec: { command: "node", installCommand: "do-not-run" },
        authToken: "secret-run-token",
        onLog: async () => {},
        onMeta: async (next) => {
          meta = next;
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeUndefined();
      const output = JSON.parse(String(result.resultJson?.stdout).trim()) as {
        argv: string[];
        cwd: string;
        custom: string;
      };
      expect(output).toMatchObject({
        argv: ["arg-one"],
        custom: "custom-value",
      });
      await expectSameRealPath(output.cwd, workspace);
      expect(meta?.commandArgs).toEqual(["arg-one"]);
      expect(meta?.commandNotes).toContain("Execution target: local");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
