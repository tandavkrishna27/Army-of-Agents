import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "../adapters/process/execute.js";

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

async function runProcessWithTarget(executionTarget?: { type: "local" }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-process-target-backcompat-"));
  const workspace = path.join(root, "workspace");
  const commandBase = path.join(root, "process-agent");
  await fs.mkdir(workspace, { recursive: true });
  const commandPath = await writeFakeProcessCommand(commandBase);

  try {
    const result = await execute({
      runId: "run-process-backcompat",
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
        env: { CUSTOM_ENV: "custom-value" },
        timeoutSec: 10,
        graceSec: 1,
      },
      context: {},
      executionTarget,
      runtimeCommandSpec: { command: "node", installCommand: "do-not-run" },
      authToken: "secret-run-token",
      onLog: async () => {},
    });

    return {
      exitCode: result.exitCode,
      errorMessage: result.errorMessage,
      stdout: JSON.parse(String(result.resultJson?.stdout).trim()),
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("local execution target back-compat", () => {
  it("keeps missing executionTarget equivalent to explicit local", async () => {
    const missingTarget = await runProcessWithTarget();
    const explicitLocal = await runProcessWithTarget({ type: "local" });

    expect(missingTarget.exitCode).toBe(0);
    expect(explicitLocal.exitCode).toBe(0);
    expect(missingTarget.errorMessage).toBeUndefined();
    expect(explicitLocal.errorMessage).toBeUndefined();
    expect(explicitLocal.stdout).toEqual({
      ...missingTarget.stdout,
      cwd: explicitLocal.stdout.cwd,
    });
    expect(explicitLocal.stdout.argv).toEqual(missingTarget.stdout.argv);
    expect(explicitLocal.stdout.custom).toBe(missingTarget.stdout.custom);
  });
});
