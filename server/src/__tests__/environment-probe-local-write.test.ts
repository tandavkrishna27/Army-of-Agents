import { describe, it, expect, afterEach } from "vitest";
import { probeEnvironmentConfig } from "../services/environment-probe.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const made: string[] = [];
afterEach(() => {
  for (const d of made) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  made.length = 0;
});

describe("local environment probe verifies writability", () => {
  it("passes for a writable path", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aoa-env-"));
    made.push(dir);
    const r = await probeEnvironmentConfig({ companyId: "c1", driver: "local", config: { path: dir } });
    expect(r.ok).toBe(true);
    expect(r.checks?.some((c) => c.status === "passed")).toBe(true);
  });

  it("passes when the directory does not exist yet but can be created", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aoa-env-"));
    made.push(base);
    const nested = path.join(base, "a", "b", "AoA");
    const r = await probeEnvironmentConfig({ companyId: "c1", driver: "local", config: { path: nested } });
    expect(r.ok).toBe(true);
  });

  it("fails (blocking) for a path that cannot be created/written", async () => {
    // A path *under a file* can never be a writable directory on any OS
    // (mkdir throws ENOTDIR/EEXIST) — deterministic cross-platform, unlike
    // a bare "/definitely/invalid" which Windows may happily create under C:\.
    const base = mkdtempSync(path.join(tmpdir(), "aoa-env-"));
    made.push(base);
    const file = path.join(base, "not-a-dir");
    writeFileSync(file, "x");
    const impossible = path.join(file, "child");
    const r = await probeEnvironmentConfig({ companyId: "c1", driver: "local", config: { path: impossible } });
    expect(r.ok).toBe(false);
    expect(r.checks?.some((c) => c.status === "failed")).toBe(true);
  });

  it("still passes with no path (back-compat — nothing to verify)", async () => {
    const r = await probeEnvironmentConfig({ companyId: "c1", driver: "local", config: {} });
    expect(r.ok).toBe(true);
  });
});
