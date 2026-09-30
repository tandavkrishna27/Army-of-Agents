import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareScopedCliAuthHome,
  resolveScopedCliAuthHome,
  type ScopedCliAuthHomeArgs,
} from "../services/cli-auth-topology.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const target of cleanup.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

function fixture(root: string): ScopedCliAuthHomeArgs {
  return {
    env: { AOA_HOME: root },
    executionTargetId: "hetzner-qa",
    companyId: "company-a",
    userId: "user-a",
    provider: "openai",
  };
}

describe("scoped CLI auth-home preparation", () => {
  it("creates the exact derived home beneath the real AOA root", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "aoa-auth-home-"));
    cleanup.push(parent);
    const root = path.join(parent, "nested", "aoa");
    const args = fixture(root);

    const prepared = prepareScopedCliAuthHome(args);

    expect(prepared).toBe(resolveScopedCliAuthHome(args));
    expect(fs.lstatSync(prepared).isDirectory()).toBe(true);
    expect(fs.realpathSync(prepared).startsWith(`${fs.realpathSync(root)}${path.sep}`)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(prepared).mode & 0o777).toBe(0o700);
    }
  });

  it.each(["openai", "anthropic"] as const)(
    "rejects a symlinked ancestor before starting the %s login runner",
    (provider) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "aoa-auth-root-"));
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "aoa-auth-outside-"));
      cleanup.push(root, outside);
      const args = { ...fixture(root), provider };
      const authHome = resolveScopedCliAuthHome(args);
      const relativeSegments = path.relative(root, authHome).split(path.sep);
      const link = path.join(root, relativeSegments[0]!, relativeSegments[1]!);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");

      expect(() => prepareScopedCliAuthHome(args)).toThrow(/not a regular directory/);
      expect(fs.readdirSync(outside)).toEqual([]);
    },
  );

  it("rejects a symlink configured as AOA_HOME", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "aoa-auth-root-link-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "aoa-auth-root-target-"));
    cleanup.push(parent, outside);
    const rootLink = path.join(parent, "aoa");
    fs.symlinkSync(outside, rootLink, process.platform === "win32" ? "junction" : "dir");

    expect(() => prepareScopedCliAuthHome(fixture(rootLink))).toThrow(
      /not a regular directory/,
    );
  });
});
