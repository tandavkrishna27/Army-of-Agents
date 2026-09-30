import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

// -- Mocks --------------------------------------------------------------------

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  inArray: vi.fn((c: any, v: any) => ({ inArray: [c, v] })),
  sql: vi.fn(() => ({ sql: true })),
}));

vi.mock("@armyofagents/db", () => ({
  agents: {
    id: "agents_id",
    name: "agents_name",
    skillKeys: "agents_skill_keys",
  },
  teams: {
    id: "teams_id",
    name: "teams_name",
    slug: "teams_slug",
    description: "teams_description",
    manifest: "teams_manifest",
    templateVersion: "teams_template_version",
  },
  teamMembers: {
    id: "team_members_id",
    teamId: "team_members_team_id",
    agentId: "team_members_agent_id",
    role: "team_members_role",
  },
}));

vi.mock("../errors.js", () => ({
  notFound: (msg: string) => {
    const err = new Error(msg);
    (err as any).status = 404;
    return err;
  },
}));

import { teamExportService } from "../services/team-export.js";
import { createAgentDb } from "./helpers/mock-db.js";

// -- Fixtures -----------------------------------------------------------------

const TEAM_ROW = {
  id: "team-1",
  companyId: "co-1",
  name: "Frontend Squad",
  slug: "frontend",
  description: "UI work",
  manifest: { routing: { rules: [] } },
  templateVersion: "1.0.0",
};

// -- Tests --------------------------------------------------------------------

describe("teamExportService.exportYaml()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns YAML containing the team's slug, member name, and skill", async () => {
    // Sequence:
    //   1. teams lookup -> 1 row
    //   2. teamMembers lookup -> 1 lead member
    //   3. agents lookup -> 1 agent named "alice" with [react]
    const db = createAgentDb({
      selects: [
        [TEAM_ROW],
        [{ teamId: "team-1", agentId: "agent-1", role: "lead" }],
        [{ id: "agent-1", name: "alice", skillKeys: ["react"] }],
      ],
    });

    const yaml = await teamExportService(db as any).exportYaml("team-1");

    expect(yaml).toContain("name: frontend");
    expect(yaml).toContain("alice");
    expect(yaml).toContain("- react");
  });

  it("returns YAML with `routing` from team.manifest", async () => {
    const teamWithRouting = {
      ...TEAM_ROW,
      manifest: {
        routing: {
          rules: [{ match: "test", mention: "@a" }],
        },
      },
    };
    const db = createAgentDb({
      selects: [
        [teamWithRouting],
        [{ teamId: "team-1", agentId: "agent-1", role: "lead" }],
        [{ id: "agent-1", name: "alice", skillKeys: [] }],
      ],
    });

    const yaml = await teamExportService(db as any).exportYaml("team-1");
    const parsed = parseYaml(yaml);

    expect(parsed.routing.rules).toEqual([
      { match: "test", mention: "@a" },
    ]);
  });

  it("empty team (no members) returns valid YAML with empty agents array", async () => {
    const db = createAgentDb({
      selects: [
        [TEAM_ROW],
        [], // no members
        // no agents lookup runs because memberRows.length === 0
      ],
    });

    const yaml = await teamExportService(db as any).exportYaml("team-1");
    const parsed = parseYaml(yaml);

    expect(parsed.agents).toEqual([]);
    expect(parsed.name).toBe("frontend");
  });

  it("throws notFound when the team doesn't exist", async () => {
    const db = createAgentDb({
      selects: [
        [], // teams lookup -> empty
      ],
    });

    await expect(
      teamExportService(db as any).exportYaml("nonexistent"),
    ).rejects.toThrow(/team nonexistent not found/);
  });

  it("coerces description: null -> undefined when both team and stored are null (P2-H)", async () => {
    // P2-H: team.description is a nullable TEXT column on the `teams` table;
    // stored.description (on the persisted manifest) is also possibly null
    // (e.g. when a manifest was imported without a description). The
    // previous coalesce `team.description ?? stored.description` would
    // therefore evaluate to `null` and feed straight into
    // `TeamManifestSchema.parse()` -- which uses `.optional()`, NOT
    // `.nullable()`, so it crashes on `null`. Fix: append `?? undefined`.
    const teamWithNullDesc = {
      ...TEAM_ROW,
      description: null,
      manifest: {
        routing: { rules: [] },
        description: null,
      },
    };
    const db = createAgentDb({
      selects: [
        [teamWithNullDesc],
        [{ teamId: "team-1", agentId: "agent-1", role: "lead" }],
        [{ id: "agent-1", name: "alice", skillKeys: [] }],
      ],
    });

    // The whole point: this used to throw a ZodError because the assembled
    // manifest had `description: null` and the schema rejects it.
    const yaml = await teamExportService(db as any).exportYaml("team-1");
    const parsed = parseYaml(yaml);

    // YAML serialization of `undefined` produces no key (or `null` from
    // null), but Zod stripping after `.parse()` drops the optional field
    // entirely when the value was undefined. Either way, the parsed YAML
    // should not carry a string description.
    expect(parsed.description).toBeUndefined();
  });

  it("preserves workflowTemplates and memoryItems from team.manifest (P1-5)", async () => {
    // P1-5 fidelity contract: the export path used to only rehydrate
    // routing/skillDeps/pluginDeps from team.manifest, silently dropping
    // workflowTemplates and memoryItems on round-trip. Now we spread the
    // entire stored manifest before applying overrides for the
    // dynamically-computed fields (agents).
    const teamWithExtras = {
      ...TEAM_ROW,
      manifest: {
        routing: { rules: [{ match: "ui", mention: "@a" }] },
        workflowTemplates: [{ $ref: "@aoa/test@1.0.0" }],
        memoryItems: [
          { layer: "domain", title: "X", body: "Y" },
        ],
      },
    };
    const db = createAgentDb({
      selects: [
        [teamWithExtras],
        [{ teamId: "team-1", agentId: "agent-1", role: "lead" }],
        [{ id: "agent-1", name: "alice", skillKeys: [] }],
      ],
    });

    const yaml = await teamExportService(db as any).exportYaml("team-1");
    const parsed = parseYaml(yaml);

    expect(parsed.workflowTemplates).toEqual([{ $ref: "@aoa/test@1.0.0" }]);
    expect(parsed.memoryItems).toEqual([
      { layer: "domain", title: "X", body: "Y" },
    ]);
  });
});
