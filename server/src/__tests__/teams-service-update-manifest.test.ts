import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  inArray: vi.fn((c: any, v: any) => ({ inArray: [c, v] })),
  sql: vi.fn(() => ({ sql: true })),
}));

vi.mock("@armyofagents/db", () => ({
  teams: {
    id: "teams_id",
    companyId: "teams_company_id",
    parentProjectId: "teams_parent_project_id",
    name: "teams_name",
    slug: "teams_slug",
    description: "teams_description",
    manifest: "teams_manifest",
    templateOrigin: "teams_template_origin",
    templateVersion: "teams_template_version",
    status: "teams_status",
    archivedAt: "teams_archived_at",
    createdAt: "teams_created_at",
    updatedAt: "teams_updated_at",
  },
  teamMembers: {
    id: "tm_id",
    teamId: "tm_team_id",
    agentId: "tm_agent_id",
    role: "tm_role",
    createdAt: "tm_created_at",
  },
  agentProjects: {
    agentId: "ap_agent_id",
    projectId: "ap_project_id",
  },
}));

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
}));

import { teamsService } from "../services/teams.js";
import { createAgentDb } from "./helpers/mock-db.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_MANIFEST = {
  schemaVersion: 1 as const,
  name: "frontend-team",
  version: "1.0.0",
  displayName: "Frontend Team",
  agents: [
    {
      name: "alice",
      role: "lead" as const,
      skillKeys: ["react", "css"],
    },
  ],
  routing: {
    defaultLead: "@alice",
    rules: [
      { match: "^bug:", mention: "@alice" },
    ],
  },
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("teamsService.updateManifest()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns updated team when manifest is valid", async () => {
    const updated = {
      id: "t1",
      companyId: "co-1",
      name: "Frontend",
      manifest: VALID_MANIFEST,
    };
    const db = createAgentDb({ updates: [[updated]] });

    const result = await teamsService(db as any).updateManifest(
      "t1",
      VALID_MANIFEST,
    );

    expect(result).toEqual(updated);
  });

  it("throws notFound when team is missing", async () => {
    const db = createAgentDb({ updates: [[]] });

    await expect(
      teamsService(db as any).updateManifest("missing", VALID_MANIFEST),
    ).rejects.toThrow(/not found/i);
  });

  it("throws when manifest fails validateManifest invariants (invalid regex)", async () => {
    const db = createAgentDb({ updates: [[{ id: "t1" }]] });

    const badManifest = {
      ...VALID_MANIFEST,
      routing: {
        defaultLead: "@alice",
        rules: [{ match: "[unclosed", mention: "@alice" }],
      },
    };

    await expect(
      teamsService(db as any).updateManifest("t1", badManifest),
    ).rejects.toThrow(/regex/i);
  });

  it("throws when manifest fails Zod schema validation (missing required fields)", async () => {
    const db = createAgentDb({ updates: [[{ id: "t1" }]] });

    const badManifest = {
      schemaVersion: 1,
      name: "x",
      // missing version, agents, routing
    };

    await expect(
      teamsService(db as any).updateManifest("t1", badManifest),
    ).rejects.toThrow(/invalid manifest/i);
  });
});
