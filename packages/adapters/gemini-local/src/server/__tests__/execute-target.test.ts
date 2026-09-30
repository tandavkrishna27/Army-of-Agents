import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "../execute.js";
import type { AdapterInvocationMeta } from "@armyofagents/adapter-utils";

async function expectSameRealPath(actual: string, expected: string): Promise<void> {
  await expect(fs.realpath(actual)).resolves.toBe(await fs.realpath(expected));
}

async function writeFakeGeminiCommand(commandPath: string): Promise<string> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.AOA_TEST_CAPTURE_PATH;
const argv = process.argv.slice(2);
const promptIndex = argv.indexOf("--prompt");
const payload = {
  argv,
  cwd: process.cwd(),
  prompt: promptIndex >= 0 ? argv.slice(promptIndex + 1).join(" ") : null,
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
  type: "system",
  subtype: "init",
  session_id: "gemini-session-1",
  model: "gemini-test",
}));
console.log(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "output_text", text: "hello" }] },
}));
console.log(JSON.stringify({
  type: "result",
  usage: { input_tokens: 1, output_tokens: 2, cached_input_tokens: 0 },
  total_cost_usd: 0,
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

describe("gemini execute target", () => {
  it("uses explicit local target without changing command, prompt arg, env, or metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-gemini-execute-target-"));
    const workspace = path.join(root, "workspace");
    const commandBase = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    const commandPath = await writeFakeGeminiCommand(commandBase);

    const metaEvents: AdapterInvocationMeta[] = [];

    try {
      const result = await execute({
        runId: "run-gemini-target",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Gemini Coder",
          adapterType: "gemini_local",
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
        runtimeCommandSpec: { command: "gemini", installCommand: "do-not-run" },
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
      expect(capture.argv).toEqual(expect.arrayContaining(["--output-format", "stream-json", "--prompt"]));
      expect(capture.prompt).toContain("AoA runtime note:");
      expect(capture.env).toMatchObject({
        AOA_API_KEY: "secret-run-token",
        AOA_RUN_ID: "run-gemini-target",
        CUSTOM_ENV: "custom-value",
      });
      const meta = metaEvents.at(-1);
      expect(meta?.commandNotes).toContain("Execution target: local");
      expect(meta?.env?.AOA_API_KEY).toBe("***REDACTED***");
      expect(meta?.prompt).toContain("Prompt for agent-1 in run-gemini-target.");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
