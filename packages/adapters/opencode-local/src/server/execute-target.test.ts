import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "./execute.js";
import type { AdapterInvocationMeta } from "@armyofagents/adapter-utils";
import { resetOpenCodeModelsCacheForTests } from "./models.js";

async function expectSameRealPath(actual: string, expected: string): Promise<void> {
  await expect(fs.realpath(actual)).resolves.toBe(await fs.realpath(expected));
}

async function writeFakeOpenCodeCommand(commandPath: string): Promise<string> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const argv = process.argv.slice(2);
if (argv[0] === "models") {
  console.log("test/provider");
  process.exit(0);
}

const capturePath = process.env.AOA_TEST_CAPTURE_PATH;
const payload = {
  argv,
  cwd: process.cwd(),
  prompt: fs.readFileSync(0, "utf8"),
  env: {
    AOA_API_KEY: process.env.AOA_API_KEY,
    AOA_RUN_ID: process.env.AOA_RUN_ID,
    CUSTOM_ENV: process.env.CUSTOM_ENV,
  },
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({
  type: "text",
  sessionID: "opencode-session-1",
  part: { text: "hello" },
}));
console.log(JSON.stringify({
  type: "step_finish",
  sessionID: "opencode-session-1",
  part: {
    reason: "done",
    cost: 0,
    tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
  },
}));
`;
  const jsPath = commandPath + ".js";
  await fs.writeFile(jsPath, script, "utf8");
  await fs.chmod(jsPath, 0o755);

  if (process.platform === "win32") {
    const cmdPath = commandPath + ".cmd";
    await fs.writeFile(cmdPath, `@node "%~dp0agent.js" %*\r\n`, "utf8");
    return cmdPath;
  }

  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

describe("opencode execute target", () => {
  it("uses explicit local target without changing command, stdin, env, or metadata", async () => {
    resetOpenCodeModelsCacheForTests();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-opencode-execute-target-"));
    const workspace = path.join(root, "workspace");
    const commandBase = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    const commandPath = await writeFakeOpenCodeCommand(commandBase);

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    const metaEvents: AdapterInvocationMeta[] = [];

    try {
      const result = await execute({
        runId: "run-opencode-target",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OpenCode Coder",
          adapterType: "opencode_local",
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
          cwd: workspace,
          model: "test/provider",
          env: {
            AOA_TEST_CAPTURE_PATH: capturePath,
            CUSTOM_ENV: "custom-value",
          },
          promptTemplate: "Prompt for {{agent.id}} in {{runId}}.",
          timeoutSec: 10,
          graceSec: 1,
        },
        context: {},
        executionTarget: { type: "local" },
        runtimeCommandSpec: { command: "opencode", installCommand: "do-not-run" },
        authToken: "secret-run-token",
        onLog: async () => {},
        onMeta: async (next) => {
          metaEvents.push(next);
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
        cwd: string;
        prompt: string;
        env: Record<string, string>;
      };
      await expectSameRealPath(capture.cwd, workspace);
      expect(capture.argv).toEqual(expect.arrayContaining(["run", "--format", "json", "--model", "test/provider"]));
      expect(capture.prompt).toBe("Prompt for agent-1 in run-opencode-target.");
      expect(capture.env).toMatchObject({
        AOA_API_KEY: "secret-run-token",
        AOA_RUN_ID: "run-opencode-target",
        CUSTOM_ENV: "custom-value",
      });
      const meta = metaEvents.at(-1);
      expect(meta?.commandNotes).toContain("Execution target: local");
      expect(meta?.env?.AOA_API_KEY).toBe("***REDACTED***");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      resetOpenCodeModelsCacheForTests();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
