import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  agents: makeTableProxy("agents"),
  agentProjects: makeTableProxy("agent_projects"),
  memoryItems: makeTableProxy("memory_items"),
}));

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { buildPinnedMemorySkillEntries, renderPinnedSkillMarkdown } from "../services/memory-skill-sync.js";

type Row = Record<string, unknown>;

/**
 * Sequence-based mock db. Each `db.select()` call consumes the next
 * pre-configured result array. The sync's queries fire in this order:
 *   1. agents (runtimeConfig)
 *   2. agentProjects (only when inheritFromDepartment)
 *   3. memoryItems WHERE pinnedToSkill (baseline, only when inheriting)
 *   4. memoryItems WHERE id IN additions (only when additions non-empty)
 */
function makeMockDb(selects: Row[][]) {
  let idx = 0;
  const buildChain = (getResult: () => Row[]) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy", "limit", "innerJoin", "leftJoin"]) {
      (chain as Record<string, () => unknown>)[m] = () => chain;
    }
    (chain as { then: (r: (rows: Row[]) => unknown) => Promise<unknown> }).then = (
      resolve: (rows: Row[]) => unknown,
    ) => Promise.resolve(resolve(getResult()));
    return chain;
  };

  return {
    select: () => buildChain(() => selects[idx++] ?? []),
  } as unknown as Parameters<typeof buildPinnedMemorySkillEntries>[0];
}

function memoryRow(overrides: Partial<Row> = {}): Row {
  return {
    id: overrides.id ?? "mem-1",
    title: "Brand voice",
    content: "Casual, direct, second person.",
    category: "preference",
    layer: "domain",
    departmentId: null,
    ...overrides,
  };
}

describe("buildPinnedMemorySkillEntries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns [] when agent does not exist", async () => {
    const db = makeMockDb([
      [], // agents lookup empty
    ]);

    const result = await buildPinnedMemorySkillEntries(db, "co-1", "agent-missing");

    expect(result).toEqual([]);
  });

  it("returns [] when no pinned items exist for the agent's scope", async () => {
    const db = makeMockDb([
      [{ runtimeConfig: {} }],  // agent (default profile = inherit)
      [],                         // agentProjects (no projects)
      [],                         // memoryItems (none pinned)
      // additions query skipped — additions is empty by default
    ]);

    const result = await buildPinnedMemorySkillEntries(db, "co-1", "agent-1");

    expect(result).toEqual([]);
  });

  it("inherits pinned items from agent's department by default", async () => {
    const db = makeMockDb([
      [{ runtimeConfig: {} }],                               // agent
      [{ projectId: "dept-marketing" }],                     // agentProjects
      [memoryRow({ id: "p1", title: "Brand voice", category: "preference" })], // baseline
    ]);

    const result = await buildPinnedMemorySkillEntries(db, "co-1", "agent-1");

    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("company-knowledge");
    expect(result[0].name).toBe("Company Knowledge");
    expect(result[0].markdown).toContain("Brand voice");
    expect(result[0].markdown).toContain("Casual, direct, second person.");
    expect(result[0].trustLevel).toBe("trusted");
  });

  it("skips department lookup when inheritFromDepartment=false", async () => {
    const db = makeMockDb([
      [
        {
          runtimeConfig: {
            memoryProfile: {
              pinnedSkillItems: { inheritFromDepartment: false, additions: [], removals: [] },
            },
          },
        },
      ],
      // No agentProjects query — skipped
      // No baseline query — skipped
      // No additions query — empty additions
    ]);

    const result = await buildPinnedMemorySkillEntries(db, "co-1", "agent-1");

    // Empty result because no inheritance and no additions
    expect(result).toEqual([]);
  });

  it("merges baseline + additions", async () => {
    const db = makeMockDb([
      [
        {
          runtimeConfig: {
            memoryProfile: {
              pinnedSkillItems: {
                inheritFromDepartment: true,
                additions: ["extra-1"],
                removals: [],
              },
            },
          },
        },
      ],
      [{ projectId: "dept-marketing" }],
      [memoryRow({ id: "base-1", title: "Brand voice" })],
      [memoryRow({ id: "extra-1", title: "Email subject conventions" })],
    ]);

    const result = await buildPinnedMemorySkillEntries(db, "co-1", "agent-1");

    expect(result).toHaveLength(1);
    expect(result[0].markdown).toContain("Brand voice");
    expect(result[0].markdown).toContain("Email subject conventions");
  });

  it("removes items in the removals list, even if present in baseline", async () => {
    const db = makeMockDb([
      [
        {
          runtimeConfig: {
            memoryProfile: {
              pinnedSkillItems: {
                inheritFromDepartment: true,
                additions: [],
                removals: ["base-2"],
              },
            },
          },
        },
      ],
      [{ projectId: "dept-marketing" }],
      [
        memoryRow({ id: "base-1", title: "Keep me" }),
        memoryRow({ id: "base-2", title: "Remove me" }),
      ],
    ]);

    const result = await buildPinnedMemorySkillEntries(db, "co-1", "agent-1");

    expect(result).toHaveLength(1);
    expect(result[0].markdown).toContain("Keep me");
    expect(result[0].markdown).not.toContain("Remove me");
  });

  it("dedups items appearing in both baseline and additions", async () => {
    const db = makeMockDb([
      [
        {
          runtimeConfig: {
            memoryProfile: {
              pinnedSkillItems: {
                inheritFromDepartment: true,
                additions: ["dup-1"],
                removals: [],
              },
            },
          },
        },
      ],
      [{ projectId: "dept-marketing" }],
      [memoryRow({ id: "dup-1", title: "Shared item" })],
      [memoryRow({ id: "dup-1", title: "Shared item" })], // also in additions
    ]);

    const result = await buildPinnedMemorySkillEntries(db, "co-1", "agent-1");

    // Item should appear ONCE in markdown, not twice
    const occurrences = (result[0].markdown.match(/Shared item/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("tolerates missing/partial memoryProfile (uses defaults)", async () => {
    const db = makeMockDb([
      [{ runtimeConfig: { someOtherSetting: true } }],  // no memoryProfile field
      [{ projectId: "dept-marketing" }],                 // still queries projects (default = inherit)
      [memoryRow({ id: "p1", title: "Default-inherit works" })],
    ]);

    const result = await buildPinnedMemorySkillEntries(db, "co-1", "agent-1");

    expect(result).toHaveLength(1);
    expect(result[0].markdown).toContain("Default-inherit works");
  });
});

describe("renderPinnedSkillMarkdown", () => {
  it("includes YAML frontmatter so CLI skill-discovery picks it up", () => {
    const md = renderPinnedSkillMarkdown([
      {
        id: "1",
        title: "X",
        content: "Y",
        category: "preference",
        layer: "domain",
        departmentId: null,
      },
    ]);

    expect(md).toMatch(/^---\nname: company-knowledge\n/);
    expect(md).toContain("description:");
  });

  it("groups items by category with stable ordering", () => {
    const items = [
      { id: "1", title: "Z item", content: "z", category: "reference", layer: null, departmentId: null },
      { id: "2", title: "A item", content: "a", category: "preference", layer: null, departmentId: null },
      { id: "3", title: "Q decision", content: "q", category: "decision", layer: null, departmentId: null },
    ];

    const md = renderPinnedSkillMarkdown(items);

    // Categories appear in the priority order: decision, preference, reference
    const decisionIdx = md.indexOf("## Decision");
    const preferenceIdx = md.indexOf("## Preference");
    const referenceIdx = md.indexOf("## Reference");
    expect(decisionIdx).toBeGreaterThan(0);
    expect(preferenceIdx).toBeGreaterThan(decisionIdx);
    expect(referenceIdx).toBeGreaterThan(preferenceIdx);
  });

  it("sorts items alphabetically within a category", () => {
    const items = [
      { id: "1", title: "Z item", content: "z", category: "preference", layer: null, departmentId: null },
      { id: "2", title: "A item", content: "a", category: "preference", layer: null, departmentId: null },
      { id: "3", title: "M item", content: "m", category: "preference", layer: null, departmentId: null },
    ];

    const md = renderPinnedSkillMarkdown(items);

    const aIdx = md.indexOf("### A item");
    const mIdx = md.indexOf("### M item");
    const zIdx = md.indexOf("### Z item");
    expect(aIdx).toBeGreaterThan(0);
    expect(mIdx).toBeGreaterThan(aIdx);
    expect(zIdx).toBeGreaterThan(mIdx);
  });

  it("returns a placeholder when no items", () => {
    const md = renderPinnedSkillMarkdown([]);
    expect(md).toContain("(no pinned items)");
  });

  it("trims item content (no leading/trailing whitespace)", () => {
    const md = renderPinnedSkillMarkdown([
      {
        id: "1",
        title: "Test",
        content: "\n\n   The actual content.   \n\n",
        category: "preference",
        layer: null,
        departmentId: null,
      },
    ]);

    expect(md).toContain("The actual content.");
    // No double-trim leftovers
    expect(md).not.toMatch(/\n\n\nThe actual content\.\n\n\n/);
  });
});
