/**
 * D18 — crew/Commander autonomy dial split (T2.10, Decision #109 addendum).
 *
 * Before the split ONE column (`internal_agent_config.autonomy_level`) drove
 * Commander, crew task runs, org-agent heartbeat runs AND Adjutant/thread
 * scope-compilation. Phase 1 raised its default to Assist and moved all four at
 * once. D18: "one dial must not secretly drive two systems."
 *
 * THE DISCRIMINATOR this file defends: **moving one dial must not move the
 * other.** A change that merely aliased the two columns (or mirrored writes
 * between them) would satisfy every "crew reads Assist" style assertion, so
 * every test below is written so that an alias FAILS it:
 *
 *   - L3 schema  — the two Drizzle columns are distinct objects mapping to
 *                  distinct SQL names. An alias (`integer("autonomy_level")`
 *                  under both keys) fails `toBe("crew_autonomy_level")`.
 *   - L1 registry — every agent-execution reader names `crewAutonomyLevel` and
 *                  NONE of them names `autonomyLevel`; and the set of files
 *                  still allowed to name `autonomyLevel` is closed, so a NEW
 *                  reader wired to the Commander dial fails here rather than in
 *                  production six months later. A reader can take TWO shapes —
 *                  an explicit column projection, or a whole-row `select()`
 *                  followed by `cfg.autonomyLevel` — and the second is
 *                  invisible to a column-name grep. `agent-loop.ts` already
 *                  uses that second shape and spreads BOTH dials into the
 *                  object handed to `cliService.chat`, so the registry covers
 *                  both: a column-name sweep, a Commander-runtime token sweep,
 *                  and a whole-row-reader sweep.
 *   - L2 route   — a PATCH carrying one dial must not write the other.
 *
 * The real-Postgres proof that the stored values move independently lives in
 * `d18-autonomy-dial-split.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { internalAgentConfig } from "@armyofagents/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(__dirname, "..");

function readServerSource(relPath: string): string {
  return readFileSync(join(SERVER_SRC, relPath), "utf8");
}

/**
 * Every code path that resolves the autonomy an AGENT runs at. Each must read
 * the crew/agent-work dial. Paths are relative to `server/src`.
 *
 * This list is the enumeration from T2.10 step 1. If you add a reader, add it
 * here — the completeness guard below will fail until you do.
 */
const AGENT_EXECUTION_READERS = [
  // crew task runs + crew wakeups
  "services/internal-agent/aoa-agents/dispatcher.ts",
  // org-agent heartbeat runs
  "services/heartbeat.ts",
  // Adjutant scope-compilation
  "services/internal-agent/aoa-agents/controller-adjutant-runner.ts",
  // crew thread participation (@mention answers)
  "services/internal-agent/aoa-agents/thread-participation-runner.ts",
  // scope-draft auto-accept gate (W1b)
  "services/thread-agent-actions.ts",
  // proactive Adjutant wake
  "services/thread-events.ts",
  // phase-advance auto-approve + dispatch
  "services/threads.ts",
  // phase-advance authz gate (mirrors advancePhase)
  "routes/discussions.ts",
] as const;

/**
 * The ONLY files still permitted to name `internalAgentConfig.autonomyLevel`.
 * None of them is an agent-execution reader:
 *   - reconcile-autonomy-scale.ts clamps the legacy 0..3 scale on BOTH columns.
 * (company-portability.ts and routes/internal-agent.ts move the value by plain
 * object key, not by naming the Drizzle column, so they do not appear here.)
 */
const COMMANDER_DIAL_ALLOWLIST = [
  "services/internal-agent/aoa-agents/reconcile-autonomy-scale.ts",
] as const;

/**
 * Files allowed to pull the WHOLE config row AND mention an autonomy level.
 * Both move the value without interpreting it, so neither is a "reader":
 *   - routes/internal-agent.ts — the settings PATCH write path.
 *   - company-portability.ts   — bundle export/import.
 */
const WHOLE_ROW_AUTONOMY_ALLOWLIST = [
  "routes/internal-agent.ts",
  "services/company-portability.ts",
] as const;

/**
 * Commander's runtime surface: everything directly under
 * `services/internal-agent/` plus the provider SDK shims. Deliberately EXCLUDES
 * `aoa-agents/` (crew) and `tools/` (MCP tools shared with crew), both of which
 * legitimately deal in autonomy.
 */
function isCommanderRuntimeFile(rel: string): boolean {
  if (!rel.startsWith("services/internal-agent/")) return false;
  const tail = rel.slice("services/internal-agent/".length);
  return !tail.includes("/") || tail.startsWith("providers/");
}

/** Every non-test TypeScript source under `server/src`, as forward-slash paths. */
async function listServerSources(): Promise<string[]> {
  const { glob } = await import("node:fs/promises");
  const out: string[] = [];
  for await (const entry of glob("**/*.ts", { cwd: SERVER_SRC })) {
    const rel = String(entry).split(sep).join("/");
    if (rel.includes("__tests__/")) continue;
    out.push(rel);
  }
  return out;
}

describe("D18 dial split — L3 schema", () => {
  it("exposes two DISTINCT columns, not one aliased under two keys", () => {
    const commander = internalAgentConfig.autonomyLevel as unknown as { name: string };
    const crew = internalAgentConfig.crewAutonomyLevel as unknown as { name: string };

    // The ablation this kills: `crewAutonomyLevel: integer("autonomy_level")`.
    expect(commander.name).toBe("autonomy_level");
    expect(crew.name).toBe("crew_autonomy_level");
    expect(crew.name).not.toBe(commander.name);
    expect(internalAgentConfig.crewAutonomyLevel).not.toBe(
      internalAgentConfig.autonomyLevel,
    );
  });

  it("the crew dial is NOT NULL and defaults to Assist (1)", () => {
    // Preserves Phase 1's default flip (Decision #109 §8) on the dial that
    // actually governs crew completion — a fresh company's crew must be able to
    // hand a finished task to in_review out of the box.
    const crew = internalAgentConfig.crewAutonomyLevel as unknown as {
      hasDefault: boolean;
      default: unknown;
      notNull: boolean;
    };
    expect(crew.hasDefault).toBe(true);
    expect(crew.default).toBe(1);
    expect(crew.notNull).toBe(true);
  });
});

describe("D18 dial split — L1 reader registry", () => {
  it.each(AGENT_EXECUTION_READERS)(
    "%s resolves autonomy from the crew dial",
    (relPath) => {
      const source = readServerSource(relPath);
      expect(source).toContain("internalAgentConfig.crewAutonomyLevel");
    },
  );

  it.each(AGENT_EXECUTION_READERS)(
    "%s does NOT read Commander's dial",
    (relPath) => {
      const source = readServerSource(relPath);
      expect(source).not.toContain("internalAgentConfig.autonomyLevel");
    },
  );

  it("no OTHER server source reads Commander's dial by column name (closed allowlist)", async () => {
    // Completeness guard, SHAPE 1 of 2: an explicit column projection
    // (`select({ x: internalAgentConfig.autonomyLevel })`). Shape 2 — a
    // whole-row `select()` then `cfg.autonomyLevel` — is invisible to this
    // string and is covered by the two guards below. Both are needed.
    const offenders: string[] = [];
    const allowed = new Set<string>(COMMANDER_DIAL_ALLOWLIST);

    for (const rel of await listServerSources()) {
      const source = readServerSource(rel);
      if (!source.includes("internalAgentConfig.autonomyLevel")) continue;
      if (allowed.has(rel)) continue;
      offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  it("the Commander RUNTIME surface never mentions an autonomy level at all", async () => {
    // Completeness guard, SHAPE 2a. `agent-loop.ts` loads the config with a
    // projection-less `db.select().from(internalAgentConfig)` and spreads the
    // WHOLE row (both dials) into the object handed to `cliService.chat`. So a
    // future `if (config.autonomyLevel >= 2) …` inside cli-mode, a provider, or
    // the approval policy would re-couple Commander to a dial — and would be
    // invisible to the column-name guard above.
    //
    // Decision #109 addendum §12: Commander's gating is the unconditional
    // runtime-approval policy, NOT an integer. This surface therefore has no
    // legitimate use for `autonomyLevel` in any form. (`effectiveAutonomy` is a
    // different, already-resolved value that crew runs pass through cli-mode and
    // mcp-bridge — that token is deliberately NOT matched here.)
    const offenders: string[] = [];

    for (const rel of await listServerSources()) {
      if (!isCommanderRuntimeFile(rel)) continue;
      if (/\bautonomyLevel\b/.test(readServerSource(rel))) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  it("no whole-row config reader touches an autonomy level outside the write/serialize paths", async () => {
    // Completeness guard, SHAPE 2b — the general form of the above, not limited
    // to the Commander directory. Any file that pulls the ENTIRE config row has
    // both dials in scope; if it also mentions `autonomyLevel` it is either a
    // sanctioned write/serialize path or a new coupling that must be reviewed.
    const wholeRowSelect = /\.select\(\s*\)\s*\.from\(internalAgentConfig\)/s;
    const offenders: string[] = [];
    const allowed = new Set<string>(WHOLE_ROW_AUTONOMY_ALLOWLIST);

    for (const rel of await listServerSources()) {
      const source = readServerSource(rel);
      if (!wholeRowSelect.test(source)) continue;
      if (!/\bautonomyLevel\b/.test(source)) continue;
      if (allowed.has(rel)) continue;
      offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  it("the whole-row allowlist is honest — every entry really is a whole-row reader", async () => {
    const wholeRowSelect = /\.select\(\s*\)\s*\.from\(internalAgentConfig\)/s;
    for (const rel of WHOLE_ROW_AUTONOMY_ALLOWLIST) {
      const source = readServerSource(rel);
      expect(wholeRowSelect.test(source), `${rel} is no longer a whole-row reader`).toBe(
        true,
      );
      expect(/\bautonomyLevel\b/.test(source)).toBe(true);
    }
  });

  it("the allowlist itself is honest — every entry really does name the dial", () => {
    // A stale allowlist would silently widen the guard above.
    for (const relPath of COMMANDER_DIAL_ALLOWLIST) {
      expect(readServerSource(relPath)).toContain("internalAgentConfig.autonomyLevel");
    }
  });

  it("keeps the per-thread override intact (crew dial is the company FALLBACK)", () => {
    // `discussions.autonomy_level` is a THIRD, finer-grained dial and it is NOT
    // what D18 split. Every thread flow must still resolve
    // `thread.autonomyLevel ?? company.crewAutonomyLevel` — a split that
    // collapsed the per-thread override would be a behaviour regression.
    //
    // Two shapes appear in the codebase: an explicit column projection
    // (`discussions.autonomyLevel`) and a whole-row select then
    // `thread.autonomyLevel`. Both count.
    for (const relPath of [
      "services/internal-agent/aoa-agents/controller-adjutant-runner.ts",
      "services/internal-agent/aoa-agents/thread-participation-runner.ts",
      "services/thread-agent-actions.ts",
      "services/thread-events.ts",
      "services/threads.ts",
      "routes/discussions.ts",
    ]) {
      const source = readServerSource(relPath);
      const readsThreadOverride =
        source.includes("discussions.autonomyLevel") ||
        source.includes("thread.autonomyLevel");
      expect(readsThreadOverride, `${relPath} lost the per-thread override`).toBe(true);
    }
  });
});

describe("D18 dial split — L2 settings route independence", () => {
  const routeSource = readServerSource("routes/internal-agent.ts");

  it("accepts both dials as independent optional fields", () => {
    expect(routeSource).toContain("autonomyLevel: z.number().int().min(0).max(2).optional()");
    expect(routeSource).toContain(
      "crewAutonomyLevel: z.number().int().min(0).max(2).optional()",
    );
  });

  it("validates the crew dial on its own value, not on the Commander dial", () => {
    // The ablation this kills: `crewAutonomyLevel: req.body.autonomyLevel` style
    // mirroring, or a range check that reads the wrong field.
    expect(routeSource).toContain("req.body.crewAutonomyLevel < 0");
    expect(routeSource).toContain("req.body.crewAutonomyLevel > 2");
  });

  it("never derives one dial from the other", () => {
    // Any assignment of one dial's value into the other re-couples the systems.
    expect(routeSource).not.toMatch(/crewAutonomyLevel:\s*(req\.body\.)?autonomyLevel/);
    expect(routeSource).not.toMatch(/\bautonomyLevel:\s*(req\.body\.)?crewAutonomyLevel/);
  });

  it("passes the request body straight through, so one field cannot write the other", () => {
    // The PATCH handler spreads the validated body into `.set()`. Because zod
    // strips unknown keys and neither field is synthesised, a request carrying
    // only `crewAutonomyLevel` writes only `crew_autonomy_level`.
    expect(routeSource).toContain(".set({ ...req.body, updatedAt: new Date() })");
  });
});

describe("D18 dial split — portability carries both dials", () => {
  const portabilitySource = readServerSource("services/company-portability.ts");

  it("exports the crew dial from its own column", () => {
    expect(portabilitySource).toContain("row.crewAutonomyLevel");
  });

  it("imports pre-split bundles by falling back to the shared value", () => {
    // A pre-split bundle has no `crewAutonomyLevel`; falling back to
    // `autonomyLevel` reproduces exactly the crew behaviour it was exported
    // with. This is the ONLY sanctioned place one dial seeds the other, and it
    // only fires when the new field is absent.
    expect(portabilitySource).toContain(
      "crewAutonomyLevel: cfg.crewAutonomyLevel ?? cfg.autonomyLevel",
    );
  });
});

describe("D18 dial split — startup clamp covers both columns", () => {
  const reconcileSource = readServerSource(
    "services/internal-agent/aoa-agents/reconcile-autonomy-scale.ts",
  );

  it("clamps the crew dial independently of the Commander dial", () => {
    expect(reconcileSource).toContain("gt(internalAgentConfig.autonomyLevel, 2)");
    expect(reconcileSource).toContain("gt(internalAgentConfig.crewAutonomyLevel, 2)");
  });

  it("reports the crew clamp separately so a silent no-op is visible", () => {
    expect(reconcileSource).toContain("crewConfigUpdated");
  });
});

describe("D18 dial split — the enumeration is anchored to real files", () => {
  it("every enumerated reader path exists", () => {
    // Guards against the registry rotting into a list of dead paths, which
    // would make the `it.each` assertions above pass vacuously... they would
    // actually throw on read, but an explicit check names the problem.
    for (const relPath of AGENT_EXECUTION_READERS) {
      const abs = join(SERVER_SRC, relPath);
      expect(relative(SERVER_SRC, abs).split(sep).join("/")).toBe(relPath);
      expect(() => readFileSync(abs, "utf8")).not.toThrow();
    }
  });
});
