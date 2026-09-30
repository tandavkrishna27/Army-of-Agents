import { describe, expect, it, vi } from "vitest";

// Mock @armyofagents/db and drizzle-orm before importing the tool (dynamic imports inside execute)
vi.mock("@armyofagents/db", () => ({
  companySkills: new Proxy({}, {
    get: (_t, k) => `companySkills.${String(k)}`,
  }),
  agents: new Proxy({}, {
    get: (_t, k) => `agents.${String(k)}`,
  }),
  internalAgentConfig: new Proxy({}, {
    get: (_t, k) => `internalAgentConfig.${String(k)}`,
  }),
}));

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
}));

import { useSkillTool } from "../services/internal-agent/tools/skill-tools.js";
import { COMMANDER_SKILL_PREAMBLE } from "../services/internal-agent/commander-preamble.js";

/**
 * Build a mock DB context for use_skill tests.
 *
 * Fix B changed the fetch from a single exact-match `.where(...).limit(1)` to
 * a "fetch all, filter in JS" pattern: `.where(eq(companySkills.companyId, ...))`.
 * That first query has no `.limit()` call; the result is awaited directly from
 * the `.where()` return value.  The mock therefore exposes a thenable from
 * `.where()` (for the fetch-all query) while also preserving `.limit()` on it
 * (for any downstream commander-enforcement queries that do call `.limit()`).
 */
function makeCtx(selectResult: any[]) {
  const whereResult = {
    // Thenable: the fetch-all path awaits `.where()` directly
    then: (resolve: (v: any) => any) => Promise.resolve(selectResult).then(resolve),
    catch: (reject: (e: any) => any) => Promise.resolve(selectResult).catch(reject),
    // limit() support: enforcement path calls .limit(1)
    limit: async (_n: number) => selectResult,
  };
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => whereResult,
        }),
      }),
    },
    companyId: "comp-1",
    userId: "user-1",
    userRole: "team_member",
  } as any;
}

describe("useSkillTool.execute", () => {
  it("returns success with key, name, content when skill is found", async () => {
    const skill = {
      key: "brainstorming",
      name: "Brainstorming",
      description: "Before building new features",
      markdown: "# Brainstorming\nUse this before any build.",
    };
    const ctx = makeCtx([skill]);
    const result = await useSkillTool.execute({ key: "brainstorming" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      key: "brainstorming",
      name: "Brainstorming",
      content: `${COMMANDER_SKILL_PREAMBLE}\n\n---\n\n# Brainstorming\nUse this before any build.`,
    });
  });

  it("returns INVALID_PARAMS when key is undefined", async () => {
    const ctx = makeCtx([]);
    const result = await useSkillTool.execute({} as any, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("returns INVALID_PARAMS when key is empty string", async () => {
    const ctx = makeCtx([]);
    const result = await useSkillTool.execute({ key: "" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("returns NOT_FOUND when DB query returns empty array", async () => {
    const ctx = makeCtx([]);
    const result = await useSkillTool.execute({ key: "nonexistent-skill" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_FOUND");
  });

  it("returns INTERNAL when DB throws", async () => {
    const ctx = {
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => {
                throw new Error("Connection refused");
              },
            }),
          }),
        }),
      },
      companyId: "comp-1",
      userId: "user-1",
      userRole: "team_member",
    } as any;
    const result = await useSkillTool.execute({ key: "brainstorming" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("INTERNAL");
  });

  it("summary includes the skill name when skill is found", async () => {
    const skill = {
      key: "review",
      name: "Code Review",
      description: null,
      markdown: "# Review\nDo reviews.",
    };
    const ctx = makeCtx([skill]);
    const result = await useSkillTool.execute({ key: "review" }, ctx);
    expect(result.success).toBe(true);
    expect(result.summary).toContain("Code Review");
  });

  it("prepends the shared preamble to the returned skill content", async () => {
    const skill = {
      key: "brainstorming", name: "Brainstorming",
      description: "x", markdown: "# Brainstorming\nBody text here.",
    };
    const ctx = makeCtx([skill]);
    const result = await useSkillTool.execute({ key: "brainstorming" }, ctx);
    expect(result.success).toBe(true);
    const content = (result.data as { content: string }).content;
    expect(content).toContain(COMMANDER_SKILL_PREAMBLE);
    expect(content).toContain("# Brainstorming"); // original body preserved
    // preamble precedes the body
    expect(content.indexOf(COMMANDER_SKILL_PREAMBLE)).toBeLessThan(content.indexOf("# Brainstorming"));
  });

  it("resolves a curated-form key (skill:aoa-curated/aoa-<name>) against a skill stored under the runtime form (skill:aoa/<name>)", async () => {
    const skill = {
      key: "skill:aoa/sprint-planning",
      name: "Sprint Planning",
      description: "Plan the sprint",
      markdown: "# Sprint Planning\nBody text here.",
    };
    const ctx = makeCtx([skill]);
    const result = await useSkillTool.execute(
      { key: "skill:aoa-curated/aoa-sprint-planning" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect((result.data as { key: string }).key).toBe("skill:aoa/sprint-planning");
  });

  it("resolves a runtime-form key (skill:aoa/<name>) against a skill stored under the curated form (skill:aoa-curated/aoa-<name>)", async () => {
    const skill = {
      key: "skill:aoa-curated/aoa-sprint-planning",
      name: "Sprint Planning",
      description: "Plan the sprint",
      markdown: "# Sprint Planning\nBody text here.",
    };
    const ctx = makeCtx([skill]);
    const result = await useSkillTool.execute(
      { key: "skill:aoa/sprint-planning" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect((result.data as { key: string }).key).toBe("skill:aoa-curated/aoa-sprint-planning");
  });
});
