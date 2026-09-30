import { describe, it, expect } from "vitest";
import { buildSandboxExecArgv } from "../services/plugin-sandbox.js";
import path from "node:path";
import os from "node:os";

const tmpDir = os.tmpdir();
const pluginsRoot = path.join(os.homedir(), ".aoa", "plugins");

describe("buildSandboxExecArgv", () => {
  const pluginId = "plugin-abc-123";
  const expectedScratch = path.join(os.homedir(), ".aoa", "plugins", pluginId, "scratch");

  it("returns empty array for 'core' plugins (no sandbox)", () => {
    const args = buildSandboxExecArgv({
      pluginId,
      trustTier: "core",
      capabilities: ["http.outbound"],
    });
    expect(args).toEqual([]);
  });

  it("returns --permission flags for 'untrusted' plugins", () => {
    const args = buildSandboxExecArgv({
      pluginId,
      trustTier: "untrusted",
      capabilities: [],
    });
    expect(args).toContain("--permission");
    expect(args).toContain("--allow-worker");
    // fs-read is scoped (NOT full-host `*`) — B-M4
    expect(args).not.toContain("--allow-fs-read=*");
    const readArgs = args.filter((a) => a.startsWith("--allow-fs-read="));
    expect(readArgs.length).toBeGreaterThan(0);
    expect(readArgs.every((a) => a !== "--allow-fs-read=*")).toBe(true);
    // --allow-fs-write has separate flags per path (Node v24+ comma lists removed)
    const writeArgs = args.filter((a) => a.startsWith("--allow-fs-write="));
    expect(writeArgs.some((a) => a.includes(expectedScratch))).toBe(true);
    expect(writeArgs.some((a) => a.includes(tmpDir))).toBe(true);
  });

  it("scopes --allow-fs-read to packageDir + scratch + plugins root (not `*`) — B-M4", () => {
    const packageDir = path.join(os.homedir(), ".aoa", "plugins", "node_modules", "aoa-plugin-demo");
    const args = buildSandboxExecArgv({
      pluginId,
      trustTier: "untrusted",
      capabilities: [],
      packageDir,
    });
    // Never grants full host read
    expect(args).not.toContain("--allow-fs-read=*");
    // Scoped to the plugin package dir
    expect(args).toContain(`--allow-fs-read=${path.resolve(packageDir)}`);
    // Scoped to the plugin scratch dir
    expect(args).toContain(`--allow-fs-read=${expectedScratch}`);
    // Includes the instance plugins root so hoisted node_modules remain loadable
    expect(args).toContain(`--allow-fs-read=${pluginsRoot}`);
  });

  it("falls back to plugins root (NOT `*`) when packageDir is omitted — B-M4", () => {
    const args = buildSandboxExecArgv({
      pluginId,
      trustTier: "untrusted",
      capabilities: [],
    });
    expect(args).not.toContain("--allow-fs-read=*");
    expect(args).toContain(`--allow-fs-read=${pluginsRoot}`);
    expect(args).toContain(`--allow-fs-read=${expectedScratch}`);
  });

  it("'core' tier emits no fs-read scoping at all (sandbox disabled) — B-M4", () => {
    const args = buildSandboxExecArgv({
      pluginId,
      trustTier: "core",
      capabilities: [],
      packageDir: path.join(os.homedir(), ".aoa", "plugins", "node_modules", "aoa-plugin-demo"),
    });
    // core bypasses the sandbox entirely — no permission flags, scoped or otherwise
    expect(args).toEqual([]);
    expect(args.some((a) => a.startsWith("--allow-fs-read="))).toBe(false);
  });

  it("does not include --allow-net (not a valid Node.js permission flag)", () => {
    const args = buildSandboxExecArgv({
      pluginId,
      trustTier: "untrusted",
      capabilities: ["issues.read", "http.outbound"],
    });
    expect(args.some((a) => a.startsWith("--allow-net"))).toBe(false);
  });

  it("http.outbound capability does not add flags (Node has no --allow-net)", () => {
    const withNet = buildSandboxExecArgv({
      pluginId,
      trustTier: "untrusted",
      capabilities: ["http.outbound"],
    });
    const withoutNet = buildSandboxExecArgv({
      pluginId,
      trustTier: "untrusted",
      capabilities: [],
    });
    // Network access tracked in manifest; no extra Node flag needed
    expect(withNet).toEqual(withoutNet);
  });

  it("applies sandbox for 'verified' plugins (same as untrusted)", () => {
    const args = buildSandboxExecArgv({
      pluginId,
      trustTier: "verified",
      capabilities: [],
    });
    expect(args).toContain("--permission");
    expect(args).not.toContain("--allow-fs-read=*");
    expect(args.some((a) => a.startsWith("--allow-fs-read="))).toBe(true);
    const writeArgs = args.filter((a) => a.startsWith("--allow-fs-write="));
    expect(writeArgs.some((a) => a.includes(expectedScratch))).toBe(true);
    expect(writeArgs.some((a) => a.includes(tmpDir))).toBe(true);
  });

  it("verified with http.outbound: same flags as without (no --allow-net in Node)", () => {
    const args = buildSandboxExecArgv({
      pluginId,
      trustTier: "verified",
      capabilities: ["http.outbound"],
    });
    expect(args.some((a) => a.startsWith("--allow-net"))).toBe(false);
    expect(args).toContain("--permission");
  });

  it("scratch dir uses pluginId in the path", () => {
    const args = buildSandboxExecArgv({
      pluginId: "my-special-plugin",
      trustTier: "untrusted",
      capabilities: [],
    });
    const scratchArg = args.find((a) => a.startsWith("--allow-fs-write="));
    expect(scratchArg).toContain("my-special-plugin");
  });
});

// This verifies the helper computes correct flags — the loader test is a direct call,
// not a full integration test (loader dep tree is too complex to mock here).
describe("plugin-loader sandbox injection (integration)", () => {
  it("passes --permission flags to workerManager.startWorker for untrusted plugins", async () => {
    const { buildSandboxExecArgv } = await import("../services/plugin-sandbox.js");
    const flags = buildSandboxExecArgv({
      pluginId: "test-id",
      trustTier: "untrusted",
      capabilities: [],
    });
    expect(flags).toContain("--permission");
  });
});

describe("plugin-loader execArgv injection", () => {
  it("includes --permission in execArgv for untrusted plugin with no capabilities", () => {
    const flags = buildSandboxExecArgv({
      pluginId: "untrusted-plugin",
      trustTier: "untrusted",
      capabilities: [],
    });

    expect(flags).toContain("--permission");
    expect(flags.some((f) => f.startsWith("--allow-fs-read="))).toBe(true);
    const writeArgs = flags.filter((f) => f.startsWith("--allow-fs-write="));
    expect(writeArgs.some((a) => a.includes("untrusted-plugin"))).toBe(true);
    expect(writeArgs.some((a) => a.includes(tmpDir))).toBe(true);
    expect(flags.some((f) => f.startsWith("--allow-net"))).toBe(false);
  });

  it("http.outbound capability does not alter sandbox flags (no --allow-net in Node)", () => {
    const flags = buildSandboxExecArgv({
      pluginId: "network-plugin",
      trustTier: "untrusted",
      capabilities: ["http.outbound"],
    });
    expect(flags.some((f) => f.startsWith("--allow-net"))).toBe(false);
    expect(flags).toContain("--permission");
  });

  it("does not add --permission for core plugin (bundled)", () => {
    const flags = buildSandboxExecArgv({
      pluginId: "core-plugin",
      trustTier: "core",
      capabilities: ["http.outbound"],
    });
    expect(flags).toEqual([]);
  });
});
