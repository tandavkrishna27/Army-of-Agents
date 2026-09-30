import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  // T3.2: aoaAgentTriggers added so trigger-insert path in createMarketplaceAgent resolves
  // T2.3e: internalAgentConfig — createMarketplaceAgent resolves the company crew
  // adapter for kind='aoa' templates (resolveCrewAdapterForCompany).
  return { agents: tableProxy, aoaAgentTriggers: tableProxy, internalAgentConfig: tableProxy };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("op:eq"),
  and: () => Symbol("op:and"),
}));
vi.mock(
  "../services/outbound-url-guard.js",
  () => import("./helpers/outbound-url-guard.mock.js"),
);

import { installAgent } from "../services/marketplace-install/agent-installer.js";

/**
 * T2.3e: the `internal_agent_config` read `resolveCrewAdapterForCompany` makes
 * for `kind: "aoa"` installs. An empty result models a company with no config
 * row — the openai/codex fallback. Every db stub below carries it so a crew
 * install does not blow up on a missing `select`.
 */
const crewConfigSelect = () => ({
  from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
});
import type { CatalogItem } from "@armyofagents/shared";

const PINNED_RESOURCE_BASE =
  `https://raw.githubusercontent.com/MeteoriteLabs/aoa-marketplace/${"f".repeat(40)}`;
const AGENT_TEMPLATE: CatalogItem = {
  id: "agent:aoa-curated/engineer",
  type: "agent",
  name: "Engineer",
  description: "Senior engineer agent",
  version: "1.0.0",
  source: { adapter: "aoa-curated", url: "https://...", locator: "content/agents/engineer", commitSha: "abc123" },
  resourceUrl: `${PINNED_RESOURCE_BASE}/content/agents/engineer/agent.json`,
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-04-30T00:00:00Z",
  category: "engineering",
  tags: [],
  requires: [
    { type: "skill", id: "skill:aoa-curated/code-review" },
  ],
};

const AGENT_JSON_BODY = JSON.stringify({
  role: "engineer",
  title: "Senior Engineer",
  icon: "wrench",
  adapterType: "claude_local",
  adapterConfig: { model: "claude-sonnet-4", promptTemplate: "Build carefully." },
  runtimeConfig: { contextMode: "standard" },
  permissions: { canCommit: true },
  skillKeys: ["skill:aoa-curated/code-review"],
});

describe("installAgent", () => {
  let insertedRow: any = null;
  const mockDb = {
    insert: () => ({
      values: (row: any) => {
        insertedRow = row;
        return {
          returning: () => Promise.resolve([{ ...row, id: "agent-uuid-1" }]),
        };
      },
    }),
    select: crewConfigSelect,
    transaction: async (cb: any) => cb(mockDb),
  };

  beforeEach(() => { insertedRow = null; });

  it("fetches agent.json, copies fields into agents row, sets templateOrigin/Version", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => AGENT_JSON_BODY,
    })) as any;

    const result = await installAgent({
      catalogItem: AGENT_TEMPLATE,
      companyId: "c1",
      db: mockDb as any,
      desiredName: "Engineer",
    });

    expect(insertedRow.companyId).toBe("c1");
    expect(insertedRow.name).toBe("Engineer");
    expect(insertedRow.role).toBe("engineer");
    expect(insertedRow.adapterType).toBe("claude_local");
    expect(insertedRow.skillKeys).toEqual(["skill:aoa-curated/code-review"]);
    expect(insertedRow.templateOrigin).toBe("agent:aoa-curated/engineer");
    expect(insertedRow.templateVersion).toBe("1.0.0");
    expect(result.agentId).toBe("agent-uuid-1");
  });

  it("throws if resourceUrl missing", async () => {
    const broken: CatalogItem = { ...AGENT_TEMPLATE, resourceUrl: undefined };
    await expect(
      installAgent({ catalogItem: broken, companyId: "c1", db: mockDb as any, desiredName: "X" }),
    ).rejects.toThrow(/has no resourceUrl/);
  });

  it("throws if agent.json is invalid JSON", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => "not json" })) as any;
    await expect(
      installAgent({ catalogItem: AGENT_TEMPLATE, companyId: "c1", db: mockDb as any, desiredName: "X" }),
    ).rejects.toThrow(/parse|json/i);
  });

  it("throws when HTTP fetch returns non-ok", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404 })) as any;
    await expect(
      installAgent({ catalogItem: AGENT_TEMPLATE, companyId: "c1", db: mockDb as any, desiredName: "X" }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("uses schema defaults when agent.json fields are missing", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        title: "Minimal Agent",
        adapterConfig: { promptTemplate: "Act as a minimal agent." },
      }),
    })) as any;

    await installAgent({
      catalogItem: AGENT_TEMPLATE,
      companyId: "c1",
      db: mockDb as any,
      desiredName: "Minimal",
    });

    expect(insertedRow.role).toBe("general");
    expect(insertedRow.adapterType).toBe("process");
    expect(insertedRow.skillKeys).toEqual([]);
    expect(insertedRow.adapterConfig).toEqual({ promptTemplate: "Act as a minimal agent." });
    expect(insertedRow.runtimeConfig).toEqual({});
    expect(insertedRow.permissions).toEqual({});
    expect(insertedRow.budgetMonthlyCents).toBe(0);
  });

  it("sets metadata with catalog provenance", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200, text: async () => AGENT_JSON_BODY,
    })) as any;

    await installAgent({
      catalogItem: AGENT_TEMPLATE,
      companyId: "c1",
      db: mockDb as any,
      desiredName: "Engineer",
    });

    expect(insertedRow.metadata).toEqual(expect.objectContaining({
      catalogCategory: "engineering",
      catalogTags: [],
      catalogTrustTier: "verified",
    }));
    expect(insertedRow.metadata.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("installs agent.v1, materializes bundle instructions, and stores setup metadata", async () => {
    const materializeManagedBundle = vi.fn(async (_agent, _files, options) => ({
      bundle: {
        files: [],
        entryFile: options.entryFile,
        managedRootPath: "/tmp/agent-1",
        resolvedEntryPath: "/tmp/agent-1/AGENTS.md",
        warnings: [],
      },
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: options.entryFile,
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
      },
    }));

    const updates: any[] = [];
    const db = {
      insert: () => ({
        values: (row: any) => {
          insertedRow = row;
          return {
            returning: () => Promise.resolve([{ ...row, id: "agent-uuid-1" }]),
          };
        },
      }),
      update: () => ({
        set: (patch: any) => {
          updates.push(patch);
          return { where: () => Promise.resolve() };
        },
      }),
      select: crewConfigSelect,
      transaction: async (cb: any) => cb(db),
    };

    global.fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/agent.json")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            schemaVersion: "agent.v1",
            id: "github-issue-triager",
            name: "GitHub Issue Triager",
            description: "Triages GitHub issues",
            instructions: {
              type: "bundle",
              entry: "AGENTS.md",
              files: ["AGENTS.md", "SOUL.md", "TOOLS.md", "HEARTBEAT.md"],
            },
            aoa: {
              adapterCompatibility: { recommended: "codex_local", supported: ["codex_local"] },
              install: { defaultRole: "general", defaultStatus: "active", defaultIcon: "git-branch" },
              skillKeys: ["skill:github-skills/openai/skills/gh-address-comments"],
              setup: {
                secrets: [
                  {
                    key: "GITHUB_TOKEN",
                    label: "GitHub token",
                    required: true,
                    reason: "Required for GitHub.",
                  },
                ],
              },
            },
          }),
        };
      }
      return { ok: true, status: 200, text: async () => `# ${url.split("/").pop()}\n` };
    }) as any;

    const result = await installAgent({
      catalogItem: AGENT_TEMPLATE,
      companyId: "c1",
      db: db as any,
      desiredName: "GitHub Issue Triager",
      availableAdapterTypes: ["codex_local"],
      instructionsService: { materializeManagedBundle } as any,
    });

    expect(result.agentId).toBe("agent-uuid-1");
    expect(materializeManagedBundle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-uuid-1" }),
      expect.objectContaining({
        "AGENTS.md": "# AGENTS.md\n",
        "SOUL.md": "# SOUL.md\n",
        "TOOLS.md": "# TOOLS.md\n",
        "HEARTBEAT.md": "# HEARTBEAT.md\n",
      }),
      expect.objectContaining({ entryFile: "AGENTS.md", replaceExisting: true }),
    );
    expect(insertedRow.role).toBe("general");
    expect(insertedRow.adapterType).toBe("codex_local");
    expect(insertedRow.status).toBe("paused");
    expect(insertedRow.metadata.marketplaceSetupRequired).toBe(true);
    expect(updates[0].adapterConfig.instructionsBundleMode).toBe("managed");
  });

  it("prefers agent.v1 bundle instructions over adapterConfig.promptTemplate during install", async () => {
    const materializeManagedBundle = vi.fn(async (_agent, _files, options) => ({
      adapterConfig: {
        promptTemplate: "Legacy prompt should remain adapter config only.",
        instructionsBundleMode: "managed",
        instructionsEntryFile: options.entryFile,
      },
    }));
    const updates: any[] = [];
    const db = {
      insert: () => ({
        values: (row: any) => {
          insertedRow = row;
          return {
            returning: () => Promise.resolve([{ ...row, id: "agent-uuid-1" }]),
          };
        },
      }),
      update: () => ({
        set: (patch: any) => {
          updates.push(patch);
          return { where: () => Promise.resolve() };
        },
      }),
      select: crewConfigSelect,
      transaction: async (cb: any) => cb(db),
    };

    global.fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/agent.json")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            schemaVersion: "agent.v1",
            id: "bundle-agent",
            name: "Bundle Agent",
            description: "Uses bundle instructions",
            instructions: {
              type: "bundle",
              entry: "AGENTS.md",
              files: ["AGENTS.md", "SOUL.md"],
            },
            aoa: {
              adapterType: "codex_local",
              adapterConfig: {
                promptTemplate: "Legacy prompt should not be materialized.",
              },
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => `# ${url.split("/").pop()}\n`,
      };
    }) as any;

    await installAgent({
      catalogItem: AGENT_TEMPLATE,
      companyId: "c1",
      db: db as any,
      desiredName: "Bundle Agent",
      instructionsService: { materializeManagedBundle } as any,
    });

    expect(materializeManagedBundle).toHaveBeenCalledWith(
      expect.anything(),
      {
        "AGENTS.md": "# AGENTS.md\n",
        "SOUL.md": "# SOUL.md\n",
      },
      expect.objectContaining({ entryFile: "AGENTS.md" }),
    );
    expect(materializeManagedBundle).not.toHaveBeenCalledWith(
      expect.anything(),
      { "AGENTS.md": "Legacy prompt should not be materialized." },
      expect.anything(),
    );
    expect(updates[0].adapterConfig.instructionsEntryFile).toBe("AGENTS.md");
  });

  it("materializes legacy promptTemplate as AGENTS.md and clears it after success", async () => {
    let agentConfigDuringMaterialize: unknown = null;
    const materializeManagedBundle = vi.fn(async (agent, _files, options) => {
      agentConfigDuringMaterialize = agent.adapterConfig;
      return {
        adapterConfig: {
          model: "claude-sonnet-4",
          instructionsBundleMode: "managed",
          instructionsEntryFile: options.entryFile,
        },
      };
    });

    const updates: any[] = [];
    const db = {
      insert: () => ({
        values: (row: any) => {
          insertedRow = row;
          return {
            returning: () => Promise.resolve([{ ...row, id: "agent-uuid-1" }]),
          };
        },
      }),
      update: () => ({
        set: (patch: any) => {
          updates.push(patch);
          return { where: () => Promise.resolve() };
        },
      }),
      select: crewConfigSelect,
      transaction: async (cb: any) => cb(db),
    };

    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        role: "engineer",
        title: "Legacy Engineer",
        adapterType: "claude_local",
        adapterConfig: {
          model: "claude-sonnet-4",
          promptTemplate: "  Build carefully.\n  ",
        },
      }),
    })) as any;

    await installAgent({
      catalogItem: AGENT_TEMPLATE,
      companyId: "c1",
      db: db as any,
      desiredName: "Legacy Engineer",
      instructionsService: { materializeManagedBundle } as any,
    });

    expect(insertedRow.adapterConfig).toEqual({
      model: "claude-sonnet-4",
      promptTemplate: "  Build carefully.\n  ",
    });
    expect(materializeManagedBundle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-uuid-1" }),
      { "AGENTS.md": "Build carefully." },
      expect.objectContaining({
        entryFile: "AGENTS.md",
        replaceExisting: true,
        clearLegacyPromptTemplate: true,
      }),
    );
    expect(agentConfigDuringMaterialize).toEqual({
      model: "claude-sonnet-4",
      promptTemplate: "  Build carefully.\n  ",
    });
    expect(updates[0].adapterConfig).toEqual({
      model: "claude-sonnet-4",
      instructionsBundleMode: "managed",
      instructionsEntryFile: "AGENTS.md",
    });
    expect(updates[0].adapterConfig).not.toHaveProperty("promptTemplate");
  });

  it("does not clear legacy promptTemplate when materialization fails", async () => {
    let agentConfigDuringMaterialize: unknown = null;
    const committedRows: any[] = [];
    const updates: any[] = [];
    const materializeManagedBundle = vi.fn(async (agent) => {
      agentConfigDuringMaterialize = agent.adapterConfig;
      throw new Error("bundle write failed");
    });
    const db = {
      select: crewConfigSelect,
      transaction: async (cb: any) => {
        const pendingRows: any[] = [];
        const tx = {
          insert: () => ({
            values: (row: any) => ({
              returning: () => {
                pendingRows.push(row);
                return Promise.resolve([{ ...row, id: "agent-uuid-1" }]);
              },
            }),
          }),
          update: () => ({
            set: (patch: any) => {
              updates.push(patch);
              return { where: () => Promise.resolve() };
            },
          }),
        };
        const result = await cb(tx);
        committedRows.push(...pendingRows);
        return result;
      },
    };

    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        role: "engineer",
        adapterConfig: {
          model: "claude-sonnet-4",
          promptTemplate: "Build carefully.",
        },
      }),
    })) as any;

    await expect(
      installAgent({
        catalogItem: AGENT_TEMPLATE,
        companyId: "c1",
        db: db as any,
        desiredName: "Legacy Engineer",
        instructionsService: { materializeManagedBundle } as any,
      }),
    ).rejects.toThrow(/bundle write failed/);

    expect(agentConfigDuringMaterialize).toEqual({
      model: "claude-sonnet-4",
      promptTemplate: "Build carefully.",
    });
    expect(committedRows).toEqual([]);
    expect(updates).toEqual([]);
  });

  it("does not commit an agent row when instruction materialization fails", async () => {
    const committedRows: any[] = [];
    const materializeManagedBundle = vi.fn(async () => {
      throw new Error("bundle write failed");
    });
    const db = {
      select: crewConfigSelect,
      transaction: async (cb: any) => {
        const pendingRows: any[] = [];
        const tx = {
          insert: () => ({
            values: (row: any) => ({
              returning: () => {
                pendingRows.push(row);
                return Promise.resolve([{ ...row, id: "agent-uuid-1" }]);
              },
            }),
          }),
          update: () => ({
            set: () => ({ where: () => Promise.resolve() }),
          }),
        };
        const result = await cb(tx);
        committedRows.push(...pendingRows);
        return result;
      },
    };

    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        schemaVersion: "agent.v1",
        id: "failing-agent",
        name: "Failing Agent",
        description: "Fails while writing instructions",
        instructions: {
          type: "inline",
          content: "Use the managed bundle.",
        },
      }),
    })) as any;

    await expect(
      installAgent({
        catalogItem: AGENT_TEMPLATE,
        companyId: "c1",
        db: db as any,
        desiredName: "Failing Agent",
        instructionsService: { materializeManagedBundle } as any,
      }),
    ).rejects.toThrow(/bundle write failed/);

    expect(materializeManagedBundle).toHaveBeenCalledTimes(1);
    expect(committedRows).toEqual([]);
  });

  // ─── T3.2: kind propagation + trigger materialisation ────────────────────

  it("T3.2: sets kind='aoa' when template declares aoa.kind='aoa'", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          schemaVersion: "agent.v1",
          id: "aoa-curated/commander",
          name: "Commander",
          description: "Coordination crew agent",
          instructions: { type: "inline", content: "Coordinate." },
          aoa: { kind: "aoa", install: { defaultRole: "general" } },
        }),
    })) as any;

    await installAgent({
      catalogItem: AGENT_TEMPLATE,
      companyId: "c1",
      db: mockDb as any,
      desiredName: "Commander",
    });

    expect(insertedRow.kind).toBe("aoa");
  });

  it("T3.2: kind defaults to 'org' when aoa.kind is absent", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          schemaVersion: "agent.v1",
          id: "aoa-curated/engineer",
          name: "Engineer",
          description: "Regular engineer",
          instructions: { type: "inline", content: "Build." },
          aoa: { install: { defaultRole: "engineer" } },
        }),
    })) as any;

    await installAgent({
      catalogItem: AGENT_TEMPLATE,
      companyId: "c1",
      db: mockDb as any,
      desiredName: "Engineer",
    });

    expect(insertedRow.kind).toBe("org");
  });

  it("T3.2: inserts one trigger row per declared trigger; org-kind agents insert none", async () => {
    const triggerInserts: any[] = [];
    const dbWithTriggerTracking = {
      insert: (_table: any) => ({
        values: (row: any) => {
          // Distinguish agent vs trigger rows by the presence of 'agentId'+'kind'
          if (row.agentId !== undefined && row.kind !== undefined && row.enabled !== undefined) {
            triggerInserts.push(row);
            return { returning: () => Promise.resolve([]) };
          }
          insertedRow = row;
          return { returning: () => Promise.resolve([{ ...row, id: "agent-uuid-t3" }]) };
        },
      }),
      select: crewConfigSelect,
      transaction: async (cb: any) => cb(dbWithTriggerTracking),
    };

    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          schemaVersion: "agent.v1",
          id: "aoa-curated/commander",
          name: "Commander",
          description: "Crew commander",
          instructions: { type: "inline", content: "Coordinate." },
          aoa: {
            kind: "aoa",
            triggers: [
              { kind: "mention", config: { priority: "high" } },
              { kind: "outbox" },
            ],
            install: { defaultRole: "general" },
          },
        }),
    })) as any;

    await installAgent({
      catalogItem: AGENT_TEMPLATE,
      companyId: "c1",
      db: dbWithTriggerTracking as any,
      desiredName: "Commander",
    });

    expect(triggerInserts).toHaveLength(2);
    expect(triggerInserts[0]).toMatchObject({
      companyId: "c1",
      agentId: "agent-uuid-t3",
      kind: "mention",
      enabled: true,
      config: { priority: "high" },
    });
    expect(triggerInserts[1]).toMatchObject({
      companyId: "c1",
      agentId: "agent-uuid-t3",
      kind: "outbox",
      enabled: true,
      config: {},
    });
  });
});
