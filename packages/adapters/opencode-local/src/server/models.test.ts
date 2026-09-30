import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverOpenCodeModels,
  ensureOpenCodeModelConfiguredAndAvailable,
  listOpenCodeModels,
  parseOpenCodeModelsOutput,
  requireOpenCodeModelId,
  resetOpenCodeModelsCacheForTests,
} from "./models.js";

describe("openCode models", () => {
  afterEach(() => {
    delete process.env.AOA_OPENCODE_COMMAND;
    resetOpenCodeModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.AOA_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(listOpenCodeModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  it("rejects malformed model ids before discovery", () => {
    expect(() => requireOpenCodeModelId("openai/")).toThrow("provider/model");
    expect(() => requireOpenCodeModelId("/gpt-5")).toThrow("provider/model");
    expect(requireOpenCodeModelId("openai/gpt-5")).toBe("openai/gpt-5");
  });

  it("parses and dedupes opencode model output", () => {
    expect(
      parseOpenCodeModelsOutput(
        [
          "openai/gpt-5.2-codex  OpenAI",
          "anthropic/claude-sonnet-4-5",
          "openai/gpt-5.2-codex duplicate",
          "not-a-model",
        ].join("\n"),
      ),
    ).toEqual([
      { id: "openai/gpt-5.2-codex", label: "openai/gpt-5.2-codex" },
      { id: "anthropic/claude-sonnet-4-5", label: "anthropic/claude-sonnet-4-5" },
    ]);
  });

  it("disables project config during model discovery", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-opencode-models-env-"));
    const capturePath = path.join(root, "env.json");
    const commandPath = path.join(root, process.platform === "win32" ? "opencode.cmd" : "opencode");
    const jsPath = path.join(root, "opencode.js");
    await fs.writeFile(
      jsPath,
      [
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.AOA_TEST_CAPTURE_PATH, JSON.stringify({",
        "  OPENCODE_DISABLE_PROJECT_CONFIG: process.env.OPENCODE_DISABLE_PROJECT_CONFIG,",
        "  HOME: process.env.HOME,",
        "}));",
        "console.log('openai/gpt-5');",
      ].join("\n"),
      "utf8",
    );
    if (process.platform === "win32") {
      await fs.writeFile(commandPath, `@node "%~dp0opencode.js" %*\r\n`, "utf8");
    } else {
      await fs.writeFile(commandPath, `#!/usr/bin/env sh\nnode "${jsPath}" "$@"\n`, "utf8");
      await fs.chmod(commandPath, 0o755);
    }

    try {
      await expect(
        discoverOpenCodeModels({
          command: commandPath,
          cwd: root,
          env: { AOA_TEST_CAPTURE_PATH: capturePath },
        }),
      ).resolves.toEqual([{ id: "openai/gpt-5", label: "openai/gpt-5" }]);

      const captured = JSON.parse(await fs.readFile(capturePath, "utf8")) as Record<string, string>;
      expect(captured.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true");
      expect(captured.HOME).toBeTruthy();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.AOA_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
      }),
    ).rejects.toThrow(/failed/i);
  });
});
