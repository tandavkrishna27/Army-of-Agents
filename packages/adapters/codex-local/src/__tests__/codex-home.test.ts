import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  writeApiKeyAuthJson,
  prepareManagedCodexHome,
  resolveManagedCodexHomeDir,
} from "../server/codex-home.js";

describe("codex-home", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-codex-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writeApiKeyAuthJson writes JSON with mode 0o600", async () => {
    await writeApiKeyAuthJson(tmpDir, "sk-test-key-12345");
    const target = path.join(tmpDir, "auth.json");
    const content = await fs.readFile(target, "utf-8");
    expect(JSON.parse(content)).toEqual({ OPENAI_API_KEY: "sk-test-key-12345" });
    const stat = await fs.stat(target);
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("writeApiKeyAuthJson overwrites existing auth.json", async () => {
    await writeApiKeyAuthJson(tmpDir, "first-key");
    await writeApiKeyAuthJson(tmpDir, "second-key");
    const content = await fs.readFile(path.join(tmpDir, "auth.json"), "utf-8");
    expect(JSON.parse(content)).toEqual({ OPENAI_API_KEY: "second-key" });
  });

  // B1 (Plan 2b): the managed CODEX_HOME is per-AGENT, not per-company. codex
  // reads its MCP servers from ONE config.toml per home, so a per-company home
  // would make Agent A's connectors visible to Agent B (breaking the per-agent
  // opt-in, D4) and would race two concurrent runs onto the same file.
  it("resolveManagedCodexHomeDir returns a DIFFERENT dir per agent in the same company", () => {
    const env = { CODEX_HOME: tmpDir };
    const a = resolveManagedCodexHomeDir(env, "company_test", "agent-a");
    const b = resolveManagedCodexHomeDir(env, "company_test", "agent-b");

    expect(a).not.toBe(b);
    expect(a).toBe(path.join(tmpDir, "aoa-instances", "company_test", "agent-a"));
    expect(b).toBe(path.join(tmpDir, "aoa-instances", "company_test", "agent-b"));
  });

  it("resolveManagedCodexHomeDir is stable for the same company + agent", () => {
    const env = { CODEX_HOME: tmpDir };
    expect(resolveManagedCodexHomeDir(env, "company_test", "agent-a")).toBe(
      resolveManagedCodexHomeDir(env, "company_test", "agent-a"),
    );
  });

  it("resolveManagedCodexHomeDir keeps a traversal-shaped id inside the managed root", () => {
    const env = { CODEX_HOME: tmpDir };
    const root = path.join(tmpDir, "aoa-instances");
    const home = resolveManagedCodexHomeDir(env, "company_test", "../../escape");
    expect(path.relative(root, home).startsWith("..")).toBe(false);
  });

  it("prepareManagedCodexHome with apiKey writes auth.json into the managed home", async () => {
    const logs: string[] = [];
    const home = await prepareManagedCodexHome(
      { CODEX_HOME: tmpDir },
      (msg) => logs.push(msg),
      "company_test",
      "agent_test",
      { apiKey: "sk-test" },
    );
    expect(home).toContain("company_test");
    expect(home).toContain("agent_test");
    const content = await fs.readFile(path.join(home, "auth.json"), "utf-8");
    expect(JSON.parse(content)).toEqual({ OPENAI_API_KEY: "sk-test" });
  });

  it("prepareManagedCodexHome without apiKey copies shared Codex auth into the managed home", async () => {
    await fs.writeFile(
      path.join(tmpDir, "auth.json"),
      JSON.stringify({ tokens: { id: "subscription-auth" } }),
    );

    const logs: string[] = [];
    const home = await prepareManagedCodexHome(
      { CODEX_HOME: tmpDir },
      (msg) => logs.push(msg),
      "company_test",
      "agent_test",
      {},
    );

    const content = await fs.readFile(path.join(home, "auth.json"), "utf-8");
    expect(JSON.parse(content)).toEqual({ tokens: { id: "subscription-auth" } });
    expect(logs.some((msg) => msg.includes("Copied shared Codex auth.json"))).toBe(true);
  });

  // B1: per-agent homes must each be seeded with auth, or the second agent in a
  // company silently runs unauthenticated (codex exec 401s).
  it("prepareManagedCodexHome seeds shared auth into EVERY agent's own home", async () => {
    await fs.writeFile(
      path.join(tmpDir, "auth.json"),
      JSON.stringify({ tokens: { id: "subscription-auth" } }),
    );

    const homeA = await prepareManagedCodexHome(
      { CODEX_HOME: tmpDir },
      () => {},
      "company_test",
      "agent-a",
      {},
    );
    const homeB = await prepareManagedCodexHome(
      { CODEX_HOME: tmpDir },
      () => {},
      "company_test",
      "agent-b",
      {},
    );

    expect(homeA).not.toBe(homeB);
    for (const home of [homeA, homeB]) {
      const content = await fs.readFile(path.join(home, "auth.json"), "utf-8");
      expect(JSON.parse(content)).toEqual({ tokens: { id: "subscription-auth" } });
    }
  });

  it("prepareManagedCodexHome keeps one agent's api-key auth out of another agent's home", async () => {
    const homeA = await prepareManagedCodexHome(
      { CODEX_HOME: tmpDir },
      () => {},
      "company_test",
      "agent-a",
      { apiKey: "sk-agent-a" },
    );
    const homeB = await prepareManagedCodexHome(
      { CODEX_HOME: tmpDir },
      () => {},
      "company_test",
      "agent-b",
      { apiKey: "sk-agent-b" },
    );

    expect(JSON.parse(await fs.readFile(path.join(homeA, "auth.json"), "utf-8"))).toEqual({
      OPENAI_API_KEY: "sk-agent-a",
    });
    expect(JSON.parse(await fs.readFile(path.join(homeB, "auth.json"), "utf-8"))).toEqual({
      OPENAI_API_KEY: "sk-agent-b",
    });
  });
});
