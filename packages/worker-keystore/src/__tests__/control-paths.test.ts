/**
 * DSK-003 Lane A — where the control token and the host state record live.
 *
 * These sit BESIDE the device vault, resolved by the same rules, because inventing a
 * second location scheme is how a machine ends up with two ideas of "the AoA directory"
 * and a control command that cannot find the host it is running next to.
 *
 * The inherited rules, from `blob-path.ts`, are inherited on purpose:
 *
 *   - **win32 only.** DSK-001's D4 ships macOS and Linux as ports; `resolveVaultRefs`
 *     throws for them, and so does this. A path that resolved on a platform the vault
 *     refuses would be a control surface for an identity that cannot exist.
 *   - **Refuse rather than guess.** No fallback to APPDATA (roaming — the device identity
 *     must not follow a user between machines) and none to the cwd.
 *   - **Drive-letter absolute only.** A UNC path would put these on a share: reachable by
 *     everybody, and the 0600-equivalent ACL meaningless.
 */

import { describe, expect, it } from "vitest";

import { resolveControlPaths } from "../control-paths.js";
import { resolveVaultRefs } from "../blob-path.js";

const ENV = { LOCALAPPDATA: "C:\\Users\\tk\\AppData\\Local" };

describe("DSK-003 — the control files sit beside the vault", () => {
  it("resolves both paths under the same directory as the identity blob", () => {
    const { tokenPath, statePath } = resolveControlPaths(ENV, "win32");
    const vaultDir = resolveVaultRefs(ENV, "win32").identity.blobPath
      .split("\\").slice(0, -1).join("\\");
    expect(tokenPath.startsWith(`${vaultDir}\\`), tokenPath).toBe(true);
    expect(statePath.startsWith(`${vaultDir}\\`), statePath).toBe(true);
  });

  it("resolves a log path beside the other two", () => {
    // The host opens this itself, because Task Scheduler cannot redirect. It lives with
    // the vault for the same reason the others do: one AoA directory, one set of
    // refusals — not `%APPDATA%`, not `Library/Logs`, not the cwd.
    const { logPath, statePath } = resolveControlPaths(ENV, "win32");
    const dir = (p: string) => p.split("\\").slice(0, -1).join("\\");
    expect(dir(logPath)).toBe(dir(statePath));
    expect(logPath).toMatch(/host\.v1\.log$/);
  });

  it("gives the three files distinct, versioned names", () => {
    const { tokenPath, statePath, logPath } = resolveControlPaths(ENV, "win32");
    expect(new Set([tokenPath, statePath, logPath]).size).toBe(3);
  });

  it("gives the two files distinct, versioned names", () => {
    // A version in the filename makes a format change a deliberate migration rather
    // than a silent misparse, matching the vault's own convention.
    const { tokenPath, statePath } = resolveControlPaths(ENV, "win32");
    expect(tokenPath).not.toBe(statePath);
    expect(tokenPath).toMatch(/control-token\.v1\./);
    expect(statePath).toMatch(/host-state\.v1\./);
  });

  it("refuses every non-win32 platform, exactly as the vault does", () => {
    for (const platform of ["darwin", "linux", "aix"]) {
      expect(() => resolveControlPaths(ENV, platform), platform).toThrow(/not supported/i);
      // …and the vault refuses identically, so the two cannot drift apart.
      expect(() => resolveVaultRefs(ENV, platform), platform).toThrow(/not supported/i);
    }
  });

  it("refuses a missing LOCALAPPDATA rather than guessing", () => {
    for (const env of [{}, { LOCALAPPDATA: "" }, { LOCALAPPDATA: "   " }]) {
      expect(() => resolveControlPaths(env, "win32")).toThrow(/refusing to guess|not set/i);
    }
  });

  it("refuses a UNC path — these must not live on a share", () => {
    expect(() => resolveControlPaths({ LOCALAPPDATA: "\\\\server\\share" }, "win32"))
      .toThrow(/absolute local path/i);
  });

  it("does NOT fall back to APPDATA", () => {
    // Roaming would follow the user to another machine, taking the control token with
    // it — a credential for a host that is not there.
    expect(() => resolveControlPaths({ APPDATA: "C:\\Users\\tk\\AppData\\Roaming" }, "win32"))
      .toThrow();
  });

  it("is a pure function of env and platform", () => {
    expect(resolveControlPaths(ENV, "win32")).toEqual(resolveControlPaths(ENV, "win32"));
  });
});
