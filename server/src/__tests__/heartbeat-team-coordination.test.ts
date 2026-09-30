/**
 * Unit tests for buildTeamCoordinationSkillEntries (Slice 6, Task 6.1).
 *
 * The helper builds skill-shaped entries from team coordinations the assigned
 * agent belongs to. Returned entries are appended to context.skills so the
 * adapter materializes each as a markdown file in skillsDir alongside the
 * agent's normal skills -- no adapter changes required.
 *
 * Tests verify only the pure-helper contract (DB shape -> RuntimeSkillEntry[]).
 * Defensive try/catch behavior is the CALLER's concern (heartbeat.ts:2574-2603)
 * and is verified separately by integration smoke; the helper itself SHOULD
 * propagate DB errors so the call site can warn-log.
 */

import { vi } from "vitest";

// -- Mocks required because heartbeat.ts has top-level DB + drizzle imports --

vi.mock("@armyofagents/db", () => {
  const makeTable = () =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "$inferSelect" || prop === "$inferInsert" ? {} : Symbol(String(prop)),
      },
    );
  return {
    agents: makeTable(),
    agentRuntimeState: makeTable(),
    agentTaskSessions: makeTable(),
    agentWakeupRequests: makeTable(),
    heartbeatRunEvents: makeTable(),
    heartbeatRuns: makeTable(),
    costEvents: makeTable(),
    issues: makeTable(),
    projectWorkspaces: makeTable(),
    memoryItems: makeTable(),
    companies: makeTable(),
    taskDependencies: makeTable(),
    issueAttachments: makeTable(),
    issueComments: makeTable(),
    assets: makeTable(),
    projects: makeTable(),
    companySkills: makeTable(),
    teamMembers: makeTable(),
    teamCoordinations: makeTable(),
    teams: makeTable(),
    // Required by services/embeddings.ts (B1: createEmbeddingService target map)
    discussions: makeTable(),
    discussionExtractedItems: makeTable(),
    embeddingQueue: makeTable(),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (..._args: unknown[]) => "and",
  asc: (..._args: unknown[]) => "asc",
  desc: (..._args: unknown[]) => "desc",
  eq: (..._args: unknown[]) => "eq",
  gt: (..._args: unknown[]) => "gt",
  inArray: (..._args: unknown[]) => "inArray",
  ne: (..._args: unknown[]) => "ne",
  or: (..._args: unknown[]) => "or",
  sql: new Proxy(
    Object.assign(() => ({ as: () => "sql" }), { raw: () => ({ as: () => "sql" }) }),
    {
      get: (_t: unknown, prop: string | symbol) =>
        prop === "apply" ? () => ({ as: () => "sql" }) : () => ({ as: () => "sql" }),
      apply: () => ({ as: () => "sql" }),
    },
  ),
}));

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../services/run-log-store.js", () => ({ getRunLogStore: vi.fn() }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(),
  runningProcesses: new Map(),
}));
vi.mock("../agent-auth-jwt.js", () => ({ createLocalAgentJwt: vi.fn() }));
vi.mock("../adapters/utils.js", () => ({
  parseObject: vi.fn((v: unknown) => (v != null && typeof v === "object" ? v : {})),
  asBoolean: vi.fn(),
  asNumber: vi.fn(),
  appendWithCap: vi.fn(),
  MAX_EXCERPT_BYTES: 1024,
}));
vi.mock("../adapters/api-common.js", () => ({ setSecretResolver: vi.fn() }));
vi.mock("../services/secrets.js", () => ({ secretService: vi.fn(() => ({})) }));
vi.mock("../services/output-detection.js", () => ({
  outputDetectionService: vi.fn(() => ({})),
}));
vi.mock("../services/run-summary.js", () => ({ formatRunSummary: vi.fn() }));
vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { describe, expect, it } from "vitest";
import { buildTeamCoordinationSkillEntries } from "../services/heartbeat.js";
import { createAgentDb } from "./helpers/mock-db.js";

// ----------------------------------------------------------------------------

describe("buildTeamCoordinationSkillEntries (Slice 6)", () => {
  it("returns 1 entry when enableTeams=true and agent on a team with published coord", async () => {
    const db = createAgentDb({
      selects: [
        [{ enableTeams: true }],                                                        // companies query
        [{ teamId: "t1" }],                                                             // memberships query
        [{ teamId: "t1", markdown: "# Team mission", trustLevel: "markdown_only" }],    // coords query
        [{ id: "t1", name: "Frontend Team" }],                                          // teams names query
      ],
    });

    const result = await buildTeamCoordinationSkillEntries(db as any, "c1", "a1");

    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("team-coord-t1");
    expect(result[0].name).toBe("Frontend Team Coordination");
    expect(result[0].trustLevel).toBe("markdown_only");
    // Verify the markdown is frontmatter-wrapped
    expect(result[0].markdown).toMatch(/^---\nname: team-coord-t1\n/);
    expect(result[0].markdown).toContain("description: >");
    expect(result[0].markdown).toContain("Frontend Team");
    // And verify the original body content is preserved AFTER the frontmatter
    expect(result[0].markdown).toContain("# Team mission");
    expect(result[0].markdown.indexOf("# Team mission")).toBeGreaterThan(
      result[0].markdown.indexOf("---\n\n"),
    );
  });

  it("returns [] when enableTeams=false (feature flag gate)", async () => {
    const db = createAgentDb({
      selects: [
        [{ enableTeams: false }],  // companies query -- flag off
        // No further queries should fire.
      ],
    });

    const result = await buildTeamCoordinationSkillEntries(db as any, "c1", "a1");

    expect(result).toEqual([]);
  });

  it("returns [] when enableTeams=true but agent has no team memberships", async () => {
    const db = createAgentDb({
      selects: [
        [{ enableTeams: true }],  // companies query
        [],                        // memberships query -- none
      ],
    });

    const result = await buildTeamCoordinationSkillEntries(db as any, "c1", "a1");

    expect(result).toEqual([]);
  });

  it("returns 2 entries when agent is on 2 teams with 1 published coord each", async () => {
    const db = createAgentDb({
      selects: [
        [{ enableTeams: true }],                                  // companies query
        [{ teamId: "t1" }, { teamId: "t2" }],                     // memberships query
        [
          { teamId: "t1", markdown: "# T1 mission", trustLevel: "markdown_only" },
          { teamId: "t2", markdown: "# T2 mission", trustLevel: "markdown_only" },
        ],                                                         // coords query
        [
          { id: "t1", name: "Frontend Team" },
          { id: "t2", name: "Backend Team" },
        ],                                                         // teams names query
      ],
    });

    const result = await buildTeamCoordinationSkillEntries(db as any, "c1", "a1");

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.key).sort()).toEqual([
      "team-coord-t1",
      "team-coord-t2",
    ]);
    const t1 = result.find((r) => r.key === "team-coord-t1");
    const t2 = result.find((r) => r.key === "team-coord-t2");
    expect(t1?.name).toBe("Frontend Team Coordination");
    expect(t2?.name).toBe("Backend Team Coordination");
    // Frontmatter wrap on each entry
    expect(t1?.markdown).toMatch(/^---\nname: team-coord-t1\n/);
    expect(t2?.markdown).toMatch(/^---\nname: team-coord-t2\n/);
    expect(t1?.markdown).toContain("Frontend Team");
    expect(t2?.markdown).toContain("Backend Team");
    // Founder body content preserved AFTER the frontmatter
    expect(t1?.markdown).toContain("# T1 mission");
    expect(t2?.markdown).toContain("# T2 mission");
    expect((t1?.markdown ?? "").indexOf("# T1 mission")).toBeGreaterThan(
      (t1?.markdown ?? "").indexOf("---\n\n"),
    );
    expect((t2?.markdown ?? "").indexOf("# T2 mission")).toBeGreaterThan(
      (t2?.markdown ?? "").indexOf("---\n\n"),
    );
    expect(t1?.trustLevel).toBe("markdown_only");
    expect(t2?.trustLevel).toBe("markdown_only");
  });

  it("excludes drafts (status='published' filter at DB layer): 2 memberships, only 1 published coord", async () => {
    // The DB query has a status='published' filter, so the coords query result
    // will only include the published rows. This test asserts the helper's
    // output reflects exactly what the DB returned -- no in-memory filtering
    // shenanigans that could accidentally include drafts.
    const db = createAgentDb({
      selects: [
        [{ enableTeams: true }],                                                          // companies query
        [{ teamId: "t1" }, { teamId: "t2" }],                                             // memberships query
        [{ teamId: "t1", markdown: "# T1 published", trustLevel: "markdown_only" }],      // coords query -- only t1 published; t2 is draft, filtered out at SQL layer
        [
          { id: "t1", name: "Frontend Team" },
          { id: "t2", name: "Backend Team" },
        ],                                                                                // teams names query
      ],
    });

    const result = await buildTeamCoordinationSkillEntries(db as any, "c1", "a1");

    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("team-coord-t1");
    expect(result[0].name).toBe("Frontend Team Coordination");
    expect(result[0].trustLevel).toBe("markdown_only");
    // Frontmatter wrap, with the published body preserved
    expect(result[0].markdown).toMatch(/^---\nname: team-coord-t1\n/);
    expect(result[0].markdown).toContain("description: >");
    expect(result[0].markdown).toContain("Frontend Team");
    expect(result[0].markdown).toContain("# T1 published");
    expect(result[0].markdown.indexOf("# T1 published")).toBeGreaterThan(
      result[0].markdown.indexOf("---\n\n"),
    );
  });

  it("preserves trustLevel from the DB column (pass-through, not hardcoded)", async () => {
    // Asserts the helper reads trustLevel from team_coordinations.trustLevel
    // rather than synthesizing a constant. If a future founder bumps a team
    // coord to "scripts_executables" (executable trust), that elevated trust
    // must flow through to the materialized skill entry.
    const db = createAgentDb({
      selects: [
        [{ enableTeams: true }],                                                                  // companies query
        [{ teamId: "t1" }],                                                                       // memberships query
        [{ teamId: "t1", markdown: "# Trusted scripts", trustLevel: "scripts_executables" }],     // coords query -- elevated trust
        [{ id: "t1", name: "Ops Team" }],                                                         // teams names query
      ],
    });

    const result = await buildTeamCoordinationSkillEntries(db as any, "c1", "a1");

    expect(result).toHaveLength(1);
    expect(result[0]?.trustLevel).toBe("scripts_executables");
    // Even with elevated trust the frontmatter wrap still happens
    expect(result[0]?.markdown).toMatch(/^---\nname: team-coord-/);
  });

  it("wraps founder markdown with YAML frontmatter so Claude Code discovers the skill", async () => {
    const founderMarkdown = "## Mission\nWe handle all UI work.\n\n## Scope\n- React components";
    const db = createAgentDb({
      selects: [
        [{ enableTeams: true }],
        [{ teamId: "t1" }],
        [{ teamId: "t1", markdown: founderMarkdown, trustLevel: "markdown_only" }],
        [{ id: "t1", name: "Frontend" }],
      ],
    });
    const result = await buildTeamCoordinationSkillEntries(db as any, "c1", "a1");
    expect(result).toHaveLength(1);

    const md = result[0].markdown;

    // Frontmatter delimiters
    expect(md.startsWith("---\n")).toBe(true);
    const closingIdx = md.indexOf("\n---\n", 4);  // closing --- after the opening one
    expect(closingIdx).toBeGreaterThan(0);

    // Frontmatter contains name matching the entry key
    const fm = md.slice(4, closingIdx);  // content between the --- markers
    expect(fm).toContain("name: team-coord-t1");
    expect(fm).toContain("description: >");
    // Description references the team name (so Claude knows what team)
    expect(fm).toContain("Frontend");

    // Founder body content preserved verbatim AFTER the frontmatter
    const bodyStart = closingIdx + "\n---\n".length;
    const body = md.slice(bodyStart).trimStart();
    expect(body).toBe(founderMarkdown);
  });

  it("does not inject coordinations from archived teams (P1-D)", async () => {
    // Defense-in-depth: an agent is on a team whose coordination row is still
    // status='published' (data drift, manual SQL bypass, or a legacy row from
    // before the archive cascade landed). The team itself is archived. The
    // coords SELECT must JOIN `teams` and filter teams.status != 'archived',
    // so the coords-query returns [] server-side -- and the helper short-circuits
    // to [] without ever issuing the team-names SELECT.
    //
    // The test asserts the implementation contract directly: the coords query
    // chain must call .innerJoin (with the un-fixed code, no JOIN is issued and
    // the assertion fails). It also asserts the result-shape contract: with the
    // JOIN in place, when the DB returns [] (which it would for an archived
    // team), the helper must return []. Both signals together prove the fix.
    let innerJoinCalled = false;
    let selectIdx = 0;
    const sequenced: any[][] = [
      [{ enableTeams: true }],   // 1: companies query
      [{ teamId: "t1" }],        // 2: memberships query
      [],                        // 3: coords query -- what the JOIN'd query would return
      // 4: teams-names query never runs (helper short-circuits when coords empty)
    ];

    function makeChain(getResult: () => any[]) {
      const chain: Record<string, unknown> = {};
      for (const m of [
        "from", "where", "set", "values", "returning",
        "leftJoin", "orderBy", "limit", "catch",
      ]) {
        chain[m] = (..._args: unknown[]) => chain;
      }
      chain.innerJoin = (..._args: unknown[]) => {
        innerJoinCalled = true;
        return chain;
      };
      chain.then = (resolve: (v: any[]) => unknown) =>
        Promise.resolve(resolve(getResult()));
      return chain;
    }
    const db: any = {
      select: () => makeChain(() => sequenced[selectIdx++] ?? []),
    };

    const result = await buildTeamCoordinationSkillEntries(db, "c1", "a1");

    // Implementation contract -- the coords query must JOIN teams.
    expect(innerJoinCalled).toBe(true);
    // Result contract -- archived team's coord must not surface.
    expect(result).toHaveLength(0);
  });
});
