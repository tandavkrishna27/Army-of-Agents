/**
 * Teams QA — happy-path end-to-end sweep (Slice 9 / Task 9.3)
 *
 * Headline acceptance test for the entire Teams feature. Modeled after the
 * The broad QA suites (`memory-qa.test.ts`, `artifacts-qa.test.ts`,
 * `integration-qa.test.ts`, etc.): a single sweep file that exercises
 * the highest-value workflows end-to-end with mocked DB sequences.
 *
 * Five scenarios:
 *   1. Create team → manifest persisted (slug derived, row inserted).
 *   2. Add lead member → enforces dept-membership invariant + lead uniqueness.
 *   3. Coordination scaffold + section-aware regenerate (auto markers preserved).
 *   4. Export → import roundtrip equivalence (the headline acceptance test).
 *   5. Heartbeat skill-shaped injection (Slice 6 — highest-risk slice).
 *
 * Style notes:
 *   - These are sweep tests, not unit tests. Looser assertions are expected
 *     (e.g., `toContain("alice")` rather than strict deep-equal). Per-service
 *     correctness is covered by the dedicated test files
 *     (`teams-service.test.ts`, `team-export-service.test.ts`, etc.).
 *   - DB is mocked via `createAgentDb` from `helpers/mock-db.ts`. No live DB.
 *   - `vi.mock` stubs `@armyofagents/db` and `drizzle-orm` to avoid the ESM
 *     cycle issue documented in CLAUDE.md.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => {
  const passthrough = (..._args: unknown[]) => "drizzle-op";
  return {
    and: vi.fn(passthrough),
    asc: vi.fn(passthrough),
    desc: vi.fn(passthrough),
    eq: vi.fn(passthrough),
    gt: vi.fn(passthrough),
    inArray: vi.fn(passthrough),
    ne: vi.fn(passthrough),
    or: vi.fn(passthrough),
    sql: new Proxy(
      Object.assign(() => ({ as: () => "sql" }), { raw: () => ({ as: () => "sql" }) }),
      {
        get: (_t, prop: string | symbol) =>
          prop === "apply" ? () => ({ as: () => "sql" }) : () => ({ as: () => "sql" }),
        apply: () => ({ as: () => "sql" }),
      },
    ),
  };
});

vi.mock("@armyofagents/db", () => {
  // Heartbeat module touches a much larger surface than the team services do,
  // so we union all the tables that any of the modules under test reference.
  const makeTable = () =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "$inferSelect" || prop === "$inferInsert"
            ? {}
            : Symbol(String(prop)),
      },
    );
  return {
    agents: makeTable(),
    agentProjects: makeTable(),
    agentRuntimeState: makeTable(),
    agentTaskSessions: makeTable(),
    agentWakeupRequests: makeTable(),
    assets: makeTable(),
    companies: makeTable(),
    companySkills: makeTable(),
    costEvents: makeTable(),
    heartbeatRunEvents: makeTable(),
    heartbeatRuns: makeTable(),
    issueAttachments: makeTable(),
    issueComments: makeTable(),
    issues: makeTable(),
    memoryItems: makeTable(),
    projects: makeTable(),
    projectWorkspaces: makeTable(),
    taskDependencies: makeTable(),
    teamCoordinations: makeTable(),
    teamMembers: makeTable(),
    teams: makeTable(),
    // Required by services/embeddings.ts (B1: createEmbeddingService target map)
    discussions: makeTable(),
    discussionExtractedItems: makeTable(),
    embeddingQueue: makeTable(),
  };
});

vi.mock("../errors.js", () => ({
  badRequest: (msg: string) => {
    const err = new Error(msg);
    (err as any).status = 400;
    return err;
  },
  notFound: (msg: string) => {
    const err = new Error(msg);
    (err as any).status = 404;
    return err;
  },
  conflict: (msg: string) => {
    const err = new Error(msg);
    (err as any).status = 409;
    return err;
  },
  HttpError: class HttpError extends Error {
    status = 500;
  },
}));

// Heartbeat top-level imports — same rough mock surface as
// heartbeat-team-coordination.test.ts. The QA suite never invokes the real
// heartbeat run path, only the pure-helper `buildTeamCoordinationSkillEntries`,
// but the module imports load eagerly.
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

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { teamsService } from "../services/teams.js";
import { teamCoordinationService } from "../services/team-coordination.js";
import { teamScaffolderService } from "../services/team-scaffolder.js";
import { teamExportService } from "../services/team-export.js";
import { teamImportService } from "../services/team-import.js";
import { buildTeamCoordinationSkillEntries } from "../services/heartbeat.js";
import { createAgentDb } from "./helpers/mock-db.js";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Teams QA — happy-path end-to-end", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Test 1: Create team → manifest persisted ──────────────────────────────

  it("teamsService.create generates slug, inserts row, returns manifest shape", async () => {
    // teamsService.create() does:
    //   1. select projects (P1 cross-tenant guard) — must return one row
    //   2. select existing slugs (collision check)
    //   3. insert teams row → returning() → row
    const inserted = {
      id: "team-1",
      companyId: "co-1",
      parentProjectId: "proj-1",
      name: "Frontend Squad",
      slug: "frontend-squad",
      description: undefined,
      manifest: {},
    };
    const db = createAgentDb({
      selects: [
        [{ id: "proj-1" }], // P1: parent-project company check
        [], // no existing slugs
      ],
      inserts: [[inserted]],
    });

    const result = await teamsService(db as any).create("co-1", {
      name: "Frontend Squad",
      parentProjectId: "proj-1",
    });

    expect(result.id).toBe("team-1");
    expect(result.slug).toBe("frontend-squad");
    expect(result.name).toBe("Frontend Squad");
    expect(result.parentProjectId).toBe("proj-1");
    expect(result.manifest).toBeDefined();
  });

  // ── Test 2: Add lead member with dept-membership invariant ────────────────

  it("teamsService.addMember enforces dept-membership + lead-uniqueness invariants", async () => {
    // teamsService.addMember(teamId, agentId, "lead") does:
    //   1. select team → look up parentProjectId
    //   2. select agentProjects → confirm agent is in dept
    //   3. select team_members where role=lead → confirm no existing lead
    //   4. insert team_members row → returning() → row
    const db = createAgentDb({
      selects: [
        [{ id: "team-1", parentProjectId: "proj-1" }], // 1: team lookup
        [{ agentId: "agent-1", projectId: "proj-1" }], // 2: dept membership present
        [], // 3: no existing lead
      ],
      inserts: [
        [{ id: "tm-1", teamId: "team-1", agentId: "agent-1", role: "lead" }],
      ],
    });

    const result = await teamsService(db as any).addMember(
      "team-1",
      "agent-1",
      "lead",
    );

    expect(result.role).toBe("lead");
    expect(result.teamId).toBe("team-1");
    expect(result.agentId).toBe("agent-1");
  });

  // ── Test 3: Scaffold + section-aware regenerate ───────────────────────────

  it("teamScaffolderService produces auto-section markers; regenerate replaces them in place", async () => {
    // 3a) scaffoldInitial(teamId) does:
    //   1. select team
    //   2. select team_members
    //   3. select agents (only if memberRows.length > 0)
    const scaffoldDb = createAgentDb({
      selects: [
        [{ id: "team-1", name: "Frontend Squad" }], // 1: team lookup
        [{ teamId: "team-1", agentId: "agent-1", role: "lead" }], // 2: members
        [{ id: "agent-1", name: "alice", skillKeys: ["react"] }], // 3: agents
      ],
    });

    const initialMd = await teamScaffolderService(scaffoldDb as any).scaffoldInitial(
      "team-1",
    );

    expect(initialMd).toContain("## Mission");
    expect(initialMd).toContain("<!-- begin:auto:members -->");
    expect(initialMd).toContain("<!-- end:auto:members -->");
    expect(initialMd).toContain("<!-- begin:auto:routing -->");
    expect(initialMd).toContain("<!-- end:auto:routing -->");
    expect(initialMd).toContain("alice");

    // 3b) regenerateAutoSections(coordId, sections) does:
    //   1. select team_coordinations row
    //   2. update team_coordinations with the new (parser-rewritten) markdown
    // The parser must (a) replace BOTH auto sections in place and
    // (b) preserve user prose between them.
    const userProse = "## Mission\nWe own the UI.\n\nSome user prose here.";
    const original =
      `${userProse}\n\n` +
      `<!-- begin:auto:members -->\n## Members\n- old member\n<!-- end:auto:members -->\n\n` +
      `<!-- begin:auto:routing -->\n## Routing\n- old routing\n<!-- end:auto:routing -->`;

    let captured: string | undefined;
    const regenDb = {
      ...createAgentDb({
        selects: [[{ id: "coord-1", teamId: "team-1", markdown: original }]],
      }),
      // Override `update` so we can capture the markdown that gets written —
      // the QA assertion is on the rewritten content, not the returned row.
      update: (_table: unknown) => {
        const chain: any = {};
        for (const m of ["from", "where", "returning"]) {
          chain[m] = (..._args: unknown[]) => chain;
        }
        chain.set = (patch: { markdown?: string }) => {
          if (typeof patch?.markdown === "string") captured = patch.markdown;
          return chain;
        };
        chain.then = (resolve: (v: any[]) => unknown) =>
          Promise.resolve(
            resolve([{ id: "coord-1", teamId: "team-1", markdown: captured }]),
          );
        return chain;
      },
    };

    const updated = await teamCoordinationService(regenDb as any).regenerateAutoSections(
      "coord-1",
      {
        members: "## Members\n- alice [LEAD]",
        routing: "## Routing\n- default → @alice",
      },
    );

    expect(updated.id).toBe("coord-1");
    expect(captured).toBeDefined();
    // Auto sections replaced
    expect(captured).toContain("alice [LEAD]");
    expect(captured).toContain("default → @alice");
    expect(captured).not.toContain("old member");
    expect(captured).not.toContain("old routing");
    // User prose preserved (the parser's contract)
    expect(captured).toContain("We own the UI.");
    expect(captured).toContain("Some user prose here.");
    // Auto markers still present
    expect(captured).toContain("<!-- begin:auto:members -->");
    expect(captured).toContain("<!-- begin:auto:routing -->");
  });

  // ── Test 4: Export → import roundtrip equivalence (headline) ──────────────

  it("export → import preview roundtrip preserves manifest name, agents, and routing", async () => {
    // Two separate DB sequences in one test:
    //   1. Export DB simulates company A (the source team).
    //   2. Import-preview DB simulates company B (the destination — clean, no
    //      collisions because agents in company A use different UUIDs).
    //
    // We verify equivalence by NAME (the manifest's stable identifier),
    // not by ID — agent UUIDs differ across companies. This matches the
    // contract documented in `team-export.ts` ("agent UUIDs differ across
    // companies; everything else is equivalent").

    const TEAM_ROW = {
      id: "team-A",
      companyId: "co-A",
      name: "Frontend Squad",
      slug: "frontend-squad",
      description: "Owns UI",
      manifest: {
        routing: {
          rules: [{ match: "ui|design", mention: "@alice" }],
        },
        skillDeps: ["@aoa/react@1.0.0"],
      },
      templateVersion: "1.0.0",
    };
    const MEMBER_ROW = {
      teamId: "team-A",
      agentId: "agent-A1",
      role: "lead",
    };
    const AGENT_ROW = {
      id: "agent-A1",
      name: "alice",
      skillKeys: ["react"],
    };

    // Step 1: export from company A.
    const exportDb = createAgentDb({
      selects: [
        [TEAM_ROW], // team lookup
        [MEMBER_ROW], // members lookup
        [AGENT_ROW], // agents lookup
      ],
    });
    const yaml = await teamExportService(exportDb as any).exportYaml("team-A");

    // Sanity-check the YAML before piping it into preview.
    expect(yaml).toContain("name: frontend-squad");
    expect(yaml).toContain("alice");
    expect(yaml).toContain("- react");
    const exportedManifest = parseYaml(yaml) as {
      name: string;
      agents: Array<{ name: string; role: string; skillKeys: string[] }>;
      routing: { rules: Array<{ match: string; mention: string }> };
    };

    // Step 2: feed the YAML into a clean second company's import preview.
    // Company B has no existing agents and no installed skills →
    // preview should report no collisions and one skill to install.
    const importDb = createAgentDb({
      selects: [
        [], // agents collision lookup → none
        [], // companySkills lookup → no installed
      ],
    });
    const preview = await teamImportService(importDb as any).preview(
      "co-B",
      yaml,
    );

    // Equivalence by name (slug) — manifest.name is the stable identifier.
    expect(preview.manifest.name).toBe(exportedManifest.name);
    expect(preview.manifest.name).toBe("frontend-squad");

    // Agents shape — same names + roles + skillKeys, even though the source
    // agent's UUID never crosses the wire (no `id` field in the manifest).
    expect(preview.manifest.agents).toHaveLength(1);
    expect(preview.manifest.agents[0]).toMatchObject({
      name: "alice",
      role: "lead",
    });
    // skillKeys is a TS-narrowed-by-discriminator field — only inline agents
    // carry it. The export → import path goes through inline agents only.
    expect((preview.manifest.agents[0] as any).skillKeys).toEqual(["react"]);

    // Routing rules preserved verbatim.
    expect(preview.manifest.routing.rules).toEqual([
      { match: "ui|design", mention: "@alice" },
    ]);

    // Clean import: no agent name collisions in company B.
    expect(preview.collisions).toEqual([]);

    // Skills declared in manifest must surface as "to install" in company B
    // since we mocked an empty companySkills table.
    expect(preview.skillsToInstall).toContain("@aoa/react@1.0.0");
  });

  // ── Test 5: Heartbeat skill-shaped injection (Slice 6) ────────────────────

  it("buildTeamCoordinationSkillEntries gates on enableTeams and emits frontmatter-wrapped skill entries", async () => {
    // 5a) flag off → []
    const flagOffDb = createAgentDb({
      selects: [
        [{ enableTeams: false }], // companies query → flag off
        // No further queries fire.
      ],
    });
    const offResult = await buildTeamCoordinationSkillEntries(
      flagOffDb as any,
      "co-1",
      "agent-1",
    );
    expect(offResult).toEqual([]);

    // 5b) flag on + agent on a team with published coord → 1 entry
    const flagOnDb = createAgentDb({
      selects: [
        [{ enableTeams: true }], // companies query
        [{ teamId: "team-1" }], // memberships query
        [
          {
            teamId: "team-1",
            markdown: "## Mission\nWe handle UI.",
            trustLevel: "markdown_only",
          },
        ], // coords query (status=published filtered at SQL layer)
        [{ id: "team-1", name: "Frontend Squad" }], // teams names query
      ],
    });
    const onResult = await buildTeamCoordinationSkillEntries(
      flagOnDb as any,
      "co-1",
      "agent-1",
    );

    expect(onResult).toHaveLength(1);
    const entry = onResult[0];
    expect(entry.key).toBe("team-coord-team-1");
    expect(entry.name).toBe("Frontend Squad Coordination");
    expect(entry.trustLevel).toBe("markdown_only");
    // Frontmatter prepended so Claude Code's skill discovery sees it as a skill.
    expect(entry.markdown.startsWith("---\n")).toBe(true);
    expect(entry.markdown).toMatch(/^---\nname: team-coord-team-1\n/);
    expect(entry.markdown).toContain("description: >");
    expect(entry.markdown).toContain("Frontend Squad");
    // Founder body content preserved verbatim AFTER the frontmatter.
    expect(entry.markdown).toContain("## Mission");
    expect(entry.markdown).toContain("We handle UI.");
  });
});
