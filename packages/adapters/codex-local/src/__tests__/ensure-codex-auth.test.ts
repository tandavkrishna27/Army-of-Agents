import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ensureCodexAuthInHome } from "../server/codex-home.js";

// MX-chatauth: the Commander chat's per-session CODEX_HOME gets config.toml
// but no auth.json, so `codex exec` 401s. ensureCodexAuthInHome copies the
// shared <resolveSharedCodexHomeDir(env)>/auth.json into the target home so
// the per-session codex invocation is authenticated. Reuses codex-home's
// proven copy logic; never throws on a missing source.
describe("ensureCodexAuthInHome", () => {
  let sharedDir: string;
  let targetDir: string;

  beforeEach(async () => {
    sharedDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-codex-shared-"));
    targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-codex-target-"));
  });

  afterEach(async () => {
    await fs.rm(sharedDir, { recursive: true, force: true });
    await fs.rm(targetDir, { recursive: true, force: true });
  });

  it("copies shared auth.json into the target home and returns true (content identical)", async () => {
    const payload = JSON.stringify({ tokens: { id: "subscription-auth" } });
    await fs.writeFile(path.join(sharedDir, "auth.json"), payload);

    const copied = await ensureCodexAuthInHome(targetDir, { CODEX_HOME: sharedDir });

    expect(copied).toBe(true);
    const content = await fs.readFile(path.join(targetDir, "auth.json"), "utf-8");
    expect(content).toBe(payload);
  });

  it("mkdirs the target home if it does not yet exist, then copies", async () => {
    const payload = JSON.stringify({ OPENAI_API_KEY: "sk-abc" });
    await fs.writeFile(path.join(sharedDir, "auth.json"), payload);
    const absentTarget = path.join(targetDir, "nested", "codex-home");

    const copied = await ensureCodexAuthInHome(absentTarget, { CODEX_HOME: sharedDir });

    expect(copied).toBe(true);
    const content = await fs.readFile(path.join(absentTarget, "auth.json"), "utf-8");
    expect(content).toBe(payload);
  });

  it("returns false and writes nothing when the shared auth.json is absent (never throws)", async () => {
    // sharedDir has no auth.json.
    const copied = await ensureCodexAuthInHome(targetDir, { CODEX_HOME: sharedDir });

    expect(copied).toBe(false);
    const entries = await fs.readdir(targetDir);
    expect(entries).not.toContain("auth.json");
  });

  it("does not disturb an existing unrelated file (e.g. a pre-written config.toml) in the target home", async () => {
    const tomlBody = '[mcp_servers.aoa]\ncommand = "node"\n';
    await fs.writeFile(path.join(targetDir, "config.toml"), tomlBody);
    const payload = JSON.stringify({ tokens: { id: "auth-2" } });
    await fs.writeFile(path.join(sharedDir, "auth.json"), payload);

    const copied = await ensureCodexAuthInHome(targetDir, { CODEX_HOME: sharedDir });

    expect(copied).toBe(true);
    // The pre-existing config.toml is untouched.
    const stillThere = await fs.readFile(path.join(targetDir, "config.toml"), "utf-8");
    expect(stillThere).toBe(tomlBody);
    // And auth.json was provisioned alongside it.
    const content = await fs.readFile(path.join(targetDir, "auth.json"), "utf-8");
    expect(content).toBe(payload);
  });
});
