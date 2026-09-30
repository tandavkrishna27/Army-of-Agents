// packages/adapters/codex-local/src/server/__tests__/codex-home.readSharedCodexModel.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readSharedCodexModel } from "../codex-home.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-codexhome-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("readSharedCodexModel", () => {
  it("returns the quoted model value", async () => {
    await fs.writeFile(
      path.join(dir, "config.toml"),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n',
    );
    expect(await readSharedCodexModel({ CODEX_HOME: dir })).toBe("gpt-5.5");
  });
  it("returns an unquoted model value", async () => {
    await fs.writeFile(path.join(dir, "config.toml"), "model = gpt-4.1\n");
    expect(await readSharedCodexModel({ CODEX_HOME: dir })).toBe("gpt-4.1");
  });
  it("returns a single-quoted model value — REVIEW FIX C5", async () => {
    await fs.writeFile(path.join(dir, "config.toml"), "model = 'gpt-4.1'\n");
    expect(await readSharedCodexModel({ CODEX_HOME: dir })).toBe("gpt-4.1");
  });
  it("reads the TOP-LEVEL model, ignoring nested-table model keys — REVIEW FIX C4/S4", async () => {
    await fs.writeFile(
      path.join(dir, "config.toml"),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n[profiles.fast]\nmodel = "gpt-4.1-mini"\n',
    );
    expect(await readSharedCodexModel({ CODEX_HOME: dir })).toBe("gpt-5.5");
  });
  it("returns null when the only model key lives under a table — REVIEW FIX C4/S4", async () => {
    await fs.writeFile(
      path.join(dir, "config.toml"),
      '# model = "should-ignore"\n[profiles.x]\nmodel = "nested"\n',
    );
    // Only the top-level section is scanned; the commented line is skipped and
    // the nested key is out of scope → null (deterministic, no host coupling).
    expect(await readSharedCodexModel({ CODEX_HOME: dir })).toBeNull();
  });
  it("returns null when config.toml is missing", async () => {
    expect(await readSharedCodexModel({ CODEX_HOME: dir })).toBeNull();
  });
  it("returns null when there is no model key", async () => {
    await fs.writeFile(path.join(dir, "config.toml"), "approval_policy = \"never\"\n");
    expect(await readSharedCodexModel({ CODEX_HOME: dir })).toBeNull();
  });
});
