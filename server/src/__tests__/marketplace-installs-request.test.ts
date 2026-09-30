import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Pure-function tests — no mocks needed ────────────────────────────────────

import { resolveInstallDecision, canInstallType } from "../routes/marketplace-installs.js";

describe("canInstallType", () => {
  it("founder can install anything", () => {
    expect(canInstallType("founder", "plugin", false)).toBe(true);
    expect(canInstallType("founder", "skill", false)).toBe(true);
  });

  it("team_lead can install skill/agent/team always", () => {
    expect(canInstallType("team_lead", "skill", false)).toBe(true);
    expect(canInstallType("team_lead", "agent", false)).toBe(true);
    expect(canInstallType("team_lead", "team", false)).toBe(true);
  });

  it("team_lead can only install plugin when allowTeamLeadPlugins=true", () => {
    expect(canInstallType("team_lead", "plugin", false)).toBe(false);
    expect(canInstallType("team_lead", "plugin", true)).toBe(true);
  });

  it("team_member cannot install anything via canInstallType", () => {
    expect(canInstallType("team_member", "skill", true)).toBe(false);
    expect(canInstallType("team_member", "plugin", true)).toBe(false);
  });
});

describe("resolveInstallDecision", () => {
  const settings = { allowTeamLeadPlugins: false, teamMemberCanRequestInstall: true, requireFounderApproval: false };

  it("returns 'allow' for founder", () => {
    expect(resolveInstallDecision("founder", "skill", settings)).toBe("allow");
  });

  it("returns 'allow' for team_lead on skill", () => {
    expect(resolveInstallDecision("team_lead", "skill", settings)).toBe("allow");
  });

  it("returns 'request' for team_member when teamMemberCanRequestInstall=true", () => {
    expect(resolveInstallDecision("team_member", "skill", settings)).toBe("request");
  });

  it("returns 'deny' for team_member when teamMemberCanRequestInstall=false", () => {
    const noRequest = { ...settings, teamMemberCanRequestInstall: false };
    expect(resolveInstallDecision("team_member", "skill", noRequest)).toBe("deny");
  });

  it("returns 'deny' for team_lead trying plugin with allowTeamLeadPlugins=false", () => {
    expect(resolveInstallDecision("team_lead", "plugin", settings)).toBe("deny");
  });

  describe("requireFounderApproval", () => {
    const strictSettings = {
      allowTeamLeadPlugins: true,
      teamMemberCanRequestInstall: true,
      requireFounderApproval: true,
    };

    it("returns 'request' for team_lead when requireFounderApproval=true", () => {
      expect(resolveInstallDecision("team_lead", "skill", strictSettings)).toBe("request");
    });

    it("returns 'request' for team_lead on plugin when requireFounderApproval=true (even if allowTeamLeadPlugins=true)", () => {
      expect(resolveInstallDecision("team_lead", "plugin", strictSettings)).toBe("request");
    });

    it("returns 'allow' for founder even when requireFounderApproval=true", () => {
      expect(resolveInstallDecision("founder", "skill", strictSettings)).toBe("allow");
    });

    it("returns 'allow' for team_lead when requireFounderApproval=false", () => {
      const noApproval = { ...strictSettings, requireFounderApproval: false };
      expect(resolveInstallDecision("team_lead", "skill", noApproval)).toBe("allow");
    });
  });
});

// ─── Route-level: request path persists + notifies ───────────────────────────

vi.mock("../routes/authz.js", () => ({
  assertBoard: vi.fn(),
  assertCompanyAccess: vi.fn(),
}));
vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return { marketplaceInstallOperations: tableProxy, userRoles: tableProxy };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("eq"),
  and: () => Symbol("and"),
  isNull: () => Symbol("isNull"),
}));
vi.mock("../services/marketplace-install/index.js", () => ({
  startInstallOperation: vi.fn().mockResolvedValue({ id: "op-request-uuid", status: "pending" }),
  dispatchInstall: vi.fn(),
  installSkill: vi.fn(),
  installAgent: vi.fn(),
  installTeam: vi.fn(),
  installMarketplacePlugin: vi.fn(),
  findOperationById: vi.fn(),
  resolveInstallPlan: vi.fn(),
  updateOperation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/agent-instructions.js", () => ({
  agentInstructionsService: vi.fn(() => ({ materializeManagedBundle: vi.fn() })),
}));
vi.mock("../adapters/index.js", () => ({
  listServerAdapters: vi.fn(() => [{ type: "codex" }, { type: "claude" }]),
}));
vi.mock("../services/marketplace-notifications.js", () => ({
  marketplaceNotifications: {
    installRequested: vi.fn().mockResolvedValue(undefined),
    installCompleted: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../services/permissions.js", () => ({
  permissionService: vi.fn(() => ({
    getEffectiveRole: vi.fn().mockResolvedValue("team_member"),
  })),
}));
vi.mock("../services/marketplace-settings.js", () => ({
  marketplaceSettingsService: vi.fn(() => ({
    get: vi.fn().mockResolvedValue({
      allowTeamLeadPlugins: false,
      teamMemberCanRequestInstall: true,
      requireFounderApproval: false,
    }),
  })),
}));
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../middleware/logger.js", () => ({ logger: { error: vi.fn() } }));

import { createMarketplaceInstallRouter } from "../routes/marketplace-installs.js";
import { startInstallOperation } from "../services/marketplace-install/index.js";
import { dispatchInstall } from "../services/marketplace-install/index.js";
import { updateOperation } from "../services/marketplace-install/index.js";
import { marketplaceNotifications } from "../services/marketplace-notifications.js";
import express from "express";
import request from "supertest";

const MOCK_CATALOG_ITEM = {
  id: "skill:aoa-curated/code-review",
  type: "skill" as const,
  name: "Code Review",
  description: "...",
  version: "1.0.0",
  source: { adapter: "aoa-curated", url: "...", locator: "...", commitSha: "abc" },
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-04-30T00:00:00Z",
  category: "engineering",
  tags: [],
};

const MOCK_AGENT_ITEM = {
  id: "agent:aoa-curated/senior-engineer",
  type: "agent" as const,
  name: "Senior Engineer",
  description: "...",
  version: "1.0.0",
  source: { adapter: "aoa-curated", url: "...", locator: "...", commitSha: "abc" },
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-04-30T00:00:00Z",
  category: "engineering",
  tags: [],
};

const MOCK_CATALOG = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-04-30T00:00:00Z",
  itemCount: 1,
  items: [MOCK_CATALOG_ITEM],
};

function buildApp(opts: {
  catalog?: typeof MOCK_CATALOG;
  actor?: Record<string, unknown>;
} = {}) {
  const mockDb = {} as any;
  const mockCatalogService = { readCache: vi.fn().mockResolvedValue(opts.catalog ?? MOCK_CATALOG) };
  const mockPluginLoader = {} as any;

  const app = express();
  app.use(express.json());

  // Attach a fake actor that satisfies assertBoard (mocked to no-op but actor still read directly)
  app.use("/api/companies/:companyId/marketplace", (req, _res, next) => {
    (req as any).actor = opts.actor ?? {
      type: "board",
      source: "cloud_auth",
      isInstanceAdmin: false,
      userId: "user-team-member",
    };
    next();
  });

  app.use(
    "/api/companies/:companyId/marketplace",
    createMarketplaceInstallRouter({
      db: mockDb,
      catalogService: mockCatalogService as any,
      pluginLoader: mockPluginLoader,
    }),
  );

  return app;
}

describe("POST /install — decision=request path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 202 with operationId and queued:true", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/companies/c1/marketplace/install")
      .send({ catalogItemId: "skill:aoa-curated/code-review" });

    expect(res.status).toBe(202);
    expect(res.body.operationId).toBe("op-request-uuid");
    expect(res.body.queued).toBe(true);
    expect(res.body.status).toBe("requested");
  });

  it("calls startInstallOperation to persist the pending row", async () => {
    const app = buildApp();
    await request(app)
      .post("/api/companies/c1/marketplace/install")
      .send({ catalogItemId: "skill:aoa-curated/code-review" });

    expect(startInstallOperation).toHaveBeenCalledOnce();
  });

  it("fires installRequested notification with correct item name and userId", async () => {
    const app = buildApp();
    await request(app)
      .post("/api/companies/c1/marketplace/install")
      .send({ catalogItemId: "skill:aoa-curated/code-review" });

    expect(marketplaceNotifications.installRequested).toHaveBeenCalledOnce();
    const [, , itemName, requestingUserId, opId] = vi.mocked(marketplaceNotifications.installRequested).mock.calls[0];
    expect(itemName).toBe("Code Review");
    expect(requestingUserId).toBe("user-team-member");
    expect(opId).toBe("op-request-uuid");
  });

  it("returns 500 with structured error when startInstallOperation throws", async () => {
    vi.mocked(startInstallOperation).mockRejectedValueOnce(new Error("DB connection lost"));
    const app = buildApp();
    const res = await request(app)
      .post("/api/companies/c1/marketplace/install")
      .send({ catalogItemId: "skill:aoa-curated/code-review" });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to queue install request/i);
  });

  it("does NOT call dispatchInstall (request stays pending for founder review)", async () => {
    const app = buildApp();
    await request(app)
      .post("/api/companies/c1/marketplace/install")
      .send({ catalogItemId: "skill:aoa-curated/code-review" });

    expect(dispatchInstall).not.toHaveBeenCalled();
  });

  it("transitions the operation to status='requested' so polling clients see a terminal state", async () => {
    const app = buildApp();
    await request(app)
      .post("/api/companies/c1/marketplace/install")
      .send({ catalogItemId: "skill:aoa-curated/code-review" });

    expect(updateOperation).toHaveBeenCalledOnce();
    const [, , patch] = vi.mocked(updateOperation).mock.calls[0];
    expect(patch.status).toBe("requested");
    expect(patch.completedAt).toBeInstanceOf(Date);
  });
});

describe("POST /install - agent overrides", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes selected role and adapter type into dispatchInstall for agent installs", async () => {
    const app = buildApp({
      catalog: { ...MOCK_CATALOG, itemCount: 1, items: [MOCK_AGENT_ITEM] },
      actor: {
        type: "board",
        source: "local_implicit",
        isInstanceAdmin: false,
        userId: "user-founder",
      },
    });

    const res = await request(app)
      .post("/api/companies/c1/marketplace/install")
      .send({
        catalogItemId: "agent:aoa-curated/senior-engineer",
        targetDepartmentId: "11111111-1111-4111-8111-111111111111",
        role: "lead",
        adapterType: "claude",
      });

    expect(res.status).toBe(202);
    expect(dispatchInstall).toHaveBeenCalledOnce();
    const [dispatchOpts] = vi.mocked(dispatchInstall).mock.calls[0];
    expect(dispatchOpts.installOverrides).toEqual({ role: "lead", adapterType: "claude" });
  });
});
