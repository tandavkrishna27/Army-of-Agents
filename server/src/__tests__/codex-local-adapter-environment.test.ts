import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@armyofagents/adapter-codex-local/server";

describe("codex_local environment diagnostics", () => {
  it("creates a missing working directory when cwd is absolute", async () => {
    const cwd = path.join(
      os.tmpdir(),
      `paperclip-codex-local-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      "workspace",
    );

    await fs.rm(path.dirname(cwd), { recursive: true, force: true });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        command: process.execPath,
        cwd,
      },
    });

    expect(result.checks.some((check) => check.code === "codex_cwd_valid")).toBe(true);
    expect(result.checks.some((check) => check.level === "error")).toBe(false);
    const stats = await fs.stat(cwd);
    expect(stats.isDirectory()).toBe(true);
    await fs.rm(path.dirname(cwd), { recursive: true, force: true });
  });

  it("reports local Codex auth.json as ready when no API key is configured", async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-cwd-"));

    try {
      process.env.CODEX_HOME = codexHome;
      delete process.env.OPENAI_API_KEY;
      await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { id: "local" } }));

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: {
          command: process.execPath,
          cwd,
        },
      });

      expect(result.status).toBe("pass");
      expect(result.checks.some((check) => check.code === "codex_auth_json_present")).toBe(true);
      expect(result.checks.some((check) => check.code === "codex_openai_api_key_missing")).toBe(false);
    } finally {
      await fs.rm(codexHome, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
    }
  });

  it("warns (does not report usable auth) when OPENAI_API_KEY is only in the server env (Codex P2 / env-strip alignment)", async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-")); // NO auth.json written
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-cwd-"));

    try {
      process.env.CODEX_HOME = codexHome;
      // ambient server key only — no per-agent key, no shared auth.json
      process.env.OPENAI_API_KEY = "sk-host-only-ambient-canary-0123456789";

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: {
          command: process.execPath,
          cwd,
        },
      });

      // Agent runs strip the ambient server key, so the probe must NOT report it as
      // usable auth — it warns instead (so "Test environment" can't pass while the
      // saved agent immediately runs without auth).
      expect(result.checks.some((check) => check.code === "codex_openai_api_key_server_env_only")).toBe(true);
      expect(result.checks.some((check) => check.code === "codex_openai_api_key_present")).toBe(false);
    } finally {
      await fs.rm(codexHome, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
    }
  });
});
