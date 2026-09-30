import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveScopedCliAuthHome } from "../services/cli-auth-topology.js";
import { removeScopedSubscriptionCredentialHome } from "../services/provider-credentials.js";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("provider credential filesystem lifecycle", () => {
  it("removes only the derived scoped credential home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-credential-revoke-"));
    cleanupRoots.push(root);
    const args = {
      env: { AOA_HOME: root },
      companyId: "company-a",
      userId: "user-a",
      provider: "openai" as const,
      executionTargetId: "target-a",
    };
    const authHome = resolveScopedCliAuthHome(args);
    const sibling = path.join(root, "keep.txt");
    await fs.mkdir(authHome, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(authHome, "auth.json"), "{}"),
      fs.writeFile(sibling, "keep"),
    ]);

    await expect(removeScopedSubscriptionCredentialHome(args)).resolves.toBe(true);
    await expect(fs.stat(authHome)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(sibling, "utf8")).resolves.toBe("keep");
  });

  it("refuses to follow a symlinked credential home", async () => {
    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-credential-symlink-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-credential-outside-"));
    cleanupRoots.push(root, outside);
    const args = {
      env: { AOA_HOME: root },
      companyId: "company-a",
      userId: "user-a",
      provider: "anthropic" as const,
      executionTargetId: "target-a",
    };
    const authHome = resolveScopedCliAuthHome(args);
    await fs.mkdir(path.dirname(authHome), { recursive: true });
    await fs.symlink(outside, authHome, "dir");

    await expect(removeScopedSubscriptionCredentialHome(args)).rejects.toThrow(
      /not a regular scoped directory/,
    );
  });
});
