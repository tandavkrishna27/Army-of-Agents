// Plan 2b Task 6 (E) — the ownership manifest that lets the JSON MCP writers
// (opencode, gemini) sweep entries a PREVIOUS run wrote.
//
// The property under test is the B5 staleness fix: a connector the founder
// deletes must stop being offered to the agent, WITHOUT the sweep ever being
// able to remove a server the user added by hand.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readAoaManagedServerNames,
  removeLegacyCwdManifest,
  resolveMcpManagedManifestPath,
  sweepAoaManagedEntries,
  tryResolveMcpManagedManifestPath,
  tryWriteAoaManagedServerNames,
  writeAoaManagedServerNames,
  AOA_MCP_MANIFEST_FILENAME,
} from "../mcp-managed-manifest.js";

let tmpDir: string;
let manifestPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-mcp-manifest-"));
  manifestPath = path.join(tmpDir, "manifest.json");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("mcp managed manifest (round trip)", () => {
  it("writes then reads back the managed names", async () => {
    await writeAoaManagedServerNames(manifestPath, ["aoa", "notion"]);
    expect(await readAoaManagedServerNames(manifestPath)).toEqual(["aoa", "notion"]);
  });

  it("is byte-identical for the same set in any order (idempotence)", async () => {
    await writeAoaManagedServerNames(manifestPath, ["notion", "aoa", "notion"]);
    const first = await fs.readFile(manifestPath, "utf8");
    await writeAoaManagedServerNames(manifestPath, ["aoa", "notion"]);
    expect(await fs.readFile(manifestPath, "utf8")).toBe(first);
  });

  it("creates the parent directory if it does not exist", async () => {
    const nested = path.join(tmpDir, "a", "b", "c", "manifest.json");
    await writeAoaManagedServerNames(nested, ["aoa"]);
    expect(await readAoaManagedServerNames(nested)).toEqual(["aoa"]);
  });

  it("returns [] (sweep nothing) when the manifest is missing", async () => {
    expect(await readAoaManagedServerNames(manifestPath)).toEqual([]);
  });

  it("returns [] when the manifest is malformed JSON rather than guessing", async () => {
    // Guessing could only ever delete a user's data; a stale entry is
    // recoverable on the next healthy run.
    await fs.writeFile(manifestPath, "{not json", "utf8");
    expect(await readAoaManagedServerNames(manifestPath)).toEqual([]);
  });

  it("returns [] when managedServerNames is not an array", async () => {
    await fs.writeFile(manifestPath, JSON.stringify({ managedServerNames: "notion" }), "utf8");
    expect(await readAoaManagedServerNames(manifestPath)).toEqual([]);
  });

  it("drops non-string elements but ACTS ON the surviving string subset (M9)", async () => {
    // Documented behaviour: a partially-malformed array is NOT downgraded to
    // no-manifest — the names that survived are genuine ownership records, and
    // failing to sweep them is the bug this module exists to fix.
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ managedServerNames: ["notion", 7, null, "slack"] }),
      "utf8",
    );
    expect(await readAoaManagedServerNames(manifestPath)).toEqual(["notion", "slack"]);
  });

  it("leaves no temp files behind", async () => {
    await writeAoaManagedServerNames(manifestPath, ["aoa"]);
    expect(await fs.readdir(tmpDir)).toEqual(["manifest.json"]);
  });
});

describe("resolveMcpManagedManifestPath (I2 — never in the agent's repo)", () => {
  const env = { AOA_HOME: path.join(os.tmpdir(), "aoa-home-fixture") } as NodeJS.ProcessEnv;

  it("places the manifest under the AoA instance root, not the cwd", () => {
    const cwd = path.join(os.tmpdir(), "some-user-repo");
    const resolved = resolveMcpManagedManifestPath({ adapter: "opencode", cwd, env });
    expect(resolved.startsWith(path.resolve(env.AOA_HOME!))).toBe(true);
    expect(resolved.includes("some-user-repo")).toBe(false);
  });

  it("is deterministic for the same scope", () => {
    const scope = { adapter: "opencode", cwd: "/repo", companyId: "c1", agentId: "a1", env };
    expect(resolveMcpManagedManifestPath(scope)).toBe(resolveMcpManagedManifestPath(scope));
  });

  it("separates adapters, companies, agents, and cwds", () => {
    const base = { adapter: "opencode", cwd: "/repo", companyId: "c1", agentId: "a1", env };
    const paths = new Set([
      resolveMcpManagedManifestPath(base),
      resolveMcpManagedManifestPath({ ...base, adapter: "gemini" }),
      resolveMcpManagedManifestPath({ ...base, companyId: "c2" }),
      resolveMcpManagedManifestPath({ ...base, agentId: "a2" }),
      resolveMcpManagedManifestPath({ ...base, cwd: "/other" }),
    ]);
    expect(paths.size).toBe(5);
  });

  it("keys the digest with a NUL delimiter (persisted on-disk contract)", () => {
    // Pins the exact delimiter BYTE, not just "some delimiter". Changing it
    // silently re-points every already-written manifest, so a future edit that
    // swaps NUL for a space (e.g. while making this file non-binary to git)
    // must fail here rather than orphan real users' ownership records.
    const expected = createHash("sha256")
      .update(`c1\u0000a1\u0000${path.resolve("/repo")}`)
      .digest("hex")
      .slice(0, 32);
    const resolved = resolveMcpManagedManifestPath({
      adapter: "opencode",
      cwd: "/repo",
      companyId: "c1",
      agentId: "a1",
      env,
    });
    expect(path.basename(resolved)).toBe(`${expected}.json`);
  });

  it("does not let an id collide with a neighbour by concatenation", () => {
    const base = { adapter: "opencode", cwd: "/repo", env };
    const a = resolveMcpManagedManifestPath({ ...base, companyId: "a", agentId: "bc" });
    const b = resolveMcpManagedManifestPath({ ...base, companyId: "ab", agentId: "c" });
    expect(a).not.toBe(b);
  });

  it("never lets an untrusted id become a path segment", () => {
    const resolved = resolveMcpManagedManifestPath({
      adapter: "opencode",
      cwd: "/repo",
      companyId: "../../../../etc",
      agentId: "..",
      env,
    });
    expect(resolved).not.toContain("etc");
    expect(path.basename(resolved)).toMatch(/^[0-9a-f]{32}\.json$/);
  });

  it("falls back to a safe adapter segment for an unexpected adapter key", () => {
    const resolved = resolveMcpManagedManifestPath({ adapter: "../evil", cwd: "/repo", env });
    expect(resolved).toContain(`${path.sep}unknown${path.sep}`);
  });
});

describe("tryResolveMcpManagedManifestPath (M-3 robustness)", () => {
  it("returns a path when the instance root resolves", () => {
    expect(
      tryResolveMcpManagedManifestPath({
        adapter: "opencode",
        cwd: "/repo",
        env: { AOA_HOME: path.join(os.tmpdir(), "h") } as NodeJS.ProcessEnv,
      }),
    ).toContain("mcp-managed");
  });

  it("returns null instead of throwing on a malformed AOA_INSTANCE_ID", () => {
    // resolveAoaInstanceRootForAdapter throws here. Called bare, that throw
    // would abort the whole MCP config write — costing the agent ALL of its
    // tools over an env-var typo — which is exactly what the best-effort
    // envelope around the manifest exists to prevent.
    const env = {
      AOA_HOME: path.join(os.tmpdir(), "h"),
      AOA_INSTANCE_ID: "../../etc",
    } as NodeJS.ProcessEnv;
    expect(() =>
      resolveMcpManagedManifestPath({ adapter: "opencode", cwd: "/repo", env }),
    ).toThrow();
    expect(
      tryResolveMcpManagedManifestPath({ adapter: "opencode", cwd: "/repo", env }),
    ).toBeNull();
  });

  it("read/write treat a null path as 'ownership tracking unavailable'", async () => {
    expect(await readAoaManagedServerNames(null)).toEqual([]);
    expect(await tryWriteAoaManagedServerNames(null, ["aoa"])).toBe(false);
  });
});

describe("removeLegacyCwdManifest", () => {
  it("deletes an in-repo manifest left by an earlier build", async () => {
    const legacy = path.join(tmpDir, AOA_MCP_MANIFEST_FILENAME);
    await fs.writeFile(legacy, JSON.stringify({ managedServerNames: ["mine"] }), "utf8");
    await removeLegacyCwdManifest(tmpDir);
    await expect(fs.access(legacy)).rejects.toThrow();
  });

  it("is a no-op when there is nothing to remove", async () => {
    await expect(removeLegacyCwdManifest(tmpDir)).resolves.toBeUndefined();
  });
});

describe("sweepAoaManagedEntries", () => {
  it("removes previously-managed names and keeps everything else", () => {
    const survivors = sweepAoaManagedEntries(
      { aoa: 1, notion: 2, myOwnServer: 3 },
      ["aoa", "notion"],
    );
    expect(Object.keys(survivors)).toEqual(["myOwnServer"]);
  });

  it("NEVER removes a name AoA has not recorded (user's own entry)", () => {
    const survivors = sweepAoaManagedEntries({ myOwnServer: 3 }, ["aoa", "notion"]);
    expect(survivors.myOwnServer).toBe(3);
  });

  it("returns a null-prototype map so a later __proto__ assign is safe", () => {
    const survivors = sweepAoaManagedEntries({ keep: 1 }, []);
    expect(Object.getPrototypeOf(survivors)).toBeNull();

    // The real hazard: writers copy more names into this map afterwards. On a
    // normal object literal this assignment hits Object.prototype's __proto__
    // SETTER — no own key is created and the prototype is replaced instead.
    (survivors as Record<string, unknown>)["__proto__"] = { hacked: true };
    expect(Object.prototype.hasOwnProperty.call(survivors, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).hacked).toBeUndefined();
  });

  it("sweeps a __proto__ key that arrived as an own property from JSON.parse", () => {
    const parsed = JSON.parse('{"__proto__": {"evil": true}, "keep": 1}') as Record<
      string,
      unknown
    >;
    const survivors = sweepAoaManagedEntries(parsed, ["__proto__"]);
    expect(Object.prototype.hasOwnProperty.call(survivors, "__proto__")).toBe(false);
    expect(survivors.keep).toBe(1);
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
  });
});
