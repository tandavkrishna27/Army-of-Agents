// Plan 2b B7 (corrected) — gemini folder trust disables EVERY MCP server,
// including AoA's own bridge, while the run still exits 0.
//
// `--skip-trust` and per-server `"trust": true` were BOTH empirically
// disproven as remedies (see gemini-folder-trust.ts for the probe table), so
// the adapter's only honest move is to detect the condition and say so loudly.
// These tests pin the detection and the warning's content — in particular that
// the warning keeps telling future maintainers NOT to reach for --skip-trust.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectGeminiFolderTrust,
  geminiFolderTrustWarning,
} from "../gemini-folder-trust.js";

let tmpDir: string;
let homeDir: string;
let cwd: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-gemini-trust-"));
  homeDir = path.join(tmpDir, "home");
  cwd = path.join(tmpDir, "workspace");
  await fs.mkdir(path.join(homeDir, ".gemini"), { recursive: true });
  await fs.mkdir(path.join(cwd, ".gemini"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

async function writeUserSettings(value: unknown): Promise<void> {
  await fs.writeFile(
    path.join(homeDir, ".gemini", "settings.json"),
    JSON.stringify(value),
    "utf8",
  );
}

async function writeWorkspaceSettings(value: unknown): Promise<void> {
  await fs.writeFile(
    path.join(cwd, ".gemini", "settings.json"),
    JSON.stringify(value),
    "utf8",
  );
}

describe("detectGeminiFolderTrust", () => {
  it("detects the current nested shape (security.folderTrust.enabled)", async () => {
    await writeUserSettings({ security: { folderTrust: { enabled: true } } });
    const result = await detectGeminiFolderTrust(cwd, homeDir);
    expect(result.enabled).toBe(true);
    expect(result.source).toBe(path.join(homeDir, ".gemini", "settings.json"));
  });

  it("detects a bare boolean under security", async () => {
    await writeUserSettings({ security: { folderTrust: true } });
    expect((await detectGeminiFolderTrust(cwd, homeDir)).enabled).toBe(true);
  });

  it("detects the legacy top-level shapes", async () => {
    await writeUserSettings({ folderTrust: true });
    expect((await detectGeminiFolderTrust(cwd, homeDir)).enabled).toBe(true);

    await writeUserSettings({ folderTrust: { enabled: true } });
    expect((await detectGeminiFolderTrust(cwd, homeDir)).enabled).toBe(true);
  });

  it("detects it in the WORKSPACE settings too (the file AoA itself writes)", async () => {
    await writeUserSettings({ theme: "dark" });
    await writeWorkspaceSettings({ security: { folderTrust: { enabled: true } } });
    const result = await detectGeminiFolderTrust(cwd, homeDir);
    expect(result.enabled).toBe(true);
    expect(result.source).toBe(path.join(cwd, ".gemini", "settings.json"));
  });

  it("reports NOT enabled when folder trust is explicitly off", async () => {
    await writeUserSettings({ security: { folderTrust: { enabled: false } } });
    expect((await detectGeminiFolderTrust(cwd, homeDir)).enabled).toBe(false);
  });

  it("reports NOT enabled when the setting is absent (the default)", async () => {
    await writeUserSettings({ theme: "dark" });
    expect((await detectGeminiFolderTrust(cwd, homeDir)).enabled).toBe(false);
  });

  it("reports NOT enabled when no settings file exists at all", async () => {
    const result = await detectGeminiFolderTrust(cwd, path.join(tmpDir, "nonexistent"));
    expect(result).toEqual({ enabled: false, source: null });
  });

  it("does NOT cry wolf on malformed JSON", async () => {
    // A false positive would fire on every run of a healthy setup, which is
    // how operators learn to ignore the warning.
    await fs.writeFile(path.join(homeDir, ".gemini", "settings.json"), "{oops", "utf8");
    expect((await detectGeminiFolderTrust(cwd, homeDir)).enabled).toBe(false);
  });

  it("does not throw when settings.json is a directory (best-effort contract)", async () => {
    await fs.rm(path.join(homeDir, ".gemini", "settings.json"), { force: true });
    await fs.mkdir(path.join(homeDir, ".gemini", "settings.json"), { recursive: true });
    await expect(detectGeminiFolderTrust(cwd, homeDir)).resolves.toEqual({
      enabled: false,
      source: null,
    });
  });

  it("ignores a truthy-but-not-true value rather than guessing", async () => {
    await writeUserSettings({ security: { folderTrust: { enabled: "yes" } } });
    expect((await detectGeminiFolderTrust(cwd, homeDir)).enabled).toBe(false);
  });
});

describe("geminiFolderTrustWarning", () => {
  const warning = geminiFolderTrustWarning("/home/u/.gemini/settings.json");

  it("says the agent will have NO tools, not merely 'connectors are affected'", () => {
    expect(warning).toContain("ZERO MCP servers");
    expect(warning).toContain("NO TOOLS");
    // The bridge going down too is the part that makes this total, not partial.
    expect(warning).toContain("bridge");
  });

  it("names the setting responsible and where it came from", () => {
    expect(warning).toContain("security.folderTrust.enabled");
    expect(warning).toContain("/home/u/.gemini/settings.json");
  });

  it("warns future maintainers OFF --skip-trust", () => {
    // The whole point of B7's correction: --skip-trust looks like the fix and
    // is not. If this assertion is ever deleted, re-read the probe table.
    expect(warning).toContain("--skip-trust does NOT fix this");
  });

  it("reads sensibly with no known source", () => {
    const anon = geminiFolderTrustWarning(null);
    expect(anon).toContain("ZERO MCP servers");
    expect(anon).not.toContain("(set in");
  });
});
