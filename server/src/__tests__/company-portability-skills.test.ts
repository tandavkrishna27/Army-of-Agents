import { describe, expect, it, vi } from "vitest";

type SkillRow = {
  id: string;
  companyId: string;
  key: string;
  slug: string;
  name: string;
  description: string | null;
  markdown: string;
  sourceType: string;
  sourceLocator: string | null;
  sourceRef: string | null;
  trustLevel: string;
  compatibility: string;
  fileInventory: Array<{ path: string; kind: string }>;
  metadata: Record<string, unknown> | null;
  customized: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type AgentRow = {
  id: string;
  companyId: string;
  name: string;
  status: string;
  role: string;
  title: string | null;
  icon: string | null;
  capabilities: string | null;
  reportsTo: string | null;
  parentType: string | null;
  parentId: string | null;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  permissions: Record<string, unknown>;
  budgetMonthlyCents: number;
  metadata: Record<string, unknown> | null;
  skillKeys: string[];
};

const SRC_CO_ID = "11111111-1111-4111-8111-111111111111";
const TGT_CO_ID = "22222222-2222-4222-8222-222222222222";

const companyStore: Record<string, { id: string; name: string; requireBoardApprovalForNewAgents?: boolean }> = {
  [SRC_CO_ID]: { id: SRC_CO_ID, name: "Source Co", requireBoardApprovalForNewAgents: true },
  [TGT_CO_ID]: { id: TGT_CO_ID, name: "Target Co", requireBoardApprovalForNewAgents: true },
};

let sourceSkills: SkillRow[] = [];
let sourceAgents: AgentRow[] = [];
let targetSkills: SkillRow[] = [];
let targetAgents: AgentRow[] = [];
const skillUpsertCalls: Array<{ companyId: string; imports: any[]; policy?: string }> = [];
const agentUpdateCalls: Array<{ id: string; data: any }> = [];
let reverseSkillUpsertResults = false;
let customizeBeforeNextSkillUpsert = false;

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
    list: vi.fn(async (companyId: string) => {
      if (companyId === SRC_CO_ID) return sourceAgents;
      if (companyId === TGT_CO_ID) return targetAgents;
      return [];
    }),
    create: vi.fn(async (companyId: string, data: any) => {
      const row: AgentRow = {
        id: `new-agent-${targetAgents.length + 1}`,
        companyId,
        name: data.name,
        status: "active",
        role: data.role ?? "Engineer",
        title: data.title ?? null,
        icon: data.icon ?? null,
        capabilities: data.capabilities ?? null,
        reportsTo: null,
        parentType: null,
        parentId: null,
        adapterType: data.adapterType ?? "claude_local",
        adapterConfig: data.adapterConfig ?? {},
        runtimeConfig: data.runtimeConfig ?? {},
        permissions: data.permissions ?? {},
        budgetMonthlyCents: data.budgetMonthlyCents ?? 0,
        metadata: data.metadata ?? null,
        skillKeys: Array.isArray(data.skillKeys) ? data.skillKeys : [],
      };
      targetAgents.push(row);
      return row;
    }),
    update: vi.fn(async (id: string, data: any) => {
      agentUpdateCalls.push({ id, data });
      const row = targetAgents.find((a) => a.id === id) ?? null;
      if (row) Object.assign(row, data);
      return row;
    }),
    backfillHumanAtTop: vi.fn(async () => undefined),
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
    list: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: "x" })),
    update: vi.fn(async () => null),
  }),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    list: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: "x" })),
  }),
}));

vi.mock("../services/company-skills.js", () => ({
  normalizeSkillKey: (value: string | null | undefined) => {
    if (!value) return null;
    const segments = value
      .split("/")
      .map((segment) =>
        segment
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, ""),
      )
      .filter(Boolean);
    return segments.length > 0 ? segments.join("/") : null;
  },
  companySkillService: () => ({
    listFull: vi.fn(async (companyId: string) => {
      if (companyId === SRC_CO_ID) return sourceSkills;
      if (companyId === TGT_CO_ID) return targetSkills;
      return [];
    }),
    listFullWithCustomization: vi.fn(async (companyId: string) => {
      if (companyId === SRC_CO_ID) return sourceSkills;
      if (companyId === TGT_CO_ID) return targetSkills;
      return [];
    }),
    upsertImportedSkills: vi.fn(async (companyId: string, imports: any[], policy: string) => {
      skillUpsertCalls.push({ companyId, imports, policy });
      const results: SkillRow[] = [];
      const refused: Array<{
        skillId: string;
        key: string;
        slug: string;
        name: string;
        reason: "customized";
      }> = [];
      for (const imp of imports) {
        const existing = targetSkills.find((s) => s.key === imp.key);
        if (existing) {
          if (policy === "preserve_founder_edits" && customizeBeforeNextSkillUpsert) {
            customizeBeforeNextSkillUpsert = false;
            existing.customized = true;
            existing.markdown = "# concurrent founder bytes\n";
          }
          if (policy === "preserve_founder_edits" && existing.customized) {
            refused.push({
              skillId: existing.id,
              key: existing.key,
              slug: existing.slug,
              name: existing.name,
              reason: "customized",
            });
            continue;
          }
          Object.assign(existing, {
            slug: imp.slug,
            name: imp.name,
            description: imp.description ?? null,
            markdown: imp.markdown ?? "",
            sourceType: imp.sourceType,
            sourceLocator: imp.sourceLocator ?? null,
            sourceRef: imp.sourceRef ?? null,
            trustLevel: imp.trustLevel,
            compatibility: imp.compatibility,
            fileInventory: imp.fileInventory ?? [],
            metadata: imp.metadata ?? null,
            ...(policy === "caller_is_authoritative" ? { customized: false } : {}),
            updatedAt: new Date(),
          });
          results.push(existing);
          continue;
        }
        const row: SkillRow = {
          id: `new-skill-${targetSkills.length + 1}`,
          companyId,
          key: imp.key,
          slug: imp.slug,
          name: imp.name,
          description: imp.description ?? null,
          markdown: imp.markdown ?? "",
          sourceType: imp.sourceType,
          sourceLocator: imp.sourceLocator ?? null,
          sourceRef: imp.sourceRef ?? null,
          trustLevel: imp.trustLevel,
          compatibility: imp.compatibility,
          fileInventory: imp.fileInventory ?? [],
          metadata: imp.metadata ?? null,
          customized: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        targetSkills.push(row);
        results.push(row);
      }
      return {
        skills: reverseSkillUpsertResults ? [...results].reverse() : results,
        refused,
      };
    }),
  }),
}));

import { companyPortabilityService } from "../services/company-portability.js";
import type { CompanyPortabilityManifest } from "@armyofagents/shared";

function resetState() {
  sourceSkills = [];
  sourceAgents = [];
  targetSkills = [];
  targetAgents = [];
  skillUpsertCalls.length = 0;
  agentUpdateCalls.length = 0;
  reverseSkillUpsertResults = false;
  customizeBeforeNextSkillUpsert = false;
}

function makeSkill(overrides: Partial<SkillRow> & { id: string; key: string; name: string }): SkillRow {
  return {
    companyId: SRC_CO_ID,
    slug: overrides.key,
    description: null,
    markdown: "# Skill body\n",
    sourceType: "local_path",
    sourceLocator: null,
    sourceRef: null,
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [],
    metadata: null,
    customized: false,
    createdAt: new Date("2026-04-20T00:00:00Z"),
    updatedAt: new Date("2026-04-20T00:00:00Z"),
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AgentRow> & { id: string; name: string }): AgentRow {
  return {
    companyId: SRC_CO_ID,
    status: "active",
    role: "Engineer",
    title: null,
    icon: null,
    capabilities: null,
    reportsTo: null,
    parentType: null,
    parentId: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
    budgetMonthlyCents: 0,
    metadata: null,
    skillKeys: [],
    ...overrides,
  };
}

function baseManifest(overrides: Partial<CompanyPortabilityManifest> = {}): CompanyPortabilityManifest {
  return {
    schemaVersion: 2,
    generatedAt: "2026-04-21T00:00:00.000Z",
    source: null,
    includes: { company: true, agents: false, projects: false, issues: false, skills: true },
    company: {
      path: "COMPANY.md",
      name: "Source Co",
      description: null,
      brandColor: null,
      requireBoardApprovalForNewAgents: true,
    },
    agents: [],
    requiredSecrets: [],
    ...overrides,
  };
}

function buildInlineSource(
  manifest: CompanyPortabilityManifest,
  include: Partial<{ company: boolean; agents: boolean; projects: boolean; issues: boolean; skills: boolean }> = {
    company: true,
    agents: false,
    projects: false,
    issues: false,
    skills: true,
  },
  files: Record<string, string> = { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" },
  target: { mode: "new_company"; newCompanyName?: string | null } | { mode: "existing_company"; companyId: string } = {
    mode: "new_company" as const,
    newCompanyName: "Imported Co",
  },
  collisionStrategy?: "rename" | "skip" | "replace",
) {
  return {
    source: { type: "inline" as const, manifest, files },
    target,
    include,
    ...(collisionStrategy ? { collisionStrategy } : {}),
  };
}

describe("company-portability skills", () => {
  const svc = companyPortabilityService({ select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) } as any);

  it("exportBundle with include.skills=true serializes all skills with slugs + keys", async () => {
    resetState();
    sourceSkills = [
      makeSkill({ id: "s1", key: "alpha-skill", slug: "alpha-skill", name: "Alpha" }),
      makeSkill({
        id: "s2",
        key: "beta-skill",
        slug: "beta-skill",
        name: "Beta",
        sourceType: "github",
        sourceLocator: "https://github.com/owner/repo/tree/main/skills/beta",
        sourceRef: "abc123",
      }),
    ];
    const result = await svc.exportBundle(SRC_CO_ID, { include: { skills: true } });
    expect(result.manifest.skills).toHaveLength(2);
    const alpha = result.manifest.skills!.find((s) => s.name === "Alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.key).toBe("alpha-skill");
    expect(alpha!.slug).toBe("alpha-skill");
    expect(alpha!.sourceType).toBe("local_path");
    const beta = result.manifest.skills!.find((s) => s.name === "Beta");
    expect(beta!.sourceType).toBe("github");
    expect(beta!.sourceRef).toBe("abc123");
  });

  it("accepts an exported built-in skill through AoA's own import validator", async () => {
    resetState();
    sourceSkills = [
      makeSkill({
        id: "s1",
        key: "skill:aoa/brainstorming",
        slug: "aoa-brainstorming",
        name: "Brainstorming",
        sourceType: "builtin",
      }),
    ];
    const exported = await svc.exportBundle(SRC_CO_ID, { include: { skills: true } });
    const { companyPortabilityPreviewSchema } = await import("@armyofagents/shared");

    const parsed = companyPortabilityPreviewSchema.safeParse(
      buildInlineSource(exported.manifest, undefined, exported.files),
    );

    expect(exported.manifest.skills?.[0]?.sourceType).toBe("builtin");
    expect(parsed.success).toBe(true);
  });

  it("exportBundle omits skills by default (DEFAULT_INCLUDE.skills=false)", async () => {
    resetState();
    sourceSkills = [makeSkill({ id: "s1", key: "alpha", name: "Alpha" })];
    const result = await svc.exportBundle(SRC_CO_ID, {});
    expect(result.manifest.skills).toBeUndefined();
    expect(result.manifest.includes.skills).toBe(false);
  });

  it("exportBundle bumps schemaVersion to 2 when skills are included", async () => {
    resetState();
    sourceSkills = [makeSkill({ id: "s1", key: "alpha", name: "Alpha" })];
    const withSkills = await svc.exportBundle(SRC_CO_ID, { include: { skills: true } });
    expect(withSkills.manifest.schemaVersion).toBe(2);

    const without = await svc.exportBundle(SRC_CO_ID, {});
    expect(without.manifest.schemaVersion).toBe(1);
  });

  it("exportBundle emits skill markdown as files referenced by manifest path", async () => {
    resetState();
    sourceSkills = [
      makeSkill({
        id: "s1",
        key: "alpha",
        slug: "alpha",
        name: "Alpha",
        markdown: "# Alpha\n\nBody text.",
      }),
    ];
    const result = await svc.exportBundle(SRC_CO_ID, { include: { skills: true } });
    const entry = result.manifest.skills![0]!;
    expect(entry.path).toMatch(/^skills\/alpha\/SKILL\.md$/);
    expect(result.files[entry.path]).toBeDefined();
    expect(result.files[entry.path]).toContain("# Alpha");
    expect(result.files[entry.path]).toContain("Body text");
  });

  it("exportBundle includes skillKeys on agent manifest when agent references skills", async () => {
    resetState();
    sourceSkills = [makeSkill({ id: "s1", key: "alpha", name: "Alpha" })];
    sourceAgents = [makeAgent({ id: "a1", name: "Ada", skillKeys: ["alpha"] })];
    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: true, skills: true },
    });
    expect(result.manifest.agents[0]!.skillKeys).toEqual(["alpha"]);
  });

  it("importBundle creates skills with correct source metadata", async () => {
    resetState();
    const manifest = baseManifest({
      skills: [
        {
          key: "alpha",
          slug: "alpha",
          name: "Alpha",
          path: "skills/alpha/SKILL.md",
          description: "A description",
          sourceType: "local_path",
          sourceLocator: null,
          sourceRef: null,
          trustLevel: "markdown_only",
          compatibility: "compatible",
          fileInventory: [{ path: "SKILL.md", kind: "skill" }],
          metadata: null,
        },
      ],
    });
    await svc.importBundle(
      buildInlineSource(manifest, undefined, {
        "COMPANY.md": "",
        "skills/alpha/SKILL.md": "# Alpha body",
      }),
      "user-1",
    );
    expect(skillUpsertCalls).toHaveLength(1);
    expect(skillUpsertCalls[0]!.policy).toBe("preserve_founder_edits");
    const imp = skillUpsertCalls[0]!.imports[0]!;
    expect(imp.key).toBe("alpha");
    expect(imp.slug).toBe("alpha");
    expect(imp.name).toBe("Alpha");
    expect(imp.sourceType).toBe("local_path");
    expect(imp.markdown).toContain("# Alpha body");
  });

  it("importBundle warns via missing_file when skill markdown path is not in bundle files", async () => {
    resetState();
    const manifest = baseManifest({
      skills: [
        {
          key: "alpha",
          slug: "alpha",
          name: "Alpha",
          path: "skills/alpha/SKILL.md",
          sourceType: "local_path",
          trustLevel: "markdown_only",
          compatibility: "compatible",
        },
      ],
    });
    const result = await svc.importBundle(
      buildInlineSource(manifest, undefined, {
        "COMPANY.md": "",
        // markdown file intentionally missing
      }),
      "user-1",
    );
    expect(result.warnings.some((w) => w.kind === "missing_file" && /alpha/.test(w.message))).toBe(true);
    // Still imports with empty markdown (graceful continue)
    expect(skillUpsertCalls).toHaveLength(1);
  });

  it("importBundle with collisionStrategy=skip skips existing skill by key", async () => {
    resetState();
    targetSkills = [
      makeSkill({ id: "existing-1", companyId: TGT_CO_ID, key: "alpha", name: "Old Alpha" }),
    ];
    const manifest = baseManifest({
      skills: [
        {
          key: "alpha",
          slug: "alpha",
          name: "New Alpha",
          path: "skills/alpha/SKILL.md",
          sourceType: "local_path",
          trustLevel: "markdown_only",
          compatibility: "compatible",
        },
      ],
    });
    const result = await svc.importBundle(
      buildInlineSource(
        manifest,
        { company: false, agents: false, projects: false, issues: false, skills: true },
        { "COMPANY.md": "", "skills/alpha/SKILL.md": "body" },
        { mode: "existing_company", companyId: TGT_CO_ID },
        "skip",
      ),
      "user-1",
    );
    expect(skillUpsertCalls).toHaveLength(0);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.action).toBe("skipped");
    // existing target skill unchanged
    expect(targetSkills[0]!.name).toBe("Old Alpha");
  });

  it("importBundle with collisionStrategy=replace updates existing skill by key", async () => {
    resetState();
    targetSkills = [
      makeSkill({ id: "existing-1", companyId: TGT_CO_ID, key: "alpha", name: "Old Alpha" }),
    ];
    const manifest = baseManifest({
      skills: [
        {
          key: "alpha",
          slug: "alpha",
          name: "New Alpha",
          path: "skills/alpha/SKILL.md",
          sourceType: "local_path",
          trustLevel: "markdown_only",
          compatibility: "compatible",
        },
      ],
    });
    const result = await svc.importBundle(
      buildInlineSource(
        manifest,
        { company: false, agents: false, projects: false, issues: false, skills: true },
        { "COMPANY.md": "", "skills/alpha/SKILL.md": "new body" },
        { mode: "existing_company", companyId: TGT_CO_ID },
        "replace",
      ),
      "user-1",
    );
    expect(skillUpsertCalls).toHaveLength(1);
    expect(skillUpsertCalls[0]!.imports[0]!.key).toBe("alpha");
    expect(result.skills[0]!.action).toBe("updated");
    // upsertImportedSkills was called with key="alpha" → mock updates existing row
    expect(targetSkills[0]!.name).toBe("New Alpha");
  });

  it("surfaces a customized replace collision and preserves it by default", async () => {
    resetState();
    targetSkills = [
      makeSkill({
        id: "existing-1",
        companyId: TGT_CO_ID,
        key: "alpha",
        name: "Founder's Alpha",
        markdown: "# founder bytes\n",
        customized: true,
      }),
    ];
    const manifest = baseManifest({
      skills: [{
        key: "alpha",
        slug: "alpha",
        name: "Bundle Alpha",
        path: "skills/alpha/SKILL.md",
        sourceType: "local_path",
        trustLevel: "markdown_only",
        compatibility: "compatible",
      }],
    });
    const request = buildInlineSource(
      manifest,
      { company: false, agents: false, projects: false, issues: false, skills: true },
      { "COMPANY.md": "", "skills/alpha/SKILL.md": "# bundle bytes\n" },
      { mode: "existing_company", companyId: TGT_CO_ID },
      "replace",
    );

    const preview = await svc.previewImport(request);
    expect(preview.plan.skillPlans).toEqual([
      expect.objectContaining({
        key: "alpha",
        action: "skip",
        existingCustomized: true,
        overwriteCustomized: false,
        reason: expect.stringMatching(/founder edits|preserv/i),
      }),
    ]);

    const result = await svc.importBundle(request, "user-1");
    expect(skillUpsertCalls).toHaveLength(0);
    expect(result.skills[0]).toMatchObject({ key: "alpha", action: "skipped" });
    expect(targetSkills[0]).toMatchObject({
      name: "Founder's Alpha",
      markdown: "# founder bytes\n",
      customized: true,
    });
  });

  it("overwrites a customized collision only with an explicit per-key opt-in", async () => {
    resetState();
    targetSkills = [
      makeSkill({
        id: "existing-1",
        companyId: TGT_CO_ID,
        key: "alpha",
        name: "Founder's Alpha",
        markdown: "# founder bytes\n",
        customized: true,
      }),
    ];
    const manifest = baseManifest({
      skills: [{
        key: "alpha",
        slug: "alpha",
        name: "Bundle Alpha",
        path: "skills/alpha/SKILL.md",
        sourceType: "local_path",
        trustLevel: "markdown_only",
        compatibility: "compatible",
      }],
    });
    const request = {
      ...buildInlineSource(
        manifest,
        { company: false, agents: false, projects: false, issues: false, skills: true },
        { "COMPANY.md": "", "skills/alpha/SKILL.md": "# bundle bytes\n" },
        { mode: "existing_company", companyId: TGT_CO_ID },
        "replace",
      ),
      overwriteCustomizedSkillKeys: ["alpha"],
    };

    const preview = await svc.previewImport(request);
    expect(preview.plan.skillPlans[0]).toMatchObject({
      key: "alpha",
      action: "update",
      existingCustomized: true,
      overwriteCustomized: true,
    });

    const result = await svc.importBundle(request, "user-1");
    expect(skillUpsertCalls).toHaveLength(1);
    expect(skillUpsertCalls[0]).toMatchObject({
      policy: "caller_is_authoritative",
      imports: [expect.objectContaining({ key: "alpha" })],
    });
    expect(result.skills[0]).toMatchObject({
      key: "alpha",
      id: "existing-1",
      action: "updated",
    });
    expect(targetSkills[0]).toMatchObject({
      name: "Bundle Alpha",
      markdown: "# bundle bytes\n",
      customized: false,
    });
  });

  it("preserves a skill customized after preview and keeps agent links on that row", async () => {
    resetState();
    targetSkills = [
      makeSkill({
        id: "existing-1",
        companyId: TGT_CO_ID,
        key: "alpha",
        name: "Existing Alpha",
        markdown: "# pristine bytes\n",
        customized: false,
      }),
    ];
    customizeBeforeNextSkillUpsert = true;
    const manifest = baseManifest({
      includes: { company: false, agents: true, projects: false, issues: false, skills: true },
      agents: [{
        slug: "ada",
        name: "Ada",
        path: "agents/ada/AGENTS.md",
        role: "Engineer",
        title: null,
        icon: null,
        capabilities: null,
        reportsToSlug: null,
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        budgetMonthlyCents: 0,
        metadata: null,
        skillKeys: ["alpha"],
      }],
      skills: [{
        key: "alpha",
        slug: "alpha",
        name: "Bundle Alpha",
        path: "skills/alpha/SKILL.md",
        sourceType: "local_path",
        trustLevel: "markdown_only",
        compatibility: "compatible",
      }],
    });

    const result = await svc.importBundle(
      buildInlineSource(
        manifest,
        { company: false, agents: true, projects: false, issues: false, skills: true },
        {
          "COMPANY.md": "",
          "agents/ada/AGENTS.md": "---\nkind: agent\n---\n",
          "skills/alpha/SKILL.md": "# bundle bytes\n",
        },
        { mode: "existing_company", companyId: TGT_CO_ID },
        "replace",
      ),
      "user-1",
    );

    expect(result.skills[0]).toMatchObject({
      key: "alpha",
      id: "existing-1",
      action: "skipped",
      reason: expect.stringMatching(/gained founder edits|preserved/i),
    });
    expect(result.warnings).toContainEqual(expect.objectContaining({
      kind: "skipped_update",
      message: expect.stringMatching(/gained founder edits|preserved/i),
    }));
    expect(targetSkills[0]).toMatchObject({
      markdown: "# concurrent founder bytes\n",
      customized: true,
    });
    expect(targetAgents.find((agent) => agent.name === "Ada")?.skillKeys).toEqual(["alpha"]);
  });

  it("pairs upsert results to plan rows by key even when returned out of order", async () => {
    resetState();
    reverseSkillUpsertResults = true;
    const manifest = baseManifest({
      skills: [
        {
          key: "alpha",
          slug: "alpha",
          name: "Alpha",
          path: "skills/alpha/SKILL.md",
          sourceType: "local_path",
          trustLevel: "markdown_only",
          compatibility: "compatible",
        },
        {
          key: "beta",
          slug: "beta",
          name: "Beta",
          path: "skills/beta/SKILL.md",
          sourceType: "local_path",
          trustLevel: "markdown_only",
          compatibility: "compatible",
        },
      ],
    });

    const result = await svc.importBundle(
      buildInlineSource(
        manifest,
        undefined,
        {
          "COMPANY.md": "",
          "skills/alpha/SKILL.md": "# alpha\n",
          "skills/beta/SKILL.md": "# beta\n",
        },
      ),
      "user-1",
    );

    const alphaRow = targetSkills.find((skill) => skill.key === "alpha")!;
    const betaRow = targetSkills.find((skill) => skill.key === "beta")!;
    expect(result.skills.find((skill) => skill.key === "alpha")?.id).toBe(alphaRow.id);
    expect(result.skills.find((skill) => skill.key === "beta")?.id).toBe(betaRow.id);
  });

  it("pairs a normalized manifest key to the existing canonical row", async () => {
    resetState();
    targetSkills = [
      makeSkill({
        id: "existing-1",
        companyId: TGT_CO_ID,
        key: "alpha",
        name: "Old Alpha",
      }),
    ];
    const manifest = baseManifest({
      skills: [{
        key: "ALPHA",
        slug: "alpha",
        name: "New Alpha",
        path: "skills/alpha/SKILL.md",
        sourceType: "local_path",
        trustLevel: "markdown_only",
        compatibility: "compatible",
      }],
    });
    const request = buildInlineSource(
      manifest,
      { company: false, agents: false, projects: false, issues: false, skills: true },
      { "COMPANY.md": "", "skills/alpha/SKILL.md": "# new alpha\n" },
      { mode: "existing_company", companyId: TGT_CO_ID },
      "replace",
    );

    const preview = await svc.previewImport(request);
    expect(preview.plan.skillPlans[0]).toMatchObject({
      key: "ALPHA",
      plannedKey: "alpha",
      existingSkillId: "existing-1",
      action: "update",
    });

    const result = await svc.importBundle(request, "user-1");
    expect(result.skills[0]).toMatchObject({
      key: "ALPHA",
      id: "existing-1",
      action: "updated",
    });
    expect(targetSkills).toHaveLength(1);
    expect(targetSkills[0]?.name).toBe("New Alpha");
  });

  it("rejects manifest skill keys that collide after normalization", async () => {
    resetState();
    const manifest = baseManifest({
      skills: [
        {
          key: "ALPHA",
          slug: "alpha-one",
          name: "Alpha One",
          path: "skills/alpha-one/SKILL.md",
          sourceType: "local_path",
        },
        {
          key: "alpha",
          slug: "alpha-two",
          name: "Alpha Two",
          path: "skills/alpha-two/SKILL.md",
          sourceType: "local_path",
        },
      ],
    });

    const preview = await svc.previewImport(buildInlineSource(manifest));

    expect(preview.errors).toContainEqual(
      expect.stringMatching(/duplicate skill key after normalization/i),
    );
    await expect(
      svc.importBundle(buildInlineSource(manifest), "user-1"),
    ).rejects.toMatchObject({ status: 422 });
    expect(skillUpsertCalls).toHaveLength(0);
  });

  it("rejects an unknown skill sourceType in the request validator", async () => {
    const { companyPortabilityPreviewSchema } = await import("@armyofagents/shared");
    const manifest = {
      ...baseManifest(),
      skills: [{
        key: "alpha",
        slug: "alpha",
        name: "Alpha",
        path: "skills/alpha/SKILL.md",
        sourceType: "attacker_controlled",
      }],
    };

    const parsed = companyPortabilityPreviewSchema.safeParse(
      buildInlineSource(manifest as CompanyPortabilityManifest),
    );

    expect(parsed.success).toBe(false);
  });

  it("importBundle with collisionStrategy=rename assigns new key to bundle skill", async () => {
    resetState();
    targetSkills = [
      makeSkill({ id: "existing-1", companyId: TGT_CO_ID, key: "alpha", name: "Old Alpha" }),
    ];
    const manifest = baseManifest({
      skills: [
        {
          key: "alpha",
          slug: "alpha",
          name: "New Alpha",
          path: "skills/alpha/SKILL.md",
          sourceType: "local_path",
          trustLevel: "markdown_only",
          compatibility: "compatible",
        },
      ],
    });
    const result = await svc.importBundle(
      buildInlineSource(
        manifest,
        { company: false, agents: false, projects: false, issues: false, skills: true },
        { "COMPANY.md": "", "skills/alpha/SKILL.md": "body" },
        { mode: "existing_company", companyId: TGT_CO_ID },
        "rename",
      ),
      "user-1",
    );
    expect(skillUpsertCalls).toHaveLength(1);
    const imp = skillUpsertCalls[0]!.imports[0]!;
    expect(imp.key).not.toBe("alpha");
    expect(imp.key.startsWith("alpha")).toBe(true);
    expect(result.skills[0]!.action).toBe("created");
    // existing target skill unchanged
    expect(targetSkills.find((s) => s.id === "existing-1")!.name).toBe("Old Alpha");
  });

  it("allocates renamed skill keys in normalized key space", async () => {
    resetState();
    targetSkills = [
      makeSkill({
        id: "existing-1",
        companyId: TGT_CO_ID,
        key: "ALPHA",
        name: "Existing Alpha",
        markdown: "# existing\n",
      }),
    ];
    const manifest = baseManifest({
      skills: [{
        key: "alpha",
        slug: "alpha",
        name: "Imported Alpha",
        path: "skills/alpha/SKILL.md",
        sourceType: "local_path",
        trustLevel: "markdown_only",
        compatibility: "compatible",
      }],
    });
    const request = buildInlineSource(
      manifest,
      { company: false, agents: false, projects: false, issues: false, skills: true },
      { "COMPANY.md": "", "skills/alpha/SKILL.md": "# imported\n" },
      { mode: "existing_company", companyId: TGT_CO_ID },
      "rename",
    );

    const preview = await svc.previewImport(request);
    expect(preview.plan.skillPlans[0]).toMatchObject({
      key: "alpha",
      action: "create",
      plannedKey: "alpha-2",
      existingSkillId: "existing-1",
    });

    const result = await svc.importBundle(request, "user-1");
    expect(skillUpsertCalls[0]!.imports[0]!.key).toBe("alpha-2");
    expect(result.skills[0]).toMatchObject({ key: "alpha", action: "created" });
    expect(targetSkills.find((skill) => skill.id === "existing-1")).toMatchObject({
      key: "ALPHA",
      name: "Existing Alpha",
      markdown: "# existing\n",
    });
  });

  it("importBundle remaps agent.skillKeys when a referenced skill is renamed", async () => {
    resetState();
    targetSkills = [
      makeSkill({ id: "existing-1", companyId: TGT_CO_ID, key: "alpha", name: "Old Alpha" }),
    ];
    const manifest = baseManifest({
      includes: { company: false, agents: true, projects: false, issues: false, skills: true },
      agents: [
        {
          slug: "ada",
          name: "Ada",
          path: "agents/ada/AGENTS.md",
          role: "Engineer",
          title: null,
          icon: null,
          capabilities: null,
          reportsToSlug: null,
          adapterType: "claude_local",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
          budgetMonthlyCents: 0,
          metadata: null,
          skillKeys: ["alpha"],
        },
      ],
      skills: [
        {
          key: "alpha",
          slug: "alpha",
          name: "New Alpha",
          path: "skills/alpha/SKILL.md",
          sourceType: "local_path",
          trustLevel: "markdown_only",
          compatibility: "compatible",
        },
      ],
    });
    await svc.importBundle(
      buildInlineSource(
        manifest,
        { company: false, agents: true, projects: false, issues: false, skills: true },
        {
          "COMPANY.md": "",
          "agents/ada/AGENTS.md": "---\nkind: agent\n---\n",
          "skills/alpha/SKILL.md": "body",
        },
        { mode: "existing_company", companyId: TGT_CO_ID },
        "rename",
      ),
      "user-1",
    );
    // Agent was created, then patched for skillKeys with renamed key
    const adaCreated = targetAgents.find((a) => a.name === "Ada");
    expect(adaCreated).toBeDefined();
    const finalSkillKeys = Array.isArray(adaCreated!.skillKeys) ? adaCreated!.skillKeys : [];
    expect(finalSkillKeys.length).toBe(1);
    expect(finalSkillKeys[0]).not.toBe("alpha");
    expect(finalSkillKeys[0]!.startsWith("alpha")).toBe(true);
  });

  it("previewImport includes skillPlans entries for each manifest skill", async () => {
    resetState();
    const manifest = baseManifest({
      skills: [
        {
          key: "a",
          slug: "a",
          name: "A",
          path: "skills/a/SKILL.md",
          sourceType: "local_path",
          trustLevel: "markdown_only",
          compatibility: "compatible",
        },
        {
          key: "b",
          slug: "b",
          name: "B",
          path: "skills/b/SKILL.md",
          sourceType: "local_path",
          trustLevel: "markdown_only",
          compatibility: "compatible",
        },
      ],
    });
    const preview = await svc.previewImport(buildInlineSource(manifest));
    expect(preview.plan.skillPlans).toHaveLength(2);
    expect(preview.plan.skillPlans.map((p) => p.key).sort()).toEqual(["a", "b"]);
  });

  it("export → import roundtrip yields zero unknown_section warnings for skills", async () => {
    resetState();
    sourceSkills = [
      makeSkill({ id: "s1", key: "alpha", slug: "alpha", name: "Alpha" }),
    ];
    const exported = await svc.exportBundle(SRC_CO_ID, { include: { skills: true } });
    const result = await svc.importBundle(
      {
        source: { type: "inline", manifest: exported.manifest, files: { ...exported.files } },
        target: { mode: "new_company", newCompanyName: "Clone Co" },
        include: { company: true, agents: false, projects: false, issues: false, skills: true },
      },
      "user-1",
    );
    expect(result.warnings.filter((w) => w.kind === "unknown_section" && w.section === "skills")).toEqual([]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.action).toBe("created");
  });
});
