import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mergeChildEnv } from "@armyofagents/adapter-utils/server-utils";
import {
  CLAUDE_AMBIENT_CONFIG_KEEP_KEYS,
  CLAUDE_AMBIENT_CONFIG_UNSET_PREFIXES,
  ClaudeCredentialsMissingError,
  ISOLATED_CLAUDE_CONFIG_DIR_PREFIX,
  claudeCredentialChangedSinceProvisioning,
  createIsolatedClaudeConfigDir,
  hasOverlayConfiguredClaudeAuth,
  isLiveIsolatedClaudeConfigDir,
  provisionClaudeConfigHome,
  releaseIsolatedClaudeConfigDir,
  resolveIsolatedClaudeConfigRoot,
  sweepOrphanedIsolatedClaudeConfigDirs,
} from "../ambient-config.js";
import { CLAUDE_CREDENTIAL_FILE_NAME } from "../login.js";


/**
 * The strip list itself. `mergeChildEnv`'s prefix semantics are proven in
 * adapter-utils; what is proven HERE is that THIS list strips the host Claude
 * config class and — the part that would break real work if it regressed —
 * leaves the keep-list alone.
 */
describe("claude ambient-config strip list", () => {
  const prefixes = [...CLAUDE_AMBIENT_CONFIG_UNSET_PREFIXES];

  it("names exactly the CLAUDE_/ANTHROPIC_ host-config classes", () => {
    expect(prefixes).toEqual(["CLAUDE_", "ANTHROPIC_"]);
  });

  it("strips ambient Claude/Anthropic config a crew run must not inherit", () => {
    const out = mergeChildEnv(
      {
        CLAUDE_CONFIG_DIR: "/home/operator/.claude",
        CLAUDE_CODE_USE_BEDROCK: "1",
        // Not enumerated anywhere — the reason this is a PREFIX class.
        CLAUDE_SOME_FUTURE_KNOB: "on",
        ANTHROPIC_API_KEY: "sk-ant-server",
        ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example",
      },
      {},
      undefined,
      prefixes,
    );
    expect(Object.keys(out)).toEqual([]);
  });

  // 🚨 git, SSH and npm all resolve through HOME/USERPROFILE for tools the agent
  // launches, and PATH is how the CLI is found at all. Relocating or stripping
  // any of these breaks the agent's real work, not just its config isolation.
  it("leaves every keep-list variable untouched", () => {
    const ambient: Record<string, string> = {};
    for (const key of CLAUDE_AMBIENT_CONFIG_KEEP_KEYS) ambient[key] = `value-of-${key}`;
    const out = mergeChildEnv(ambient, {}, undefined, prefixes);
    for (const key of CLAUDE_AMBIENT_CONFIG_KEEP_KEYS) {
      expect(out[key], `${key} must survive the ambient-config strip`).toBe(`value-of-${key}`);
    }
  });

  it("keeps PATH, HOME and USERPROFILE on the keep-list", () => {
    expect(CLAUDE_AMBIENT_CONFIG_KEEP_KEYS).toEqual(
      expect.arrayContaining(["PATH", "HOME", "USERPROFILE"]),
    );
  });
});

/**
 * T3 — per-run Claude config-home provisioning.
 *
 * T2 pins `CLAUDE_CONFIG_DIR` to a fresh, EMPTY per-run directory, which makes a
 * crew run unauthenticated. T3 puts exactly ONE file in it: the credential.
 * These tests are the "exactly one" proof, plus the boot sweep that stops an
 * orphaned per-run directory from becoming credentials at rest.
 */

/**
 * The other 19 entries of a REAL operator config home, verified by listing names
 * on a dogfood machine (docs/aoa/plans/2026-07-19-crew-execution-phase1-foundation.md).
 * Every one of them is a contamination source — hooks, plugins, third-party
 * skills, global instructions, session identity — and none of them may be copied.
 */
const OPERATOR_CONFIG_FILES = [
  "CLAUDE.md",
  "settings.json",
  "mcp-needs-auth-cache.json",
  "history.jsonl",
  ".last-cleanup",
];
const OPERATOR_CONFIG_DIRS = [
  "plugins",
  "skills",
  "projects",
  "sessions",
  "ide",
  "shell-snapshots",
  "telemetry",
  "cache",
  "tasks",
  "plans",
  "backups",
  "chrome",
  "debug",
  "session-env",
];

const CREDENTIAL_BODY = JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token" } });

const roots: string[] = [];

async function makeRoot(label: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `aoa-t3-${label}-`));
  roots.push(root);
  return root;
}

/** A stand-in for the operator's `~/.claude`: all 20 entries, or 19 with `withCredential: false`. */
async function seedOperatorConfigHome(
  root: string,
  opts: { withCredential?: boolean } = {},
): Promise<string> {
  const home = path.join(root, "operator-dot-claude");
  await fs.mkdir(home, { recursive: true });
  if (opts.withCredential !== false) {
    await fs.writeFile(path.join(home, CLAUDE_CREDENTIAL_FILE_NAME), CREDENTIAL_BODY, "utf8");
  }
  for (const file of OPERATOR_CONFIG_FILES) {
    await fs.writeFile(path.join(home, file), `operator ${file}`, "utf8");
  }
  for (const dir of OPERATOR_CONFIG_DIRS) {
    await fs.mkdir(path.join(home, dir), { recursive: true });
    await fs.writeFile(path.join(home, dir, "payload.txt"), "operator payload", "utf8");
  }
  return home;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

describe("provisionClaudeConfigHome", () => {
  it("copies the credential file and NOTHING else from a 20-entry operator home", async () => {
    const root = await makeRoot("copy");
    const sourceConfigHome = await seedOperatorConfigHome(root);
    const targetDir = path.join(root, "per-run");
    await fs.mkdir(targetDir);

    const result = await provisionClaudeConfigHome({ sourceConfigHome, targetDir });

    expect(result.credentialPath).toBe(path.join(targetDir, CLAUDE_CREDENTIAL_FILE_NAME));
    expect(await fs.readFile(result.credentialPath, "utf8")).toBe(CREDENTIAL_BODY);

    // Exactly one entry — the strongest form of "the other 19 are absent".
    const entries = await fs.readdir(targetDir);
    expect(entries).toEqual([CLAUDE_CREDENTIAL_FILE_NAME]);

    // …and named individually, so a regression names the leak rather than a count.
    for (const name of [...OPERATOR_CONFIG_FILES, ...OPERATOR_CONFIG_DIRS]) {
      expect(entries, `${name} must never be provisioned`).not.toContain(name);
    }
  });

  it("creates the target directory when it does not exist yet", async () => {
    const root = await makeRoot("mkdir");
    const sourceConfigHome = await seedOperatorConfigHome(root);
    const targetDir = path.join(root, "not-yet-there");

    await provisionClaudeConfigHome({ sourceConfigHome, targetDir });

    expect(await fs.readdir(targetDir)).toEqual([CLAUDE_CREDENTIAL_FILE_NAME]);
  });

  /**
   * 🚨 THE WINDOWS HALF OF THE CREDENTIAL-AT-REST GUARANTEE.
   *
   * There is no POSIX mode to assert on Windows, and the previous
   * `skipIf(win32)` left the platform with NO assertion at all — while the
   * implementation rested on a claim about `%TEMP%`'s ACL that turned out to be
   * false on a real machine (eight non-inherited `(OI)(CI)` Modify ACEs for
   * other principals, one of them a group). The assertable, and now true, claim
   * is about LOCATION: the credential lands under the AoA-owned root inside the
   * user profile, and never in the shared temp directory.
   *
   * Runs on every platform — the location guarantee is not Windows-specific,
   * and a POSIX-only regression would move the credential for everyone.
   */
  it("mints per-run homes under the AoA root, never in the shared temp dir", async () => {
    const dir = await createIsolatedClaudeConfigDir();
    try {
      const root = path.resolve(resolveIsolatedClaudeConfigRoot());
      expect(path.resolve(dir).startsWith(root + path.sep)).toBe(true);
      expect(path.basename(dir).startsWith(ISOLATED_CLAUDE_CONFIG_DIR_PREFIX)).toBe(true);
      // The regression this exists to prevent: os.tmpdir() is shared by default,
      // and on a service-account deployment it is C:\Windows\Temp.
      expect(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(false);
    } finally {
      releaseIsolatedClaudeConfigDir(dir);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("puts the provisioned credential inside that same AoA-owned root", async () => {
    const rootDir = await makeRoot("located");
    const sourceConfigHome = await seedOperatorConfigHome(rootDir);
    const targetDir = await createIsolatedClaudeConfigDir();
    try {
      const { credentialPath } = await provisionClaudeConfigHome({ sourceConfigHome, targetDir });
      const aoaRoot = path.resolve(resolveIsolatedClaudeConfigRoot());
      expect(path.resolve(path.dirname(credentialPath)).startsWith(aoaRoot + path.sep)).toBe(true);
      expect(
        path.resolve(credentialPath).startsWith(path.resolve(os.tmpdir()) + path.sep),
        "a credential must never be written into the shared temp directory",
      ).toBe(false);
    } finally {
      releaseIsolatedClaudeConfigDir(targetDir);
      await fs.rm(targetDir, { recursive: true, force: true });
    }
  });

  // A credential at rest. POSIX additionally gets a real file mode; Windows has
  // no POSIX modes, which is exactly why the location assertions above carry the
  // guarantee there rather than a chmod that only toggles the read-only bit.
  it.skipIf(process.platform === "win32")(
    "writes the copied credential as owner-only (0600)",
    async () => {
      const root = await makeRoot("mode");
      const sourceConfigHome = await seedOperatorConfigHome(root);
      // Deliberately world-readable at the source: the copy must not inherit it.
      await fs.chmod(path.join(sourceConfigHome, CLAUDE_CREDENTIAL_FILE_NAME), 0o644);
      const targetDir = path.join(root, "per-run");

      const { credentialPath } = await provisionClaudeConfigHome({ sourceConfigHome, targetDir });

      const stat = await fs.stat(credentialPath);
      expect(stat.mode & 0o777).toBe(0o600);
    },
  );

  it("throws an actionable ClaudeCredentialsMissingError when the source has no credential", async () => {
    const root = await makeRoot("missing");
    const sourceConfigHome = await seedOperatorConfigHome(root, { withCredential: false });
    const targetDir = path.join(root, "per-run");

    const err = await provisionClaudeConfigHome({ sourceConfigHome, targetDir }).catch((e) => e);

    expect(err).toBeInstanceOf(ClaudeCredentialsMissingError);
    // The founder must be able to act on this without reading source: it has to
    // name WHERE we looked and WHAT to run. The raw paths stay on the error's own
    // fields for logs; the MESSAGE is home-relative (see below).
    expect(err.credentialPath).toBe(path.join(sourceConfigHome, CLAUDE_CREDENTIAL_FILE_NAME));
    expect(err.sourceConfigHome).toBe(path.resolve(sourceConfigHome));
    expect(err.message).toContain(CLAUDE_CREDENTIAL_FILE_NAME);
    expect(err.message).toContain("claude auth login");
  });

  /**
   * This message is persisted verbatim to `internal_agent_runs.errorMessage` and
   * rendered on the crew failure card, so it reaches every teammate with thread
   * access. `C:\Users\<name>\.claude` would put the operator's account name in
   * front of all of them; `~/.claude` is exactly as actionable and says nothing
   * about who they are.
   */
  it("home-relativises the paths it puts in the founder-facing message", async () => {
    const home = path.resolve(os.homedir());
    const sourceConfigHome = path.join(home, ".claude-t3-fixture-does-not-exist");
    const targetDir = path.join(home, ".aoa-t3-fixture-target");

    const err = (await provisionClaudeConfigHome({ sourceConfigHome, targetDir }).catch(
      (e) => e,
    )) as ClaudeCredentialsMissingError;

    expect(err).toBeInstanceOf(ClaudeCredentialsMissingError);
    expect(err.message, "the operator's home path must not be broadcast").not.toContain(home);
    expect(err.message).toContain(`~${path.sep}.claude-t3-fixture-does-not-exist`);
    // …while the untouched real paths remain available for server-side logs.
    expect(err.sourceConfigHome).toBe(sourceConfigHome);
  });

  it("does not create the target directory when the credential is missing", async () => {
    const root = await makeRoot("missing-nodir");
    const sourceConfigHome = await seedOperatorConfigHome(root, { withCredential: false });
    const targetDir = path.join(root, "per-run");

    await provisionClaudeConfigHome({ sourceConfigHome, targetDir }).catch(() => {});

    await expect(fs.stat(targetDir)).rejects.toThrow();
  });

  it("refuses a directory-shaped credential at the source", async () => {
    const root = await makeRoot("dirshaped");
    const sourceConfigHome = await seedOperatorConfigHome(root, { withCredential: false });
    await fs.mkdir(path.join(sourceConfigHome, CLAUDE_CREDENTIAL_FILE_NAME));
    const targetDir = path.join(root, "per-run");

    await expect(provisionClaudeConfigHome({ sourceConfigHome, targetDir })).rejects.toBeInstanceOf(
      ClaudeCredentialsMissingError,
    );
  });

  /**
   * 🚨 THE ORDERING TRAP, as a structural invariant.
   *
   * The source must be resolved from the AMBIENT environment, before T2's pin
   * rewrites `CLAUDE_CONFIG_DIR` to the per-run directory. Resolve it after (or
   * from the overlay) and `resolveClaudeConfigHome` returns the copy TARGET —
   * an empty directory copied onto itself, which would otherwise "succeed"
   * having provisioned nothing and fail deep in the CLI with an opaque error.
   */
  it("throws rather than copying a directory onto itself (source === target)", async () => {
    const root = await makeRoot("inversion");
    const sourceConfigHome = await seedOperatorConfigHome(root);

    await expect(
      provisionClaudeConfigHome({ sourceConfigHome, targetDir: sourceConfigHome }),
    ).rejects.toThrow(/same directory/i);
  });

  it("treats a non-normalized path to the same directory as an inversion too", async () => {
    const root = await makeRoot("inversion-rel");
    const sourceConfigHome = await seedOperatorConfigHome(root);

    await expect(
      provisionClaudeConfigHome({
        sourceConfigHome,
        targetDir: path.join(sourceConfigHome, "..", path.basename(sourceConfigHome)),
      }),
    ).rejects.toThrow(/same directory/i);
  });
});

describe("hasOverlayConfiguredClaudeAuth", () => {
  it("is false for an overlay carrying no auth variable", () => {
    expect(hasOverlayConfiguredClaudeAuth({ AOA_RUN_ID: "r1", AOA_AGENT_ID: "a1" })).toBe(false);
  });

  it("is false when an auth variable is present but blank", () => {
    expect(hasOverlayConfiguredClaudeAuth({ ANTHROPIC_API_KEY: "   " })).toBe(false);
  });

  // T2's documented escape hatch: an operator whose Claude access is env-based
  // sets it on adapterConfig.env, where overlay-wins keeps it through the strip.
  // Provisioning must not turn that working configuration into a hard failure.
  it.each([
    ["ANTHROPIC_API_KEY", "sk-ant-configured"],
    ["ANTHROPIC_AUTH_TOKEN", "tok"],
    ["CLAUDE_CODE_OAUTH_TOKEN", "tok"],
    ["CLAUDE_CODE_USE_BEDROCK", "1"],
    ["ANTHROPIC_BEDROCK_BASE_URL", "https://bedrock.example"],
    ["CLAUDE_CODE_USE_VERTEX", "1"],
    ["ANTHROPIC_VERTEX_PROJECT_ID", "proj"],
    ["ANTHROPIC_BASE_URL", "https://gateway.example"],
    ["CLAUDE_CODE_USE_BEDROCK", "true"],
    ["CLAUDE_CODE_USE_VERTEX", "yes"],
  ])("is true for a configured %s", (key, value) => {
    expect(hasOverlayConfiguredClaudeAuth({ [key]: value })).toBe(true);
  });

  /**
   * 🚨 An operator who explicitly turned Bedrock/Vertex OFF has NOT configured
   * auth. Reading `CLAUDE_CODE_USE_BEDROCK=0` as "configured" would suppress the
   * pre-spawn refusal and downgrade it to an opaque in-CLI failure — for exactly
   * the operator that refusal exists to help. The original test only covered
   * `"1"`, which is how this slipped through.
   */
  it.each([
    ["CLAUDE_CODE_USE_BEDROCK", "0"],
    ["CLAUDE_CODE_USE_BEDROCK", "false"],
    ["CLAUDE_CODE_USE_BEDROCK", "FALSE"],
    ["CLAUDE_CODE_USE_BEDROCK", " off "],
    ["CLAUDE_CODE_USE_VERTEX", "0"],
    ["CLAUDE_CODE_USE_VERTEX", "no"],
  ])("is false for an explicitly-disabled %s=%s", (key, value) => {
    expect(hasOverlayConfiguredClaudeAuth({ [key]: value })).toBe(false);
  });

  // The falsy-spelling rule is for SWITCHES only. A URL or a key has no "off"
  // spelling, so `0` there is a value the operator meant — weird, but theirs.
  it.each([
    ["ANTHROPIC_BASE_URL", "0"],
    ["ANTHROPIC_BEDROCK_BASE_URL", "false"],
    ["ANTHROPIC_API_KEY", "0"],
  ])("keeps the plain non-empty rule for the value-shaped %s", (key, value) => {
    expect(hasOverlayConfiguredClaudeAuth({ [key]: value })).toBe(true);
  });

  it.runIf(process.platform === "win32")(
    "case-folds on Windows, where Anthropic_Api_Key IS ANTHROPIC_API_KEY",
    () => {
      expect(hasOverlayConfiguredClaudeAuth({ Anthropic_Api_Key: "sk-ant-configured" })).toBe(true);
    },
  );

  it.runIf(process.platform === "win32")(
    "case-folds the disabled-switch check too",
    () => {
      expect(hasOverlayConfiguredClaudeAuth({ Claude_Code_Use_Bedrock: "0" })).toBe(false);
    },
  );
});

describe("claudeCredentialChangedSinceProvisioning", () => {
  /**
   * The instrument for the OPEN rotation question (see provisionClaudeConfigHome).
   * If the CLI refreshes the OAuth token into its private copy, that copy is
   * about to be deleted — and the operator's host login may have been rotated
   * out from under them. This detector is what turns that from invisible into
   * a warning on the first real occurrence.
   */
  it("is false when the child left the credential alone", async () => {
    const root = await makeRoot("rot-clean");
    const sourceConfigHome = await seedOperatorConfigHome(root);
    const targetDir = path.join(root, "per-run");

    const { credentialPath, fingerprint } = await provisionClaudeConfigHome({
      sourceConfigHome,
      targetDir,
    });

    await expect(
      claudeCredentialChangedSinceProvisioning(credentialPath, fingerprint),
    ).resolves.toBe(false);
  });

  it("is true when the child rewrote it (an OAuth refresh)", async () => {
    const root = await makeRoot("rot-dirty");
    const sourceConfigHome = await seedOperatorConfigHome(root);
    const targetDir = path.join(root, "per-run");

    const { credentialPath, fingerprint } = await provisionClaudeConfigHome({
      sourceConfigHome,
      targetDir,
    });
    // A refresh rewrites the file: different size, different mtime.
    await fs.writeFile(
      credentialPath,
      JSON.stringify({ claudeAiOauth: { accessToken: "refreshed-token-is-longer-than-before" } }),
      "utf8",
    );

    await expect(
      claudeCredentialChangedSinceProvisioning(credentialPath, fingerprint),
    ).resolves.toBe(true);
  });

  // Runs in teardown, where throwing would mask the run's real outcome.
  it("reports no change rather than throwing when the file is gone", async () => {
    await expect(
      claudeCredentialChangedSinceProvisioning(
        path.join(os.tmpdir(), "aoa-t3-absent", CLAUDE_CREDENTIAL_FILE_NAME),
        "123:456",
      ),
    ).resolves.toBe(false);
  });
});

describe("sweepOrphanedIsolatedClaudeConfigDirs", () => {
  const MAX_AGE_MS = 12 * 60 * 60 * 1000;

  async function agedDir(rootDir: string, name: string, ageMs: number): Promise<string> {
    const dir = path.join(rootDir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, CLAUDE_CREDENTIAL_FILE_NAME), CREDENTIAL_BODY, "utf8");
    const when = new Date(Date.now() - ageMs);
    await fs.utimes(dir, when, when);
    return dir;
  }

  it("removes an aged per-run dir and leaves a fresh one", async () => {
    const rootDir = await makeRoot("sweep");
    const stale = await agedDir(rootDir, `${ISOLATED_CLAUDE_CONFIG_DIR_PREFIX}stale`, MAX_AGE_MS * 2);
    const fresh = await agedDir(rootDir, `${ISOLATED_CLAUDE_CONFIG_DIR_PREFIX}fresh`, 0);

    const result = await sweepOrphanedIsolatedClaudeConfigDirs({ rootDir, maxAgeMs: MAX_AGE_MS });

    expect(result.removed).toBe(1);
    await expect(fs.stat(stale)).rejects.toThrow();
    expect((await fs.stat(fresh)).isDirectory()).toBe(true);
  });

  /**
   * 🚨 AGE ALONE CANNOT PROTECT A LIVE RUN.
   *
   * A directory's mtime moves only when an entry is created/renamed/removed
   * directly inside it — not when the CLI writes into `sessions/`, not when it
   * rewrites `.credentials.json` in place. So mtime goes static minutes into a
   * run while `timeoutSec` defaults to 0 and leaves the run unbounded. Without
   * the live set, a long run's config home is deleted underneath it and the CLI
   * hits ENOENT mid-session.
   */
  it("never sweeps a directory a live run still holds, however old it looks", async () => {
    const rootDir = await makeRoot("sweep-live");
    const live = await agedDir(rootDir, `${ISOLATED_CLAUDE_CONFIG_DIR_PREFIX}live`, MAX_AGE_MS * 10);
    // Register it the way createIsolatedClaudeConfigDir would.
    const minted = await createIsolatedClaudeConfigDir();
    try {
      // Same-name check via the real registry: mark the aged fixture live by
      // minting is not possible, so assert on the minted one AND the fixture.
      expect(isLiveIsolatedClaudeConfigDir(minted)).toBe(true);
      await fs.utimes(minted, new Date(Date.now() - MAX_AGE_MS * 10), new Date(Date.now() - MAX_AGE_MS * 10));

      const mintedRoot = path.dirname(minted);
      const result = await sweepOrphanedIsolatedClaudeConfigDirs({
        rootDir: mintedRoot,
        maxAgeMs: MAX_AGE_MS,
      });

      expect(result.live).toBeGreaterThanOrEqual(1);
      expect((await fs.stat(minted)).isDirectory()).toBe(true);
    } finally {
      releaseIsolatedClaudeConfigDir(minted);
      await fs.rm(minted, { recursive: true, force: true });
    }
    // …and the un-registered aged fixture in another root is still swept, so the
    // test above is not just asserting that nothing is ever removed.
    const other = await sweepOrphanedIsolatedClaudeConfigDirs({ rootDir, maxAgeMs: MAX_AGE_MS });
    expect(other.removed).toBe(1);
    await expect(fs.stat(live)).rejects.toThrow();
  });

  it("sweeps a released directory that was previously live", async () => {
    const minted = await createIsolatedClaudeConfigDir();
    const when = new Date(Date.now() - MAX_AGE_MS * 2);
    await fs.utimes(minted, when, when);
    expect(isLiveIsolatedClaudeConfigDir(minted)).toBe(true);

    releaseIsolatedClaudeConfigDir(minted);

    const result = await sweepOrphanedIsolatedClaudeConfigDirs({ maxAgeMs: MAX_AGE_MS });
    expect(result.removed).toBeGreaterThanOrEqual(1);
    await expect(fs.stat(minted)).rejects.toThrow();
  });

  it("never touches directories outside the per-run naming class", async () => {
    const rootDir = await makeRoot("sweep-scope");
    const foreign = await agedDir(rootDir, "aoa-runtime-hooks-abc", MAX_AGE_MS * 2);
    const alsoForeign = await agedDir(rootDir, "someone-elses-dir", MAX_AGE_MS * 2);
    await fs.writeFile(
      path.join(rootDir, `${ISOLATED_CLAUDE_CONFIG_DIR_PREFIX}not-a-dir`),
      "a FILE with our prefix",
      "utf8",
    );

    const result = await sweepOrphanedIsolatedClaudeConfigDirs({ rootDir, maxAgeMs: MAX_AGE_MS });

    expect(result.removed).toBe(0);
    expect((await fs.stat(foreign)).isDirectory()).toBe(true);
    expect((await fs.stat(alsoForeign)).isDirectory()).toBe(true);
  });

  // Boot must never be blocked or failed by a sweep — an unreadable root is a
  // zero-result, not a throw.
  it("resolves with zeros when the directory cannot be read", async () => {
    const rootDir = path.join(os.tmpdir(), "aoa-t3-does-not-exist-", String(Date.now()));

    await expect(
      sweepOrphanedIsolatedClaudeConfigDirs({ rootDir, maxAgeMs: MAX_AGE_MS }),
    ).resolves.toEqual({ scanned: 0, removed: 0, failed: 0, live: 0 });
  });

  /**
   * …including a root that cannot be RESOLVED. `resolveAoaInstanceRootForAdapter`
   * throws on a malformed `AOA_INSTANCE_ID`, and that resolution used to sit
   * outside the absorbing region — survivable only because the server wrapper
   * catches. The function has to keep its own "never throws" promise, so this
   * asserts it directly rather than through the wrapper.
   */
  it("resolves with zeros when the instance root cannot even be resolved", async () => {
    await expect(
      sweepOrphanedIsolatedClaudeConfigDirs({
        maxAgeMs: MAX_AGE_MS,
        env: { AOA_INSTANCE_ID: "../../etc/not a valid segment" },
      }),
    ).resolves.toEqual({ scanned: 0, removed: 0, failed: 0, live: 0 });
  });

  it("defaults to the same root createIsolatedClaudeConfigDir mints under", async () => {
    // Mint/sweep drift is the failure this guards: a sweep that looks in the
    // wrong place leaves credentials at rest with its own tests fully green.
    const minted = await createIsolatedClaudeConfigDir();
    releaseIsolatedClaudeConfigDir(minted);
    const when = new Date(Date.now() - MAX_AGE_MS * 2);
    await fs.utimes(minted, when, when);

    // No rootDir passed — the default must find it.
    const result = await sweepOrphanedIsolatedClaudeConfigDirs({ maxAgeMs: MAX_AGE_MS });

    expect(result.removed).toBeGreaterThanOrEqual(1);
    await expect(fs.stat(minted)).rejects.toThrow();
  });
});
