import { describe, expect, it } from "vitest";
import { vi } from "vitest";

// Mock @armyofagents/db and drizzle-orm before importing the tool (the tool uses
// dynamic imports inside execute). We keep the three tables as identity-stable
// Proxies so the mock DB can branch on WHICH table `.from(...)` was handed.
vi.mock("@armyofagents/db", () => ({
  companySkills: new Proxy({}, { get: (_t, k) => `companySkills.${String(k)}` }),
  agents: new Proxy({}, { get: (_t, k) => `agents.${String(k)}` }),
  internalAgentConfig: new Proxy({}, { get: (_t, k) => `internalAgentConfig.${String(k)}` }),
}));

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
}));

import { useSkillTool } from "../services/internal-agent/tools/skill-tools.js";
// Same mocked module instances the tool resolves via `await import(...)`, so we
// can branch the mock DB on reference identity.
import { companySkills, agents, internalAgentConfig } from "@armyofagents/db";
import { buildMcpBridgeSpec } from "../services/internal-agent/cli-mode.js";

const SKILL_KEY = "skill:aoa/design-review";

const SKILL_ROW = {
  key: SKILL_KEY,
  slug: "design-review",
  name: "Design Review",
  description: "Review the design",
  markdown: "# Design Review\nBody.",
};

type AgentRow = { companyId: string; skillKeys: string[] };

function thenable<T>(v: T) {
  return {
    then: (res: (x: T) => any) => Promise.resolve(v).then(res),
    catch: (rej: (e: any) => any) => Promise.resolve(v).catch(rej),
    limit: async () => v,
  };
}

// Recursively collect every {eq:[field,value]} leaf from an and()/eq() condition.
function flattenEqs(cond: any): Array<[string, any]> {
  if (!cond || typeof cond !== "object") return [];
  if (Array.isArray(cond.eq)) return [[String(cond.eq[0]), cond.eq[1]]];
  if (Array.isArray(cond.and)) return cond.and.flatMap(flattenEqs);
  return [];
}

/**
 * Table-aware mock DB. Branches on the actual table object handed to `.from()`:
 *  - companySkills  → the full company skill list (awaited directly / .limit)
 *  - internalAgentConfig → [{ agentId }] when configured
 *  - agents → resolves the row by the WHERE condition, HONOURING any companyId
 *             conjunct (this is what makes cross-company denial real).
 */
function makeDb(opts: {
  skills?: any[];
  agentsById?: Record<string, AgentRow>;
  configAgentId?: string | null;
}) {
  const skills = opts.skills ?? [SKILL_ROW];
  const agentsById = opts.agentsById ?? {};
  return {
    select: (_proj?: any) => ({
      from: (table: any) => ({
        where: (cond: any) => {
          if (table === companySkills) {
            return thenable(skills);
          }
          if (table === internalAgentConfig) {
            return {
              limit: async () =>
                opts.configAgentId ? [{ agentId: opts.configAgentId }] : [],
            };
          }
          if (table === agents) {
            const eqs = flattenEqs(cond);
            const wantId = eqs.find(([f]) => f.endsWith(".id"))?.[1];
            const companyPair = eqs.find(([f]) => f.endsWith(".companyId"));
            const wantCompany = companyPair ? companyPair[1] : undefined;
            return {
              limit: async () => {
                const agent = wantId ? agentsById[wantId as string] : undefined;
                if (!agent) return [];
                // If the query company-scopes (crew), a mismatch returns NOTHING —
                // the skillKeys are never read.
                if (wantCompany !== undefined && agent.companyId !== wantCompany) {
                  return [];
                }
                return [{ skillKeys: agent.skillKeys }];
              },
            };
          }
          return { limit: async () => [] };
        },
      }),
    }),
  } as any;
}

function ctx(over: Record<string, unknown>, db: any) {
  return {
    db,
    companyId: "comp-1",
    userId: "user-1",
    userRole: "team_member",
    ...over,
  } as any;
}

describe("use_skill crew skillKeys enforcement", () => {
  // (a) DENY — crew agent asks for a skill NOT in its skillKeys.
  it("DENIES a crew agent (actor=agent, kind=aoa) a resolvable skill not in its skillKeys", async () => {
    const db = makeDb({
      agentsById: { "crew-1": { companyId: "comp-1", skillKeys: ["skill:aoa/other"] } },
    });
    const result = await useSkillTool.execute(
      { key: SKILL_KEY },
      ctx({ actorType: "agent", agentKind: "aoa", agentId: "crew-1" }, db),
    );
    expect(result.success).toBe(false);
    // Discriminator: the skill EXISTS/RESOLVES — the denial is the allowlist, not NOT_FOUND.
    expect(result.error).toBe("NOT_ENABLED");
    expect(result.error).not.toBe("NOT_FOUND");
    // Crew-appropriate copy points at the Agent Skills tab, not Commander settings.
    expect(result.summary).not.toContain("Commander");
    expect(result.summary).toMatch(/Skills tab|Agent/i);
  });

  // (b) ALLOW — same crew agent, skill IS in its skillKeys.
  it("ALLOWS a crew agent a skill that IS in its skillKeys", async () => {
    const db = makeDb({
      agentsById: { "crew-1": { companyId: "comp-1", skillKeys: [SKILL_KEY] } },
    });
    const result = await useSkillTool.execute(
      { key: SKILL_KEY },
      ctx({ actorType: "agent", agentKind: "aoa", agentId: "crew-1" }, db),
    );
    expect(result.success).toBe(true);
    expect((result.data as { key: string }).key).toBe(SKILL_KEY);
  });

  // (d) CROSS-COMPANY — ctx.agentId names an agent in a DIFFERENT company. The
  // foreign agent's skillKeys DOES contain the skill, so absent company scoping
  // this would leak. Company scoping must deny it.
  it("DENIES a crew run whose agentId belongs to another company, even when that agent lists the skill", async () => {
    const db = makeDb({
      // Skill exists in the CALLER's company (comp-1), so it resolves.
      skills: [SKILL_ROW],
      agentsById: {
        // Foreign agent (comp-2) lists the very skill being requested.
        foreign: { companyId: "comp-2", skillKeys: [SKILL_KEY] },
      },
    });
    const result = await useSkillTool.execute(
      { key: SKILL_KEY },
      // caller company is comp-1; the env-supplied agentId points at a comp-2 agent
      ctx({ actorType: "agent", agentKind: "aoa", agentId: "foreign", companyId: "comp-1" }, db),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_ENABLED");
  });

  // (e) EMPTY skillKeys — the D17 Phase-1 default. Every skill denied.
  it("DENIES a crew agent with empty skillKeys (D17 default: no skills attached)", async () => {
    const db = makeDb({
      agentsById: { "crew-1": { companyId: "comp-1", skillKeys: [] } },
    });
    const result = await useSkillTool.execute(
      { key: SKILL_KEY },
      ctx({ actorType: "agent", agentKind: "aoa", agentId: "crew-1" }, db),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_ENABLED");
  });

  // FAIL-CLOSED: a crew actor (kind=aoa) with a MISSING/EMPTY agentId is an
  // env/caller defect — the weakest, most suspicious input — and must be DENIED,
  // never fall through to the unconditional allow. Mirrors authorize-tool.ts:67
  // (keys on kind, fails closed on bad identity).
  it.each([
    ["undefined agentId", undefined],
    ["empty-string agentId", ""],
  ])("DENIES a crew actor (kind=aoa) with %s (identity cannot be verified)", async (_label, agentId) => {
    // skillKeys would ALLOW the skill if the crack let a resolve happen — proving
    // the denial is the identity guard, not an empty allowlist.
    const db = makeDb({
      agentsById: { "": { companyId: "comp-1", skillKeys: [SKILL_KEY] } },
    });
    const result = await useSkillTool.execute(
      { key: SKILL_KEY },
      ctx({ actorType: "agent", agentKind: "aoa", agentId }, db),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_ENABLED");
    expect(result.summary).toMatch(/identity could not be verified/i);
  });

  // Scope guard: org agents (actor=agent, kind!="aoa") are NOT newly gated by
  // this task. An org agent with empty skillKeys must still resolve the skill.
  it("does NOT gate a non-crew agent actor (kind=org) — org stays ungated", async () => {
    const db = makeDb({
      agentsById: { "org-1": { companyId: "comp-1", skillKeys: [] } },
    });
    const result = await useSkillTool.execute(
      { key: SKILL_KEY },
      ctx({ actorType: "agent", agentKind: "org", agentId: "org-1" }, db),
    );
    expect(result.success).toBe(true);
    expect((result.data as { key: string }).key).toBe(SKILL_KEY);
  });
});

describe("use_skill Commander enforcement stays intact (NO ctx.agentId — resolves via internalAgentConfig)", () => {
  // (c) Commander allow — resolves the agent via internalAgentConfig.agentId.
  it("ALLOWS Commander a listed skill, resolving agentId via internalAgentConfig (no ctx.agentId)", async () => {
    const db = makeDb({
      configAgentId: "cmdr-agent",
      agentsById: { "cmdr-agent": { companyId: "comp-1", skillKeys: [SKILL_KEY] } },
    });
    const result = await useSkillTool.execute(
      { key: SKILL_KEY },
      ctx({ actorType: "commander" }, db), // deliberately NO agentId
    );
    expect(result.success).toBe(true);
    expect((result.data as { key: string }).key).toBe(SKILL_KEY);
  });

  // (c) Commander deny — listed skillKeys excludes the skill.
  it("DENIES Commander a skill not in its skillKeys, with Commander-specific copy", async () => {
    const db = makeDb({
      configAgentId: "cmdr-agent",
      agentsById: { "cmdr-agent": { companyId: "comp-1", skillKeys: ["skill:aoa/other"] } },
    });
    const result = await useSkillTool.execute(
      { key: SKILL_KEY },
      ctx({ actorType: "commander" }, db),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_ENABLED");
    // Regression guard: Commander copy stays Commander-flavoured.
    expect(result.summary).toContain("Commander");
  });

  // Commander with no configured agentId → enforcement is skipped (unchanged legacy behaviour).
  it("does not enforce when no Commander agent is configured (cfg.agentId absent)", async () => {
    const db = makeDb({ configAgentId: null });
    const result = await useSkillTool.execute(
      { key: SKILL_KEY },
      ctx({ actorType: "commander" }, db),
    );
    expect(result.success).toBe(true);
  });
});

// ── Step 5: bridge-level test ────────────────────────────────────────────────
//
// Drive use_skill through the identity the REAL bridge supplies. We build the
// bridge env with buildMcpBridgeSpec (the canonical env producer used by the
// crew runner), then derive ctx.actorType/agentKind/agentId from that env
// EXACTLY as mcp-bridge.ts main() does, and run the tool with that ctx. This
// proves enforcement keys on the identity the bridge actually emits — not a
// hand-authored ctx. (A full subprocess spawn needs a live DB; deriving ctx
// from the real env mapping is the closest deterministic harness.)
describe("use_skill enforcement keyed on REAL bridge-supplied identity", () => {
  // Mirrors mcp-bridge.ts main(): actorType default "board", kind/id from env.
  function ctxFromBridgeEnv(env: Record<string, string>, db: any) {
    return {
      db,
      companyId: env.AOA_SESSION_COMPANY_ID,
      userId: env.AOA_SESSION_USER_ID,
      userRole: env.AOA_SESSION_USER_ROLE,
      agentKind: env.AOA_AGENT_KIND || undefined,
      actorType: env.AOA_ACTOR_TYPE ?? "board",
      agentId: env.AOA_AGENT_ID || undefined,
    } as any;
  }

  // The crew runner's mcpParams shape (runner.ts): actorType "agent", kind "aoa".
  const crewParams = {
    companyId: "comp-1",
    userId: "sub-user",
    userRole: "team_member",
    enabledCapabilities: [],
    bridgeEntrypoint: "/bridge.js",
    agentKind: "aoa",
    actorType: "agent",
    agentId: "crew-1",
  } as const;

  it("DENIES via the bridge-derived crew identity when the skill is not attached", async () => {
    const { env } = buildMcpBridgeSpec(crewParams);
    // Sanity: the real mapping emitted the crew identity we enforce on.
    expect(env.AOA_ACTOR_TYPE).toBe("agent");
    expect(env.AOA_AGENT_KIND).toBe("aoa");
    expect(env.AOA_AGENT_ID).toBe("crew-1");

    const db = makeDb({
      agentsById: { "crew-1": { companyId: "comp-1", skillKeys: ["skill:aoa/other"] } },
    });
    const result = await useSkillTool.execute({ key: SKILL_KEY }, ctxFromBridgeEnv(env, db));
    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_ENABLED");
  });

  it("ALLOWS via the bridge-derived crew identity when the skill IS attached", async () => {
    const { env } = buildMcpBridgeSpec(crewParams);
    const db = makeDb({
      agentsById: { "crew-1": { companyId: "comp-1", skillKeys: [SKILL_KEY] } },
    });
    const result = await useSkillTool.execute({ key: SKILL_KEY }, ctxFromBridgeEnv(env, db));
    expect(result.success).toBe(true);
    expect((result.data as { key: string }).key).toBe(SKILL_KEY);
  });
});
