import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveCompanyWorkspaceRoot } from "../services/company-workspace-root.js";

const BASE_DIR = path.join(os.tmpdir(), "aoa-company-workspaces-test-base");

describe("resolveCompanyWorkspaceRoot — WS0a deployment split", () => {
  it("local_trusted: returns the real home dir, unjailed", () => {
    const root = resolveCompanyWorkspaceRoot("company-A", "local_trusted", {
      companyWorkspaceBaseDir: BASE_DIR,
    });
    expect(root.jailed).toBe(false);
    expect(root.baseDir).toBe(os.homedir());
  });

  it("authenticated: returns a server-owned per-company base dir, jailed", () => {
    const root = resolveCompanyWorkspaceRoot("company-A", "authenticated", {
      companyWorkspaceBaseDir: BASE_DIR,
    });
    expect(root.jailed).toBe(true);
    expect(root.baseDir).toBe(path.join(BASE_DIR, "company-A"));
  });

  it("authenticated: never returns the instance-configured base dir bare (always company-scoped)", () => {
    const rootA = resolveCompanyWorkspaceRoot("company-A", "authenticated", {
      companyWorkspaceBaseDir: BASE_DIR,
    });
    const rootB = resolveCompanyWorkspaceRoot("company-B", "authenticated", {
      companyWorkspaceBaseDir: BASE_DIR,
    });
    expect(rootA.baseDir).not.toBe(rootB.baseDir);
    expect(rootA.baseDir.startsWith(BASE_DIR)).toBe(true);
    expect(rootB.baseDir.startsWith(BASE_DIR)).toBe(true);
  });

  it("authenticated: rejects a companyId containing path traversal or separators", () => {
    expect(() =>
      resolveCompanyWorkspaceRoot("../escape", "authenticated", {
        companyWorkspaceBaseDir: BASE_DIR,
      }),
    ).toThrow();
    expect(() =>
      resolveCompanyWorkspaceRoot("foo/bar", "authenticated", {
        companyWorkspaceBaseDir: BASE_DIR,
      }),
    ).toThrow();
    expect(() =>
      resolveCompanyWorkspaceRoot("foo\\bar", "authenticated", {
        companyWorkspaceBaseDir: BASE_DIR,
      }),
    ).toThrow();
  });
});
