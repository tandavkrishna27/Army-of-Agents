import { describe, expect, it, vi } from "vitest";

type ProjectRow = {
  id: string;
  companyId: string;
  name: string;
  type: "department" | "project";
  description: string | null;
  status: string;
  color: string | null;
  targetDate: string | null;
  leadAgentId: string | null;
  functionType: string | null;
  executionWorkspacePolicy: Record<string, unknown> | null;
  archivedAt: Date | null;
};

function makeProject(overrides: Partial<ProjectRow> & { id: string; name: string }): ProjectRow {
  return {
    companyId: SRC_CO_ID,
    type: "department",
    description: null,
    status: "backlog",
    color: null,
    targetDate: null,
    leadAgentId: null,
    functionType: "general",
    executionWorkspacePolicy: null,
    archivedAt: null,
    ...overrides,
  };
}

const SRC_CO_ID = "11111111-1111-4111-8111-111111111111";
const TGT_CO_ID = "22222222-2222-4222-8222-222222222222";
const companyStore: Record<string, { id: string; name: string; requireBoardApprovalForNewAgents?: boolean }> = {
  [SRC_CO_ID]: { id: SRC_CO_ID, name: "Source Co", requireBoardApprovalForNewAgents: true },
  [TGT_CO_ID]: { id: TGT_CO_ID, name: "Target Co", requireBoardApprovalForNewAgents: true },
};

let sourceProjects: ProjectRow[] = [];
let targetProjects: ProjectRow[] = [];
const createCalls: Array<{ companyId: string; data: any }> = [];
const updateCalls: Array<{ id: string; data: any }> = [];

vi.mock("../services/companies.js", () => ({
  companyService: () => ({
    getById: vi.fn(async (id: string) => companyStore[id] ?? null),
    create: vi.fn(async (input: { name: string }) => ({ id: "new-co", name: input.name })),
    // P3: importBundle creates via the atomic `createWithOperator`.
    createWithOperator: vi.fn(async (input: { name: string }, _opts: any, ownerUserId: any, buildAccess: any) => {
      const company = { id: "new-co", name: input.name };
      const operatorId = await buildAccess(undefined).ensureRealOperator(company.id, ownerUserId ?? null);
      return { company, operatorId };
    }),
    update: vi.fn(async (id: string, patch: any) => ({ id, name: patch.name ?? companyStore[id]?.name ?? "Co" })),
  }),
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => ({
    backfillHumanAtTop: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    create: vi.fn(),
    update: vi.fn(),
  }),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => ({
    ensureMembership: vi.fn(async () => undefined),
    ensureRealOperator: vi.fn(async () => "operator-user-id"),
  }),
}));

vi.mock("../services/projects.js", () => ({
  projectService: () => ({
    list: vi.fn(async (companyId: string) => {
      if (companyId === SRC_CO_ID) return sourceProjects;
      if (companyId === TGT_CO_ID) return targetProjects;
      return [];
    }),
    create: vi.fn(async (companyId: string, data: any) => {
      createCalls.push({ companyId, data });
      const row = makeProject({
        id: `new-${createCalls.length}`,
        companyId,
        name: data.name,
        type: data.type ?? "department",
        description: data.description ?? null,
        status: data.status ?? "backlog",
        color: data.color ?? null,
        targetDate: data.targetDate ?? null,
        leadAgentId: data.leadAgentId ?? null,
        functionType: data.functionType ?? "general",
        executionWorkspacePolicy: data.executionWorkspacePolicy ?? null,
      });
      targetProjects.push(row);
      return row;
    }),
    update: vi.fn(async (id: string, data: any) => {
      updateCalls.push({ id, data });
      const row = targetProjects.find((p) => p.id === id) ?? null;
      if (row) Object.assign(row, data);
      return row;
    }),
  }),
}));

import { companyPortabilityService } from "../services/company-portability.js";
import type { CompanyPortabilityManifest } from "@armyofagents/shared";

function buildInlineSource(
  manifest: CompanyPortabilityManifest,
  files: Record<string, string> = { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" },
) {
  return {
    source: { type: "inline" as const, manifest, files },
    target: { mode: "new_company" as const, newCompanyName: "Imported Co" },
    include: { company: true, agents: false, projects: true },
  };
}

function baseManifest(projects?: any[]): CompanyPortabilityManifest {
  return {
    schemaVersion: 2,
    generatedAt: "2026-04-21T00:00:00.000Z",
    source: null,
    includes: { company: true, agents: false, projects: projects !== undefined },
    company: {
      path: "COMPANY.md",
      name: "Source Co",
      description: null,
      brandColor: null,
      requireBoardApprovalForNewAgents: true,
    },
    agents: [],
    projects,
    requiredSecrets: [],
  };
}

describe("company-portability projects", () => {
  const svc = companyPortabilityService({ select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) } as any);

  function resetState() {
    sourceProjects = [];
    targetProjects = [];
    createCalls.length = 0;
    updateCalls.length = 0;
  }

  it("exportBundle with include.projects=true serializes all projects with slugs", async () => {
    resetState();
    sourceProjects = [
      makeProject({ id: "p1", name: "Engineering", type: "department" }),
      makeProject({ id: "p2", name: "Marketing", type: "department" }),
      makeProject({
        id: "p3",
        name: "Auth Revamp",
        type: "project",
        description: "Refactor auth",
        color: "blue",
        functionType: "software_development",
        executionWorkspacePolicy: { mode: "per_task" },
      }),
    ];
    const result = await svc.exportBundle(SRC_CO_ID, { include: { projects: true } });
    expect(result.manifest.projects).toHaveLength(3);
    expect(result.manifest.projects!.every((p) => p.slug)).toBe(true);
    const auth = result.manifest.projects!.find((p) => p.name === "Auth Revamp");
    expect(auth).toBeDefined();
    expect(auth!.type).toBe("project");
    expect(auth!.functionType).toBe("software_development");
    expect(auth!.executionWorkspacePolicy).toEqual({ mode: "per_task" });
    expect(auth!.color).toBe("blue");
  });

  it("exportBundle omits projects by default (DEFAULT_INCLUDE.projects=false)", async () => {
    resetState();
    sourceProjects = [makeProject({ id: "p1", name: "Engineering", type: "department" })];
    const result = await svc.exportBundle(SRC_CO_ID, {});
    expect(result.manifest.projects).toBeUndefined();
    expect(result.manifest.includes.projects).toBe(false);
  });

  it("exportBundle bumps schemaVersion to 2 when projects are included", async () => {
    resetState();
    sourceProjects = [makeProject({ id: "p1", name: "Engineering", type: "department" })];
    const withProjects = await svc.exportBundle(SRC_CO_ID, { include: { projects: true } });
    expect(withProjects.manifest.schemaVersion).toBe(2);

    const withoutProjects = await svc.exportBundle(SRC_CO_ID, {});
    expect(withoutProjects.manifest.schemaVersion).toBe(1);
  });

  it("exportBundle distinguishes departments and projects by type field", async () => {
    resetState();
    sourceProjects = [
      makeProject({ id: "d1", name: "Engineering", type: "department" }),
      makeProject({ id: "p1", name: "Auth Revamp", type: "project" }),
    ];
    const result = await svc.exportBundle(SRC_CO_ID, { include: { projects: true } });
    const byType = (result.manifest.projects ?? []).reduce((acc: Record<string, number>, p) => {
      acc[p.type] = (acc[p.type] ?? 0) + 1;
      return acc;
    }, {});
    expect(byType).toEqual({ department: 1, project: 1 });
  });

  it("exportBundle skips archived projects", async () => {
    resetState();
    sourceProjects = [
      makeProject({ id: "d1", name: "Live", type: "department" }),
      makeProject({ id: "d2", name: "Archived", type: "department", archivedAt: new Date() }),
    ];
    const result = await svc.exportBundle(SRC_CO_ID, { include: { projects: true } });
    expect(result.manifest.projects!.map((p) => p.name)).toEqual(["Live"]);
  });

  it("previewImport reports project collision with existing slug (skip strategy)", async () => {
    resetState();
    targetProjects = [makeProject({ id: "t1", companyId: TGT_CO_ID, name: "Engineering", type: "department" })];
    const manifest = baseManifest([
      {
        slug: "engineering",
        name: "Engineering",
        type: "department",
      },
    ]);
    const preview = await svc.previewImport({
      source: { type: "inline", manifest, files: { "COMPANY.md": "" } },
      target: { mode: "existing_company", companyId: TGT_CO_ID },
      include: { company: false, agents: false, projects: true },
      collisionStrategy: "skip",
    });
    const plan = preview.plan.projectPlans.find((p) => p.slug === "engineering");
    expect(plan?.action).toBe("skip");
    expect(plan?.existingProjectId).toBe("t1");
  });

  it("importBundle inserts departments before projects (topological order)", async () => {
    resetState();
    const manifest = baseManifest([
      {
        slug: "auth-revamp",
        name: "Auth Revamp",
        type: "project",
        parentSlug: "engineering",
      },
      {
        slug: "engineering",
        name: "Engineering",
        type: "department",
      },
    ]);
    await svc.importBundle(buildInlineSource(manifest), "user-1");
    const names = createCalls.map((c) => c.data.name);
    const deptIdx = names.indexOf("Engineering");
    const projIdx = names.indexOf("Auth Revamp");
    expect(deptIdx).toBeGreaterThanOrEqual(0);
    expect(projIdx).toBeGreaterThan(deptIdx);
  });

  it("authorizes only completion-policy fields actually selected for import", async () => {
    resetState();
    const contexts: Array<{ changesCompletionPolicy: boolean }> = [];
    const manifest = baseManifest([
      {
        slug: "engineering",
        name: "Engineering",
        type: "department",
      },
    ]);

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { company: false, agents: false, projects: true },
      },
      "user-1",
      async (context) => {
        contexts.push(context);
      },
    );

    expect(contexts).toEqual([
      expect.objectContaining({ changesCompletionPolicy: false }),
    ]);
  });

  it("runs import authorization before mutating selected completion governance", async () => {
    resetState();
    const manifest = baseManifest([
      {
        slug: "engineering",
        name: "Engineering",
        type: "department",
        agentCompletionPolicyDefault: "agent_can_complete",
      },
    ]);

    await expect(
      svc.importBundle(
        {
          source: { type: "inline", manifest, files: { "COMPANY.md": "" } },
          target: { mode: "existing_company", companyId: TGT_CO_ID },
          include: { company: false, agents: false, projects: true },
        },
        "user-1",
        async (context) => {
          expect(context.changesCompletionPolicy).toBe(true);
          throw new Error("not authorized");
        },
      ),
    ).rejects.toThrow("not authorized");
    expect(createCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
  });

  it("does not authorize completion governance for collision entries that will be skipped", async () => {
    resetState();
    targetProjects = [
      makeProject({ id: "t1", companyId: TGT_CO_ID, name: "Engineering", type: "department" }),
    ];
    const manifest = baseManifest([
      {
        slug: "engineering",
        name: "Engineering",
        type: "department",
        agentCompletionPolicyDefault: "agent_can_complete",
      },
    ]);
    const contexts: Array<{ changesCompletionPolicy: boolean }> = [];

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { company: false, agents: false, projects: true },
        collisionStrategy: "skip",
      },
      "user-1",
      async (context) => {
        contexts.push(context);
      },
    );

    expect(contexts).toEqual([
      expect.objectContaining({
        changesCompletionPolicy: false,
        requiresTaskAssignmentPermission: false,
      }),
    ]);
  });

  it("importBundle applies collision strategy 'rename' to duplicate project slugs", async () => {
    resetState();
    targetProjects = [makeProject({ id: "t1", companyId: TGT_CO_ID, name: "Engineering", type: "department" })];
    const manifest = baseManifest([
      {
        slug: "engineering",
        name: "Engineering",
        type: "department",
      },
    ]);
    const result = await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { company: false, agents: false, projects: true },
        collisionStrategy: "rename",
      },
      "user-1",
    );
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.data.name).not.toBe("Engineering");
    expect(result.projects.some((p) => p.action === "created")).toBe(true);
  });

  it("importBundle applies collision strategy 'replace' by updating existing project", async () => {
    resetState();
    targetProjects = [
      makeProject({ id: "t1", companyId: TGT_CO_ID, name: "Engineering", type: "department", description: "old" }),
    ];
    const manifest = baseManifest([
      {
        slug: "engineering",
        name: "Engineering",
        type: "department",
        description: "new",
      },
    ]);
    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { company: false, agents: false, projects: true },
        collisionStrategy: "replace",
      },
      "user-1",
    );
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.id).toBe("t1");
    expect(updateCalls[0]!.data.description).toBe("new");
    expect(createCalls).toHaveLength(0);
  });

  it("importBundle applies collision strategy 'skip' and does not modify existing project", async () => {
    resetState();
    targetProjects = [makeProject({ id: "t1", companyId: TGT_CO_ID, name: "Engineering", type: "department" })];
    const manifest = baseManifest([
      { slug: "engineering", name: "Engineering", type: "department" },
    ]);
    const result = await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { company: false, agents: false, projects: true },
        collisionStrategy: "skip",
      },
      "user-1",
    );
    expect(createCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
    expect(result.projects[0]?.action).toBe("skipped");
  });

  it("export → import roundtrip yields zero warnings for the projects section", async () => {
    resetState();
    sourceProjects = [
      makeProject({ id: "p1", name: "Engineering", type: "department" }),
      makeProject({
        id: "p2",
        name: "Auth Revamp",
        type: "project",
        description: "Refactor auth",
        color: "blue",
        functionType: "software_development",
      }),
    ];
    const exported = await svc.exportBundle(SRC_CO_ID, { include: { projects: true } });
    // fresh empty target
    targetProjects = [];
    const result = await svc.importBundle(
      {
        source: {
          type: "inline",
          manifest: exported.manifest,
          files: exported.files,
        },
        target: { mode: "new_company", newCompanyName: "Clone Co" },
        include: { company: true, agents: false, projects: true },
      },
      "user-1",
    );
    expect(result.warnings.filter((w) => w.kind === "unknown_section" && w.section === "projects")).toEqual([]);
    expect(result.projects).toHaveLength(2);
    expect(result.projects.every((p) => p.action === "created")).toBe(true);
  });
});
