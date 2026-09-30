import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "../server/execute.js";
import {
  resolveIsolatedClaudeConfigRoot,
  CLAUDE_SESSION_IDENTITY_UNSET_KEYS,
} from "../server/ambient-config.js";
import type {
  AdapterExecutionContext,
  AdapterProviderSandboxRunInput,
} from "@armyofagents/adapter-utils";

/**
 * D9 — ambient Claude-config isolation, asserted at the SPAWN.
 *
 * A unit test of the env builder cannot prove the spawned child actually got
 * the isolated env, so these tests run a real `claude` stand-in that dumps its
 * OWN `process.env` and assert on that file.
 *
 * Both halves matter:
 *   - crew (`isolateAmbientConfig: true`) — the host's `~/.claude` and the
 *     server's ANTHROPIC_* never reach the child, but PATH/HOME/USERPROFILE do;
 *   - org / heartbeat (flag unset) — ambient env is inherited UNCHANGED. The
 *     opt-in is crew-only; a later task decides whether to expand it.
 */

const AMBIENT_API_KEY = "sk-ant-ambient-server-key";
/** Not enumerated anywhere in the strip list — proves the PREFIX class works. */
const AMBIENT_FUTURE_KNOB = "operator-hooks-and-plugins";
const AMBIENT_HOME = path.join(os.tmpdir(), "operator-home");

/**
 * The parent Claude Code session's identity, as it bleeds into every child spawn
 * when AoA's server is started from inside a Claude Code session (T3c). Each key
 * gets a distinctive ambient value so a test can prove it was the inherited copy
 * that was dropped. These are stripped from EVERY claude_local run — org and crew.
 */
const AMBIENT_SESSION_IDENTITY: Record<string, string> = {
  CLAUDE_CODE_SESSION_ID: "parent-live-session-id",
  CLAUDE_CODE_HOST_SESSION_ID: "parent-host-session-id",
  CLAUDE_CODE_CHILD_SESSION: "1",
  CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
  CLAUDE_CODE_EXECPATH: path.join(os.tmpdir(), "parent", "claude"),
  CLAUDE_PID: "44380",
};

const CREDENTIAL_BODY = JSON.stringify({ claudeAiOauth: { accessToken: "ambient-fixture-token" } });
/**
 * The contamination half of a real operator config home (T3). The full home has
 * 20 entries; these are the ones D9 exists to keep away from a crew agent, and
 * the per-run directory must contain none of them.
 */
const OPERATOR_CONTAMINATION = ["CLAUDE.md", "settings.json", "plugins", "skills", "sessions"];

interface EnvCapture {
  env: Record<string, string | undefined>;
  /**
   * The shim's listing of its OWN `CLAUDE_CONFIG_DIR`, taken at spawn time.
   *
   * Read from the filesystem AFTER `execute` returns would race the `finally`
   * that removes the per-run directory — and would be checking a directory the
   * child may never have seen. This is the only race-free proof of what the
   * spawn was actually handed.
   */
  configDirEntries: string[];
}

/**
 * A `claude` stand-in that emits just enough stream-json for the adapter to
 * parse a clean result, and writes its full inherited env to the capture file.
 * Mirrors execute-target.test.ts' shim (same "agent.js" + .cmd layout).
 */
async function writeEnvDumpingClaude(commandBase: string): Promise<string> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
try { fs.readFileSync(0, "utf8"); } catch { /* stdin may be closed */ }
const capturePath = process.env.AOA_TEST_CAPTURE_PATH;
if (capturePath) {
  // configDirEntries: listed HERE, in the child, because the per-run directory
  // is removed in execute()'s finally — reading it after execute returns would
  // race the cleanup and would not be the child's own view anyway.
  let configDirEntries = [];
  try { configDirEntries = fs.readdirSync(process.env.CLAUDE_CONFIG_DIR).sort(); } catch { /* absent */ }
  fs.writeFileSync(capturePath, JSON.stringify({ env: process.env, configDirEntries }), "utf8");
}
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "claude-session-1",
  result: "ok",
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
  total_cost_usd: 0,
}));
`;
  await fs.writeFile(commandBase + ".js", script, "utf8");
  await fs.chmod(commandBase + ".js", 0o755);

  if (process.platform === "win32") {
    const cmdPath = commandBase + ".cmd";
    await fs.writeFile(cmdPath, `@node "%~dp0agent.js" %*\r\n`, "utf8");
    return cmdPath;
  }
  await fs.writeFile(commandBase, script, "utf8");
  await fs.chmod(commandBase, 0o755);
  return commandBase;
}

async function runClaude(opts: {
  isolateAmbientConfig?: boolean;
  /** Extra agent-configured env, folded into the overlay by buildClaudeRuntimeConfig. */
  configEnv?: Record<string, string>;
  /**
   * Opt out of the clean-exit assertions so a test can inspect a THROWN
   * execute() — T3 refuses to spawn an unauthenticated agent, and that refusal
   * is a throw before the child ever exists (so `capture` is null).
   */
  expectError?: boolean;
}): Promise<{
  capture: EnvCapture | null;
  error: unknown;
  commandNotes: string[];
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-claude-ambient-"));
  const workspace = path.join(root, "workspace");
  const capturePath = path.join(root, "capture.json");
  await fs.mkdir(workspace, { recursive: true });
  const commandPath = await writeEnvDumpingClaude(path.join(root, "agent"));

  const ctx: AdapterExecutionContext = {
    runId: "run-ambient-config",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Scout",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      command: commandPath,
      cwd: workspace,
      env: { AOA_TEST_CAPTURE_PATH: capturePath, ...(opts.configEnv ?? {}) },
      timeoutSec: 20,
      graceSec: 1,
    },
    context: {},
    executionTarget: { type: "local" },
    runtimeCommandSpec: null,
    onLog: async () => {},
    onMeta: async (meta) => {
      commandNotes = meta.commandNotes ?? [];
    },
    ...(opts.isolateAmbientConfig !== undefined
      ? { isolateAmbientConfig: opts.isolateAmbientConfig }
      : {}),
  };

  let commandNotes: string[] = [];
  let error: unknown = null;
  let result: Awaited<ReturnType<typeof execute>> | null = null;
  try {
    result = await execute(ctx);
  } catch (err) {
    error = err;
  }
  if (!opts.expectError) {
    expect(error, "execute should not throw").toBeNull();
    expect(result!.exitCode, "claude stand-in should exit cleanly").toBe(0);
  }
  const capture = await fs
    .readFile(capturePath, "utf8")
    .then((raw) => JSON.parse(raw) as EnvCapture)
    .catch(() => null);
  return { capture, error, commandNotes, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

/** Narrowing helper — every non-error path asserts the child actually ran. */
function requireCapture(capture: EnvCapture | null): EnvCapture {
  expect(capture, "the claude stand-in should have written a capture file").toBeTruthy();
  return capture!;
}

describe("claude ambient-config isolation at the spawn", () => {
  const saved: Record<string, string | undefined> = {};
  /**
   * A REAL operator config home, not just a path: T3 copies the credential out
   * of it, so a bare name would make every crew run here fail
   * credentials-missing. Seeded fresh per test with the credential plus the
   * contamination entries that must never be copied.
   */
  let ambientRoot = "";
  let ambientConfigDir = "";

  beforeEach(async () => {
    ambientRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-ambient-operator-"));
    ambientConfigDir = path.join(ambientRoot, "operator-dot-claude");
    await fs.mkdir(ambientConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(ambientConfigDir, ".credentials.json"),
      CREDENTIAL_BODY,
      "utf8",
    );
    for (const name of OPERATOR_CONTAMINATION) {
      // Half files, half directories — the copy must decline both shapes.
      if (name.includes(".")) await fs.writeFile(path.join(ambientConfigDir, name), "operator", "utf8");
      else await fs.mkdir(path.join(ambientConfigDir, name), { recursive: true });
    }

    const poisoned = {
      CLAUDE_CONFIG_DIR: ambientConfigDir,
      CLAUDE_CODE_OPERATOR_KNOB: AMBIENT_FUTURE_KNOB,
      ANTHROPIC_API_KEY: AMBIENT_API_KEY,
      HOME: AMBIENT_HOME,
      USERPROFILE: AMBIENT_HOME,
      ...AMBIENT_SESSION_IDENTITY,
    };
    for (const [key, value] of Object.entries(poisoned)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });

  afterEach(async () => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await fs.rm(ambientRoot, { recursive: true, force: true });
  });

  it("crew run: strips the host Claude config and pins CLAUDE_CONFIG_DIR per run", async () => {
    const { capture: rawCapture, cleanup } = await runClaude({ isolateAmbientConfig: true });
    const capture = requireCapture(rawCapture);
    try {
      expect(capture.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(capture.env.CLAUDE_CODE_OPERATOR_KNOB).toBeUndefined();
      expect(capture.env.CLAUDE_CONFIG_DIR).toBeTruthy();
      expect(capture.env.CLAUDE_CONFIG_DIR).not.toBe(ambientConfigDir);
      expect(path.basename(capture.env.CLAUDE_CONFIG_DIR!)).toMatch(/^aoa-claude-config-/);
    } finally {
      await cleanup();
    }
  });

  // Pre-T3 the pinned dir is empty, so a crew run can fail login-required while
  // Settings → Providers (which probes the HOST config) says the provider is
  // verified. The note rides onMeta next to the redacted env so the founder can
  // see WHICH config directory the run actually used.
  it("crew run: commandNotes name the isolation and the pinned directory", async () => {
    const { capture: rawCapture, commandNotes, cleanup } = await runClaude({ isolateAmbientConfig: true });
    const capture = requireCapture(rawCapture);
    try {
      const note = commandNotes.find((n) => n.includes("Ambient Claude config isolated"));
      expect(note, "isolation should be visible in onMeta").toBeTruthy();
      expect(note).toContain(capture.env.CLAUDE_CONFIG_DIR!);
    } finally {
      await cleanup();
    }
  });

  it("org/heartbeat run: no isolation note", async () => {
    const { commandNotes, cleanup } = await runClaude({});
    try {
      expect(commandNotes.some((n) => n.includes("Ambient Claude config isolated"))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("crew run: PATH, HOME and USERPROFILE survive the strip", async () => {
    const { capture: rawCapture, cleanup } = await runClaude({ isolateAmbientConfig: true });
    const capture = requireCapture(rawCapture);
    try {
      expect(capture.env.PATH ?? capture.env.Path).toBeTruthy();
      expect(capture.env.HOME).toBe(AMBIENT_HOME);
      expect(capture.env.USERPROFILE).toBe(AMBIENT_HOME);
    } finally {
      await cleanup();
    }
  });

  /**
   * ─────────── T3: per-run config-home provisioning (credentials only) ───────────
   *
   * 🚨 THE ORDERING PROOF. The child sees the credential in its pinned directory
   * ONLY IF the source config home was resolved from the AMBIENT environment
   * BEFORE `CLAUDE_CONFIG_DIR` was pinned to that same (empty) directory. Resolve
   * it after the pin — or from the overlay — and the copy source IS the copy
   * target: nothing is provisioned, the listing below is empty, and this test
   * goes red. That is the inversion this assertion exists to catch, and it is why
   * a unit test of `provisionClaudeConfigHome` alone would not be enough.
   */
  it("crew run: the pinned dir contains the operator's credential and NOTHING else", async () => {
    const { capture: rawCapture, cleanup } = await runClaude({ isolateAmbientConfig: true });
    const capture = requireCapture(rawCapture);
    try {
      // Exactly one entry, taken by the CHILD from its own CLAUDE_CONFIG_DIR.
      expect(capture.configDirEntries).toEqual([".credentials.json"]);
      // …and D9's whole point: none of the contamination came with it.
      for (const name of OPERATOR_CONTAMINATION) {
        expect(capture.configDirEntries, `${name} must not reach a crew run`).not.toContain(name);
      }
    } finally {
      await cleanup();
    }
  });

  it("crew run: commandNotes name the config home the credential came from", async () => {
    const { commandNotes, cleanup } = await runClaude({ isolateAmbientConfig: true });
    try {
      const note = commandNotes.find((n) => n.includes("Claude credentials provisioned"));
      expect(note, "provisioning should be visible in onMeta").toBeTruthy();
      expect(note).toContain(ambientConfigDir);
    } finally {
      await cleanup();
    }
  });

  /**
   * An unauthenticated agent must not run. The refusal happens BEFORE the spawn,
   * and its message is what lands in `internal_agent_runs.errorMessage` and on
   * the crew failure card — so it has to name the path and the remedy.
   */
  it("crew run: refuses to spawn when the operator has no credential file", async () => {
    await fs.rm(path.join(ambientConfigDir, ".credentials.json"), { force: true });

    const { capture, error, cleanup } = await runClaude({
      isolateAmbientConfig: true,
      expectError: true,
    });
    try {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(ambientConfigDir);
      expect((error as Error).message).toContain("claude auth login");
      // Nothing spawned: the shim never wrote a capture file.
      expect(capture, "no child should have been spawned").toBeNull();
    } finally {
      await cleanup();
    }
  });

  /**
   * The reclaim is `execute`'s `finally`, which now opens immediately after
   * `skillsDir` — so EVERY throw reclaims, not just a provisioning failure.
   *
   * Asserts ADDITIONS only. The per-run root is shared with concurrent tests and
   * with `execute`'s own fire-and-forget cleanup, so an equality assertion on the
   * listing would also fail on unrelated REMOVALS — a flake that says "you leaked
   * a credential" when nothing leaked.
   */
  it("crew run: a failed provisioning leaves no per-run directory behind", async () => {
    await fs.rm(path.join(ambientConfigDir, ".credentials.json"), { force: true });
    const perRunRoot = resolveIsolatedClaudeConfigRoot();
    const listPerRunDirs = async (): Promise<string[]> =>
      (await fs.readdir(perRunRoot).catch(() => [] as string[])).filter((n) =>
        n.startsWith("aoa-claude-config-"),
      );
    const before = new Set(await listPerRunDirs());

    const { cleanup } = await runClaude({ isolateAmbientConfig: true, expectError: true });
    try {
      const added = (await listPerRunDirs()).filter((n) => !before.has(n));
      expect(added, "the minted config home must not survive a failed run").toEqual([]);
    } finally {
      await cleanup();
    }
  });

  /**
   * T2's documented escape hatch, re-verified now that a SECOND auth source
   * exists. An operator on Bedrock (or a gateway, or an explicit key) has no
   * `.credentials.json` and never needed one — provisioning must not convert
   * their working configuration into a hard failure.
   */
  it("crew run: env-based auth on adapterConfig.env survives a missing credential file", async () => {
    await fs.rm(path.join(ambientConfigDir, ".credentials.json"), { force: true });

    const { capture: rawCapture, commandNotes, cleanup } = await runClaude({
      isolateAmbientConfig: true,
      configEnv: { CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example" },
    });
    const capture = requireCapture(rawCapture);
    try {
      // It RAN, with the operator's env auth intact and the ambient strip still on.
      expect(capture.env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
      expect(capture.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(capture.configDirEntries).toEqual([]);
      // …and the founder is told why the directory is empty, so an auth failure
      // downstream is not a mystery.
      expect(
        commandNotes.some((n) => n.includes("no Claude credential file")),
        "the empty config home should be explained in onMeta",
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });

  /**
   * …but an explicitly DISABLED switch is not auth. `CLAUDE_CODE_USE_BEDROCK=0`
   * is an operator turning Bedrock off; treating it as configured would suppress
   * the refusal above and hand them the opaque in-CLI failure instead.
   */
  it("crew run: a disabled Bedrock switch does not suppress the refusal", async () => {
    await fs.rm(path.join(ambientConfigDir, ".credentials.json"), { force: true });

    const { error, cleanup } = await runClaude({
      isolateAmbientConfig: true,
      configEnv: { CLAUDE_CODE_USE_BEDROCK: "0" },
      expectError: true,
    });
    try {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("claude auth login");
    } finally {
      await cleanup();
    }
  });

  it("crew run: an agent-configured CLAUDE_CONFIG_DIR is never written into", async () => {
    // Already a real, logged-in config home the operator curates. Copying into it
    // would overwrite their credential with ours; provisioning must skip it.
    const operatorDir = path.join(ambientRoot, "dedicated-claude-home");
    await fs.mkdir(operatorDir, { recursive: true });
    await fs.writeFile(path.join(operatorDir, ".credentials.json"), "DEDICATED", "utf8");
    await fs.writeFile(path.join(operatorDir, "settings.json"), "{}", "utf8");

    const { cleanup } = await runClaude({
      isolateAmbientConfig: true,
      configEnv: { CLAUDE_CONFIG_DIR: operatorDir },
    });
    try {
      expect(await fs.readFile(path.join(operatorDir, ".credentials.json"), "utf8")).toBe(
        "DEDICATED",
      );
      // Untouched entirely — not merely un-clobbered.
      expect((await fs.readdir(operatorDir)).sort()).toEqual([".credentials.json", "settings.json"]);
    } finally {
      await cleanup();
    }
  });

  it("org/heartbeat run: no credential is provisioned and no per-run dir is minted", async () => {
    const { capture: rawCapture, commandNotes, cleanup } = await runClaude({});
    const capture = requireCapture(rawCapture);
    try {
      // The org run reads the operator's real config home directly — provisioning
      // is crew-only, so the listing is the operator's own 6 entries, not ours.
      expect(capture.env.CLAUDE_CONFIG_DIR).toBe(ambientConfigDir);
      expect(capture.configDirEntries).toContain("settings.json");
      expect(commandNotes.some((n) => n.includes("Claude credentials provisioned"))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  // The no-regression proof (D15): org/heartbeat runs never set the isolation
  // flag, so their auth + config env is inherited exactly as before — with the
  // ONE exception carved out by T3c below (the session-identity subset, which is
  // stripped for every claude_local run). Everything that is NOT session identity
  // is unchanged.
  it("org/heartbeat run: inherits ambient Claude config (except session identity)", async () => {
    const { capture: rawCapture, cleanup } = await runClaude({});
    const capture = requireCapture(rawCapture);
    try {
      expect(capture.env.ANTHROPIC_API_KEY).toBe(AMBIENT_API_KEY);
      expect(capture.env.CLAUDE_CONFIG_DIR).toBe(ambientConfigDir);
      expect(capture.env.CLAUDE_CODE_OPERATOR_KNOB).toBe(AMBIENT_FUTURE_KNOB);
      expect(capture.env.HOME).toBe(AMBIENT_HOME);
    } finally {
      await cleanup();
    }
  });

  /**
   * ─────────── T3c: strip the parent session-identity from ORG runs ───────────
   *
   * THE DISCRIMINATOR. An org (non-isolated) claude_local run legitimately
   * inherits the operator's login and config — but NOT the parent Claude Code
   * session's identity, which declares the child a continuation of a specific
   * live session and is the most plausible live-hijack mechanism. This proves the
   * two are separated: the six identity/process keys are dropped while the
   * operator's auth (ANTHROPIC_API_KEY), config directory (CLAUDE_CONFIG_DIR) and
   * every non-identity CLAUDE_CODE_* knob survive.
   */
  it("org/heartbeat run: strips the parent session-identity but KEEPS auth + config", async () => {
    const { capture: rawCapture, cleanup } = await runClaude({});
    const capture = requireCapture(rawCapture);
    try {
      // Every session-identity key the parent leaked is gone…
      for (const key of CLAUDE_SESSION_IDENTITY_UNSET_KEYS) {
        expect(capture.env[key], `${key} must not reach an org run`).toBeUndefined();
      }
      // …while the operator's login and config — the things an org agent works
      // from — are untouched. This is the whole point: kill the hijack input, keep
      // the agent's ability to authenticate.
      expect(capture.env.ANTHROPIC_API_KEY).toBe(AMBIENT_API_KEY);
      expect(capture.env.CLAUDE_CONFIG_DIR).toBe(ambientConfigDir);
      // A non-identity CLAUDE_CODE_* key survives — proving this is an exact-key
      // strip, not a blunt CLAUDE_CODE_ prefix that would also drop config/auth.
      expect(capture.env.CLAUDE_CODE_OPERATOR_KNOB).toBe(AMBIENT_FUTURE_KNOB);
    } finally {
      await cleanup();
    }
  });

  /**
   * Crew already strips the whole CLAUDE_/ANTHROPIC_ prefix, so the identity keys
   * are gone there too — asserted here as a regression guard so a future change to
   * the crew prefix strip cannot silently reopen the hijack input for crew runs.
   */
  it("crew run: the parent session-identity is also stripped (via the prefix strip)", async () => {
    const { capture: rawCapture, cleanup } = await runClaude({ isolateAmbientConfig: true });
    const capture = requireCapture(rawCapture);
    try {
      for (const key of CLAUDE_SESSION_IDENTITY_UNSET_KEYS) {
        expect(capture.env[key], `${key} must not reach a crew run`).toBeUndefined();
      }
    } finally {
      await cleanup();
    }
  });

  /**
   * `mergeChildEnv`'s overlay-wins rule: an agent that EXPLICITLY sets a
   * session-identity key on adapterConfig.env keeps its own value — only the
   * AMBIENT inherited copy is dropped. Deliberate: an operator's explicit choice
   * is honored; the host machine's accidental bleed is not.
   */
  it("org/heartbeat run: an agent-set session-identity key survives (overlay wins)", async () => {
    const { capture: rawCapture, cleanup } = await runClaude({
      configEnv: { CLAUDE_CODE_ENTRYPOINT: "aoa-agent" },
    });
    const capture = requireCapture(rawCapture);
    try {
      // The agent's own value wins over both the ambient value and the strip.
      expect(capture.env.CLAUDE_CODE_ENTRYPOINT).toBe("aoa-agent");
      // …but the keys the agent did NOT override are still dropped.
      expect(capture.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  // The pin exists so the CLI reads config from somewhere the operator's
  // ~/.claude cannot reach. An operator who ALREADY has a dedicated, logged-in
  // config home must be able to point crew at it — that is the only pre-T3
  // escape hatch, and every other provider-auth variable set this way survives.
  it("crew run: an agent-configured CLAUDE_CONFIG_DIR wins over the per-run pin", async () => {
    const operatorDir = path.join(os.tmpdir(), "aoa-crew-dedicated-claude-home");
    const { capture: rawCapture, cleanup } = await runClaude({
      isolateAmbientConfig: true,
      configEnv: { CLAUDE_CONFIG_DIR: operatorDir },
    });
    const capture = requireCapture(rawCapture);
    try {
      expect(capture.env.CLAUDE_CONFIG_DIR).toBe(operatorDir);
      // Still isolated: the configured dir is an OVERLAY key, so the ambient
      // CLAUDE_*/ANTHROPIC_* strip is unaffected by honoring it.
      expect(capture.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(capture.env.CLAUDE_CODE_OPERATOR_KNOB).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("crew run: the note marks an agent-configured directory as the operator's", async () => {
    const operatorDir = path.join(os.tmpdir(), "aoa-crew-dedicated-claude-home");
    const { commandNotes, cleanup } = await runClaude({
      isolateAmbientConfig: true,
      configEnv: { CLAUDE_CONFIG_DIR: operatorDir },
    });
    try {
      const note = commandNotes.find((n) => n.includes("Ambient Claude config isolated"));
      expect(note).toContain(operatorDir);
      // Without this the note reads as "AoA overrode my setting".
      expect(note).toContain("(agent-configured)");
    } finally {
      await cleanup();
    }
  });

  /**
   * Windows env names are case-insensitive, so `Claude_Config_Dir` in
   * adapterConfig.env IS `CLAUDE_CONFIG_DIR`. Missing that spelling would mint a
   * per-run dir alongside it, leaving the overlay carrying two spellings of ONE
   * variable with different values — both surviving the strip, since both are
   * overlay keys. On POSIX the two ARE distinct variables, so minting is correct
   * there; the assertion follows the platform rather than asserting one answer.
   */
  it("crew run: a differently-cased agent-configured dir is honored on Windows", async () => {
    const operatorDir = path.join(os.tmpdir(), "aoa-crew-oddcase-claude-home");
    const { capture: rawCapture, cleanup } = await runClaude({
      isolateAmbientConfig: true,
      configEnv: { Claude_Config_Dir: operatorDir },
    });
    const capture = requireCapture(rawCapture);
    try {
      const seen = Object.entries(capture.env)
        .filter(([key]) => key.toLowerCase() === "claude_config_dir")
        .map(([, value]) => value)
        .filter((value): value is string => value !== undefined);
      if (process.platform === "win32") {
        // One logical variable ⇒ exactly one value, and it is the operator's.
        expect(new Set(seen)).toEqual(new Set([operatorDir]));
      } else {
        // Distinct variables: the operator's survives AND a per-run dir is minted.
        expect(seen).toContain(operatorDir);
        expect(seen.some((v) => path.basename(v).startsWith("aoa-claude-config-"))).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });

  it("org/heartbeat run: an explicit false is also inert", async () => {
    const { capture: rawCapture, cleanup } = await runClaude({ isolateAmbientConfig: false });
    const capture = requireCapture(rawCapture);
    try {
      expect(capture.env.ANTHROPIC_API_KEY).toBe(AMBIENT_API_KEY);
      expect(capture.env.CLAUDE_CONFIG_DIR).toBe(ambientConfigDir);
    } finally {
      await cleanup();
    }
  });

  /**
   * Remote targets are isolated by construction — the child runs in a container
   * or provider sandbox and never sees the host env, so the strip is moot there.
   * Pinning a HOST `os.tmpdir()` path into that child is worse than useless: on a
   * Windows host it forwards a `C:\…` path into a Linux container, and it
   * overrides the managed `HOME` (the runtime root) that is exactly how the CLI
   * would find a correct in-container `~/.claude`.
   */
  it("remote crew run: no per-run pin, and the managed HOME survives", async () => {
    const providerInputs: AdapterProviderSandboxRunInput[] = [];
    const providerRunner = {
      execute: vi.fn(async (input: AdapterProviderSandboxRunInput) => {
        providerInputs.push(input);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stderr: "",
          stdout: JSON.stringify({
            type: "result",
            subtype: "success",
            session_id: "claude-session-1",
            result: "ok",
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
            total_cost_usd: 0,
          }),
        };
      }),
    };

    const result = await execute({
      runId: "run-remote-crew",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Scout",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "claude", env: {}, timeoutSec: 10, graceSec: 1 },
      context: {},
      executionTarget: {
        type: "provider-sandbox",
        provider: "e2b",
        providerLeaseId: "sandbox-1",
        remoteCwd: "/home/user/aoa-workspace",
        shell: "bash",
        runner: providerRunner,
      },
      runtimeCommandSpec: null,
      isolateAmbientConfig: true,
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(0);
    const runInput = providerInputs.find((input) => input.args.includes("--print"));
    expect(runInput).toBeDefined();
    expect(runInput!.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(runInput!.env.HOME).toBe("/home/user/aoa-workspace/.aoa-runtime/claude");
  });
});
