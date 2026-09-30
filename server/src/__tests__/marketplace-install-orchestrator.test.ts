import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return {
    marketplaceInstallOperations: tableProxy,
    plugins: tableProxy, agents: tableProxy, teams: tableProxy,
    companySkills: tableProxy, projects: tableProxy,
  };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("op:eq"),
  and: () => Symbol("op:and"),
  gt: () => Symbol("op:gt"),
  like: () => Symbol("op:like"),
}));

import {
  startInstallOperation,
  startPackageInstallOperation,
  dispatchInstall,
  dispatchPackageInstall,
} from "../services/marketplace-install/orchestrator.js";
import { PackageInstallError } from "../services/marketplace-install/package-installer.js";
import type { CatalogItem, MarketplaceCatalogFile, MarketplacePackage } from "@armyofagents/shared";
import { CloudPluginExecutionBlockedError } from "../services/cloud-plugin-execution.js";

const SKILL: CatalogItem = {
  id: "skill:aoa-curated/code-review", type: "skill", name: "Code Review", description: "...", version: "1.0.0",
  source: { adapter: "aoa-curated", url: "...", locator: "...", commitSha: "abc" },
  resourceUrl: "https://.../SKILL.md",
  content: { inline: "# Code Review" },
  trust: { tier: "verified", source: "aoa-curated" }, status: "active",
  addedAt: "2026-04-30T00:00:00Z", category: "engineering", tags: [],
};
const CATALOG: MarketplaceCatalogFile = {
  schemaVersion: "1.0.0", generatedAt: "2026-04-30T00:00:00Z", itemCount: 1, items: [SKILL],
};

const PACKAGE: MarketplacePackage = {
  id: "aoa-curated/package",
  name: "package",
  sourceUrl: "https://github.com/aoa-curated/package",
  memberItemIds: [SKILL.id],
  count: 1,
  verified: true,
  explicit: false,
};

const PACKAGE_OPERATION = {
  id: "op-package-1",
  companyId: "c1",
  catalogItemId: PACKAGE.id,
  itemType: "package" as const,
  targetDepartmentId: null,
  status: "pending" as const,
  resultEntityId: null,
  errorMessage: null,
  cascadeResults: null,
  idempotencyKey: "pkg-key",
  requestedByUserId: "u1",
  startedAt: new Date("2026-04-30T00:00:00Z"),
  completedAt: null,
  createdAt: new Date("2026-04-30T00:00:00Z"),
};

describe("startInstallOperation", () => {
  let insertedOps: any[] = [];
  const mockDb = {
    insert: () => ({
      values: (row: any) => {
        insertedOps.push(row);
        return { onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ ...row, id: "op-uuid-1" }]) }) };
      },
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
  };

  beforeEach(() => { insertedOps = []; });

  it("creates an operation row with status=pending", async () => {
    const op = await startInstallOperation({
      request: { catalogItemId: SKILL.id, targetDepartmentId: "dept-1" },
      catalogItem: SKILL, companyId: "c1", requestedByUserId: "u1", db: mockDb as any,
    });
    expect(insertedOps).toHaveLength(1);
    expect(insertedOps[0].status).toBe("pending");
    expect(insertedOps[0].catalogItemId).toBe(SKILL.id);
    expect(insertedOps[0].itemType).toBe("skill");
    expect(insertedOps[0].targetDepartmentId).toBe("dept-1");
    expect(op.id).toBe("op-uuid-1");
  });

  it("idempotency: returns existing op if idempotencyKey matches in last 24h", async () => {
    const dbWithExisting = {
      ...mockDb,
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ id: "existing-op", status: "success", idempotencyKey: "abc" }]),
          }),
        }),
      }),
    };
    const op = await startInstallOperation({
      request: { catalogItemId: SKILL.id, idempotencyKey: "abc" },
      catalogItem: SKILL, companyId: "c1", requestedByUserId: "u1", db: dbWithExisting as any,
    });
    expect(insertedOps).toHaveLength(0);
    expect(op.id).toBe("existing-op");
  });
});

describe("startPackageInstallOperation", () => {
  let insertedOps: any[] = [];
  const mockDb = {
    insert: () => ({
      values: (row: any) => {
        insertedOps.push(row);
        return { onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ ...row, id: "op-package-new" }]) }) };
      },
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
  };

  beforeEach(() => { insertedOps = []; });

  it("creates a package operation row with status=pending", async () => {
    const op = await startPackageInstallOperation({
      request: { packageId: PACKAGE.id, catalogItemIds: [SKILL.id] },
      companyId: "c1",
      requestedByUserId: "u1",
      db: mockDb as any,
    });

    expect(insertedOps).toHaveLength(1);
    expect(insertedOps[0]).toMatchObject({
      catalogItemId: PACKAGE.id,
      itemType: "package",
      status: "pending",
      targetDepartmentId: null,
    });
    expect(op.id).toBe("op-package-new");
  });

  it("idempotency: returns existing package op if idempotencyKey matches in last 24h", async () => {
    const dbWithExisting = {
      ...mockDb,
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([PACKAGE_OPERATION]),
          }),
        }),
      }),
    };

    const op = await startPackageInstallOperation({
      request: { packageId: PACKAGE.id, catalogItemIds: [SKILL.id], idempotencyKey: "pkg-key" },
      companyId: "c1",
      requestedByUserId: "u1",
      db: dbWithExisting as any,
    });

    expect(insertedOps).toHaveLength(0);
    expect(op.id).toBe("op-package-1");
  });
});

describe("findOperationById", () => {
  it("returns the row when company matches", async () => {
    const { findOperationById } = await import("../services/marketplace-install/operation-store.js");
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ id: "op-1", companyId: "c1", status: "success" }]),
          }),
        }),
      }),
    };
    const op = await findOperationById(db as any, "op-1", "c1");
    expect(op?.id).toBe("op-1");
  });

  it("returns null when operation belongs to different company (RBAC isolation)", async () => {
    const { findOperationById } = await import("../services/marketplace-install/operation-store.js");
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
    };
    const op = await findOperationById(db as any, "op-1", "wrong-company");
    expect(op).toBeNull();
  });
});

describe("dispatchInstall", () => {
  it("calls installSkill for skill items + updates operation row to success", async () => {
    const installSkillMock = vi.fn(async () => ({ skillId: "skill-uuid-1" }));
    const updateOp = vi.fn(async () => {});
    const publish = vi.fn();

    await dispatchInstall({
      operation: { id: "op-uuid-1", catalogItemId: SKILL.id, itemType: "skill", companyId: "c1", targetDepartmentId: "dept-1" } as any,
      catalogItem: SKILL, catalog: CATALOG, db: {} as any,
      installers: { installSkill: installSkillMock, installAgent: vi.fn(), installTeam: vi.fn(), installPlugin: vi.fn() },
      updateOperation: updateOp, publishLiveEvent: publish,
    });

    expect(installSkillMock).toHaveBeenCalled();
    expect(updateOp).toHaveBeenCalledWith("op-uuid-1", expect.objectContaining({ status: "success", resultEntityId: "skill-uuid-1" }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "marketplace.install.completed" }));
  });

  it("installs direct agent dependencies before creating the agent", async () => {
    const PLUGIN: CatalogItem = {
      id: "plugin:aoa-curated/aoa-plugin-github-issues",
      type: "plugin",
      name: "GitHub Issues",
      description: "...",
      version: "1.0.0",
      source: { adapter: "aoa-curated", url: "...", locator: "...", commitSha: "abc" },
      npm: { packageName: "aoa-plugin-github-issues", version: "1.0.0" },
      trust: { tier: "verified", source: "aoa-curated" },
      status: "active",
      addedAt: "2026-04-30T00:00:00Z",
      category: "integrations",
      tags: [],
    };
    const AGENT: CatalogItem = {
      ...SKILL,
      id: "agent:aoa-curated/github-issue-triager",
      type: "agent",
      name: "GitHub Issue Triager",
      requires: [
        { type: "skill", id: SKILL.id },
        { type: "plugin", id: PLUGIN.id },
      ],
    };
    const callOrder: string[] = [];
    const updateOp = vi.fn(async () => {});

    await dispatchInstall({
      operation: {
        id: "op-1",
        catalogItemId: AGENT.id,
        itemType: "agent",
        companyId: "c1",
        targetDepartmentId: "dept-1",
      } as any,
      catalogItem: AGENT,
      catalog: {
        schemaVersion: "1.0.0",
        generatedAt: "2026-05-14T00:00:00Z",
        itemCount: 3,
        items: [AGENT, SKILL, PLUGIN],
      },
      db: {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]),
          }),
        }),
      } as any,
      installers: {
        installSkill: vi.fn(async () => {
          callOrder.push("skill");
          return { skillId: "skill-row" };
        }),
        installPlugin: vi.fn(async () => {
          callOrder.push("plugin");
          return { pluginId: "plugin-row", alreadyInstalled: false };
        }),
        installAgent: vi.fn(async () => {
          callOrder.push("agent");
          return { agentId: "agent-row" };
        }),
        installTeam: vi.fn(),
      },
      updateOperation: updateOp,
      publishLiveEvent: vi.fn(),
    });

    expect(callOrder).toEqual(["skill", "plugin", "agent"]);
    expect(updateOp).toHaveBeenLastCalledWith("op-1", expect.objectContaining({
      status: "success",
      resultEntityId: "agent-row",
      cascadeResults: expect.arrayContaining([
        expect.objectContaining({ step: "skill-install", itemId: SKILL.id }),
        expect.objectContaining({ step: "plugin-precondition", itemId: PLUGIN.id }),
        expect.objectContaining({ step: "agent-install", itemId: AGENT.id }),
      ]),
    }));
  });

  it("on installer error, updates operation to failure + publishes failed event", async () => {
    const installSkillMock = vi.fn(async () => { throw new Error("fetch failed"); });
    const updateOp = vi.fn(async () => {});
    const publish = vi.fn();

    await dispatchInstall({
      operation: { id: "op-uuid-1", catalogItemId: SKILL.id, itemType: "skill", companyId: "c1" } as any,
      catalogItem: SKILL, catalog: CATALOG, db: {} as any,
      installers: { installSkill: installSkillMock, installAgent: vi.fn(), installTeam: vi.fn(), installPlugin: vi.fn() },
      updateOperation: updateOp, publishLiveEvent: publish,
    });

    expect(updateOp).toHaveBeenCalledWith("op-uuid-1", expect.objectContaining({ status: "failure", errorMessage: "fetch failed" }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "marketplace.install.failed" }));
  });

  it("persists the stable cloud policy code and docs independently of message text", async () => {
    const updateOp = vi.fn(async () => {});
    const pluginItem = { ...SKILL, id: "plugin:test", type: "plugin" as const };

    await dispatchInstall({
      operation: {
        id: "op-cloud",
        catalogItemId: pluginItem.id,
        itemType: "plugin",
        companyId: "c1",
      } as any,
      catalogItem: pluginItem,
      catalog: { ...CATALOG, items: [pluginItem] },
      db: {} as any,
      installers: {
        installSkill: vi.fn(),
        installAgent: vi.fn(),
        installTeam: vi.fn(),
        installPlugin: vi.fn(async () => {
          const err = new CloudPluginExecutionBlockedError();
          err.message = "A future localized diagnostic";
          throw err;
        }),
      },
      updateOperation: updateOp,
      publishLiveEvent: vi.fn(),
    });

    expect(updateOp).toHaveBeenLastCalledWith(
      "op-cloud",
      expect.objectContaining({
        status: "failure",
        errorMessage: "A future localized diagnostic",
        errorCode: "PLUGIN_WORKER_BLOCKED_IN_CLOUD",
        errorDocs: "/docs/guides/cloud-plugin-execution",
      }),
    );
  });

  // T2.3 / D21 (Decision #111): a team install with NO targetDepartmentId is a
  // COMPANY-WIDE install, not an error. The orchestrator used to throw here;
  // that check was a redundant backstop for traffic the route already rejects
  // with a 400 (routes/marketplace-installs.ts, before startInstallOperation),
  // and it blocked the crew bootstrap at company create — which runs before any
  // department exists.
  it("team install with a null targetDepartmentId installs company-wide (D21)", async () => {
    const installTeamMock = vi.fn(async () => ({ teamId: "team-1", cascadeResults: [] }));
    const updateOp = vi.fn(async () => {});
    const publish = vi.fn();

    const TEAM_ITEM = { ...SKILL, id: "team:test", type: "team" as const };

    await dispatchInstall({
      operation: { id: "op-uuid-1", catalogItemId: TEAM_ITEM.id, itemType: "team", companyId: "c1", targetDepartmentId: null } as any,
      catalogItem: TEAM_ITEM,
      catalog: { ...CATALOG, items: [TEAM_ITEM] },
      db: {} as any,
      installers: {
        installSkill: vi.fn(),
        installAgent: vi.fn(),
        installTeam: installTeamMock,
        installPlugin: vi.fn(),
      },
      updateOperation: updateOp,
      publishLiveEvent: publish,
    });

    // The null must be PASSED THROUGH, not defaulted to something — installTeam
    // is what decides company-wide vs departmental.
    expect(installTeamMock).toHaveBeenCalledWith(
      expect.objectContaining({ targetDepartmentId: null, companyId: "c1" }),
    );
    expect(updateOp).toHaveBeenCalledWith("op-uuid-1", expect.objectContaining({
      status: "success",
      resultEntityId: "team-1",
    }));
  });

  // Discriminator for the relaxation above: only NULL is tolerated. A supplied
  // department id must still be forwarded verbatim so installTeam's
  // exists/ownership/type validation runs — relaxing to "ignore the field"
  // would silently turn a bad department id into a company-wide install.
  it("team install with a department id still forwards it (the relaxation is null-only)", async () => {
    const installTeamMock = vi.fn(async () => ({ teamId: "team-2", cascadeResults: [] }));
    const TEAM_ITEM = { ...SKILL, id: "team:test", type: "team" as const };

    await dispatchInstall({
      operation: { id: "op-uuid-2", catalogItemId: TEAM_ITEM.id, itemType: "team", companyId: "c1", targetDepartmentId: "dept-9" } as any,
      catalogItem: TEAM_ITEM,
      catalog: { ...CATALOG, items: [TEAM_ITEM] },
      db: {} as any,
      installers: {
        installSkill: vi.fn(),
        installAgent: vi.fn(),
        installTeam: installTeamMock,
        installPlugin: vi.fn(),
      },
      updateOperation: vi.fn(async () => {}),
      publishLiveEvent: vi.fn(),
    });

    expect(installTeamMock).toHaveBeenCalledWith(
      expect.objectContaining({ targetDepartmentId: "dept-9" }),
    );
  });

  it("publishes started event before installer runs", async () => {
    const events: any[] = [];
    const publish = vi.fn((e) => events.push(e));
    const installSkillMock = vi.fn(async () => {
      // Capture event order: started must come before installer's resolution
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("marketplace.install.started");
      return { skillId: "s1" };
    });

    await dispatchInstall({
      operation: { id: "op-1", catalogItemId: SKILL.id, itemType: "skill", companyId: "c1", targetDepartmentId: "d1" } as any,
      catalogItem: SKILL,
      catalog: CATALOG,
      db: {} as any,
      installers: { installSkill: installSkillMock, installAgent: vi.fn(), installTeam: vi.fn(), installPlugin: vi.fn() },
      updateOperation: vi.fn(),
      publishLiveEvent: publish,
    });

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("marketplace.install.started");
    expect(events[1].type).toBe("marketplace.install.completed");
  });

  it("events carry companyId for per-company SSE routing", async () => {
    const publish = vi.fn();
    await dispatchInstall({
      operation: { id: "op-1", catalogItemId: SKILL.id, itemType: "skill", companyId: "specific-co", targetDepartmentId: "d1" } as any,
      catalogItem: SKILL,
      catalog: CATALOG,
      db: {} as any,
      installers: { installSkill: async () => ({ skillId: "s1" }), installAgent: vi.fn(), installTeam: vi.fn(), installPlugin: vi.fn() },
      updateOperation: vi.fn(),
      publishLiveEvent: publish,
    });

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ companyId: "specific-co" }));
  });
});

describe("dispatchPackageInstall", () => {
  it("dispatches package install operations and records cascade results", async () => {
    const updateOperation = vi.fn().mockResolvedValue(undefined);
    const publishLiveEvent = vi.fn();
    const installSkillPackage = vi.fn().mockResolvedValue({
      installedSkillIds: ["s1"],
      cascadeResults: [
        {
          step: "package-member-skill-install",
          itemId: SKILL.id,
          status: "success",
          resultEntityId: "s1",
          durationMs: 1,
        },
      ],
    });

    await dispatchPackageInstall({
      operation: PACKAGE_OPERATION,
      pkg: PACKAGE,
      memberItems: [SKILL],
      db: {} as any,
      installSkillPackage,
      updateOperation,
      publishLiveEvent,
    });

    expect(updateOperation).toHaveBeenCalledWith("op-package-1", { status: "running" });
    expect(updateOperation).toHaveBeenLastCalledWith("op-package-1", expect.objectContaining({
      status: "success",
      resultEntityId: PACKAGE.id,
      cascadeResults: expect.arrayContaining([
        expect.objectContaining({ itemId: SKILL.id, status: "success" }),
      ]),
    }));
    expect(publishLiveEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "marketplace.install.completed",
    }));
  });

  it("records package cascade failures on operation failure", async () => {
    const updateOperation = vi.fn().mockResolvedValue(undefined);
    const cascadeResults = [
      {
        step: "package-member-skill-install" as const,
        itemId: SKILL.id,
        status: "failure" as const,
        errorMessage: "version mismatch",
        durationMs: 1,
      },
    ];
    const err = new PackageInstallError(
      `Package install failed for ${SKILL.id}: version mismatch`,
      cascadeResults,
    );

    await dispatchPackageInstall({
      operation: PACKAGE_OPERATION,
      pkg: PACKAGE,
      memberItems: [SKILL],
      db: {} as any,
      installSkillPackage: vi.fn().mockRejectedValue(err),
      updateOperation,
      publishLiveEvent: vi.fn(),
    });

    expect(updateOperation).toHaveBeenLastCalledWith("op-package-1", expect.objectContaining({
      status: "failure",
      errorMessage: `Package install failed for ${SKILL.id}: version mismatch`,
      cascadeResults,
    }));
  });
});
