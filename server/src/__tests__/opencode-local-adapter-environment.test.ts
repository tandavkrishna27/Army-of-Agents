import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@armyofagents/adapter-opencode-local/server";

describe("opencode_local environment diagnostics", () => {
  it("creates a missing working directory when cwd is absolute", async () => {
    const cwd = path.join(
      os.tmpdir(),
      `paperclip-opencode-local-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      "workspace",
    );

    await fs.rm(path.dirname(cwd), { recursive: true, force: true });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "opencode_local",
      config: {
        command: process.execPath,
        cwd,
      },
    });

    expect(result.checks.some((check) => check.code === "opencode_cwd_valid")).toBe(true);
    expect(result.checks.some((check) => check.code === "opencode_cwd_invalid")).toBe(false);
    const stats = await fs.stat(cwd);
    expect(stats.isDirectory()).toBe(true);
    await fs.rm(path.dirname(cwd), { recursive: true, force: true });
  });

  it("treats an empty OPENAI_API_KEY override as missing", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-env-empty-key-"));
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-host-value";

    try {
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "opencode_local",
        config: {
          command: process.execPath,
          cwd,
          env: {
            OPENAI_API_KEY: "",
          },
        },
      });

      const missingCheck = result.checks.find((check) => check.code === "opencode_openai_api_key_missing");
      expect(missingCheck).toBeTruthy();
      expect(missingCheck?.hint).toContain("empty");
    } finally {
      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("classifies ProviderModelNotFoundError probe output as model-unavailable warning", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-env-probe-cwd-"));
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-env-probe-bin-"));
    const jsPath = path.join(binDir, "opencode.js");

    // Node.js script that fakes opencode: returns models for discovery, errors for probe
    const script = [
      'const args = process.argv.slice(2);',
      'if (args.includes("models")) {',
      '  console.log("openai/gpt-5.3-codex");',
      '  process.exit(0);',
      '}',
      'process.stderr.write("ProviderModelNotFoundError: ProviderModelNotFoundError\\n");',
      'process.stderr.write(\'data: { providerID: "openai", modelID: "gpt-5.3-codex", suggestions: [] }\\n\');',
      'process.exit(1);',
      '',
    ].join("\n");

    let fakeOpencode: string;
    if (process.platform === "win32") {
      await fs.writeFile(jsPath, script, "utf8");
      fakeOpencode = path.join(binDir, "opencode.cmd");
      await fs.writeFile(fakeOpencode, `@node "%~dp0opencode.js" %*\r\n`, "utf8");
    } else {
      fakeOpencode = path.join(binDir, "opencode");
      await fs.writeFile(fakeOpencode, `#!/usr/bin/env node\n${script}`, "utf8");
      await fs.chmod(fakeOpencode, 0o755);
    }

    try {
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "opencode_local",
        config: {
          command: fakeOpencode,
          cwd,
          model: "openai/gpt-5.3-codex",
        },
      });

      const modelCheck = result.checks.find((check) => check.code === "opencode_hello_probe_model_unavailable");
      expect(modelCheck).toBeTruthy();
      expect(modelCheck?.level).toBe("warn");
      expect(result.status).toBe("warn");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });
});
