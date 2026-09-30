import { describe, it, expect, vi } from "vitest";

// Drizzle ESM cycle workaround (per CLAUDE.md shared test patterns)
vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return {
    agents: tableProxy,
    teams: tableProxy,
    companySkills: tableProxy,
    plugins: tableProxy,
    projects: tableProxy,
    marketplaceInstallOperations: tableProxy,
  };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("op:eq"),
  and: () => Symbol("op:and"),
}));
vi.mock("../services/marketplace-install/fetch-resource.js", () => ({
  fetchCatalogResource: vi.fn(),
}));

import { classifyAction, resolveInstallPlan } from "../services/marketplace-install/resolver.js";
import { fetchCatalogResource } from "../services/marketplace-install/fetch-resource.js";
import {
  SLACK_PLUGIN,
  ENGINEER_TEAM,
  REQUIRED_AGENT,
  REQUIRED_SKILL,
  FULL_CATALOG,
  mockEmptyDb,
  mockDbWithRow,
} from "./__fixtures__/marketplace-catalog.js";

describe("resolveInstallPlan", () => {
  it("returns single-step plan for a leaf item (plugin) not yet installed", async () => {
    const plan = await resolveInstallPlan({
      catalogItemId: SLACK_PLUGIN.id,
      catalog: FULL_CATALOG,
      db: mockEmptyDb() as any,
      companyId: "c1",
    });

    expect(plan.rootItem.id).toBe(SLACK_PLUGIN.id);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].catalogItemId).toBe(SLACK_PLUGIN.id);
    expect(plan.steps[0].action).toBe("install-new");
    expect(plan.conflicts).toEqual([]);
  });

  it("expands team install into plugin + skills + agents cascade", async () => {
    const plan = await resolveInstallPlan({
      catalogItemId: ENGINEER_TEAM.id,
      catalog: FULL_CATALOG,
      db: mockEmptyDb() as any,
      companyId: "c1",
    });

    const stepIds = plan.steps.map((s) => s.catalogItemId);
    expect(stepIds).toContain(ENGINEER_TEAM.id);
    expect(stepIds).toContain("plugin:aoa-curated/aoa-plugin-github-issues");
    expect(stepIds).toContain("agent:aoa-curated/engineer");
    expect(stepIds).toContain("skill:aoa-curated/code-review");
  });

  it("marks plugin as skip-already-installed if at same version", async () => {
    const db = mockDbWithRow({ id: "plugin-row-1", packageName: "aoa-plugin-slack", version: "1.0.0", status: "ready" });

    const plan = await resolveInstallPlan({
      catalogItemId: SLACK_PLUGIN.id,
      catalog: FULL_CATALOG,
      db: db as any,
      companyId: "c1",
    });

    expect(plan.steps[0].action).toBe("skip-already-installed");
  });

  it("throws on unknown catalogItemId", async () => {
    await expect(
      resolveInstallPlan({
        catalogItemId: "unknown:item",
        catalog: FULL_CATALOG,
        db: mockEmptyDb() as any,
        companyId: "c1",
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("includes agent install preview for direct agent installs", async () => {
    vi.mocked(fetchCatalogResource).mockResolvedValueOnce(JSON.stringify({
      schemaVersion: "agent.v1",
      id: "engineer",
      name: "Engineer",
      description: "Senior engineer agent",
      instructions: { type: "inline", content: "You are a senior engineer." },
      aoa: {
        adapterCompatibility: {
          recommended: "codex",
          supported: ["codex", "claude"],
        },
        install: {
          defaultRole: "lead",
          defaultStatus: "active",
        },
        setup: {
          secrets: [{
            key: "GITHUB_TOKEN",
            label: "GitHub token",
            required: true,
            reason: "Needed to inspect private repositories.",
            usedBy: "github",
          }],
        },
      },
    }));

    const plan = await resolveInstallPlan({
      catalogItemId: REQUIRED_AGENT.id,
      catalog: FULL_CATALOG,
      db: mockEmptyDb() as any,
      companyId: "c1",
      availableAdapterTypes: ["codex"],
    });

    expect(plan.agentInstall).toMatchObject({
      suggestedRole: "lead",
      supportedRoles: ["cxo", "lead", "general"],
      suggestedAdapterType: "codex",
      supportedAdapterTypes: ["codex", "claude"],
      availableAdapterTypes: ["codex"],
      setupRequired: true,
    });
    expect(plan.agentInstall?.setupRequirements).toHaveLength(1);
    expect(plan.agentInstall?.setupRequirements[0]).toMatchObject({
      kind: "secret",
      key: "GITHUB_TOKEN",
      required: true,
    });
  });
});

describe("classifyAction", () => {
  // Plugin
  it("plugin: returns install-new when not installed", async () => {
    const r = await classifyAction({ item: SLACK_PLUGIN, db: mockEmptyDb() as any, companyId: "c1" });
    expect(r.action).toBe("install-new");
  });
  it("plugin: returns fail-version-mismatch when different version installed", async () => {
    const db = mockDbWithRow({ id: "p1", packageName: "aoa-plugin-slack", version: "0.9.0", status: "ready" });
    const r = await classifyAction({ item: SLACK_PLUGIN, db: db as any, companyId: "c1" });
    expect(r.action).toBe("fail-version-mismatch");
    expect(r.reason).toContain("0.9.0");
  });
  it("plugin: throws on missing npm field (catalog defect)", async () => {
    const broken = { ...SLACK_PLUGIN, npm: undefined };
    await expect(
      classifyAction({ item: broken as any, db: mockEmptyDb() as any, companyId: "c1" }),
    ).rejects.toThrow(/missing required 'npm' field/);
  });

  // Skill
  it("skill: returns install-new when not installed", async () => {
    const r = await classifyAction({ item: REQUIRED_SKILL, db: mockEmptyDb() as any, companyId: "c1" });
    expect(r.action).toBe("install-new");
  });
  it("skill: returns skip-already-installed when same version installed", async () => {
    const db = mockDbWithRow({ id: "s1", sourceRef: "1.0.0", sourceLocator: REQUIRED_SKILL.id });
    const r = await classifyAction({ item: REQUIRED_SKILL, db: db as any, companyId: "c1" });
    expect(r.action).toBe("skip-already-installed");
  });
  it("skill: returns fail-version-mismatch when different version installed", async () => {
    const db = mockDbWithRow({ id: "s1", sourceRef: "0.5.0", sourceLocator: REQUIRED_SKILL.id });
    const r = await classifyAction({ item: REQUIRED_SKILL, db: db as any, companyId: "c1" });
    expect(r.action).toBe("fail-version-mismatch");
  });

  // Agent
  it("agent: returns install-new when not installed", async () => {
    const r = await classifyAction({ item: REQUIRED_AGENT, db: mockEmptyDb() as any, companyId: "c1" });
    expect(r.action).toBe("install-new");
  });
  it("agent: returns skip-already-installed when same version installed", async () => {
    const db = mockDbWithRow({ id: "a1", templateOrigin: REQUIRED_AGENT.id, templateVersion: "1.0.0" });
    const r = await classifyAction({ item: REQUIRED_AGENT, db: db as any, companyId: "c1" });
    expect(r.action).toBe("skip-already-installed");
  });
  it("agent: returns fail-version-mismatch when different version installed", async () => {
    const db = mockDbWithRow({ id: "a1", templateOrigin: REQUIRED_AGENT.id, templateVersion: "0.5.0" });
    const r = await classifyAction({ item: REQUIRED_AGENT, db: db as any, companyId: "c1" });
    expect(r.action).toBe("fail-version-mismatch");
  });

  // Team
  it("team: returns install-new when not installed", async () => {
    const r = await classifyAction({ item: ENGINEER_TEAM, db: mockEmptyDb() as any, companyId: "c1" });
    expect(r.action).toBe("install-new");
  });
  it("team: returns skip-already-installed when same version installed", async () => {
    const db = mockDbWithRow({ id: "t1", templateOrigin: ENGINEER_TEAM.id, templateVersion: "1.0.0" });
    const r = await classifyAction({ item: ENGINEER_TEAM, db: db as any, companyId: "c1" });
    expect(r.action).toBe("skip-already-installed");
  });
  it("team: returns fail-version-mismatch when different version installed", async () => {
    const db = mockDbWithRow({ id: "t1", templateOrigin: ENGINEER_TEAM.id, templateVersion: "0.5.0" });
    const r = await classifyAction({ item: ENGINEER_TEAM, db: db as any, companyId: "c1" });
    expect(r.action).toBe("fail-version-mismatch");
  });

  // Unknown type
  it("throws on unknown item type", async () => {
    const broken = { ...SLACK_PLUGIN, type: "unknown-type" as any };
    await expect(
      classifyAction({ item: broken, db: mockEmptyDb() as any, companyId: "c1" }),
    ).rejects.toThrow(/Unknown item type/);
  });
});
