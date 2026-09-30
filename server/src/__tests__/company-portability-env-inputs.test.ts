import { describe, expect, it, vi } from "vitest";

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
};

const SRC_CO_ID = "11111111-1111-4111-8111-111111111111";
const TGT_CO_ID = "22222222-2222-4222-8222-222222222222";

const companyStore: Record<string, { id: string; name: string; requireBoardApprovalForNewAgents?: boolean }> = {
  [SRC_CO_ID]: { id: SRC_CO_ID, name: "Source Co", requireBoardApprovalForNewAgents: true },
  [TGT_CO_ID]: { id: TGT_CO_ID, name: "Target Co", requireBoardApprovalForNewAgents: true },
};

let sourceAgents: AgentRow[] = [];
let targetAgents: AgentRow[] = [];
const agentCreateCalls: Array<{ companyId: string; input: any; actor: any }> = [];

vi.mock("../services/companies.js", () => ({
  companyService: () => ({
    getById: vi.fn(async (id: string) => companyStore[id] ?? null),
    create: vi.fn(async (input: { name: string }) => ({ id: "new-co", name: input.name })),
    update: vi.fn(async (id: string, patch: any) => ({ id, name: patch.name ?? companyStore[id]?.name ?? "Co" })),
  }),
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => ({
    backfillHumanAtTop: vi.fn(async () => undefined),
    list: vi.fn(async (companyId: string) => {
      if (companyId === SRC_CO_ID) return sourceAgents;
      if (companyId === TGT_CO_ID) return targetAgents;
      return [];
    }),
    create: vi.fn(async (companyId: string, input: any, actor: any) => {
      agentCreateCalls.push({ companyId, input, actor });
      const row: AgentRow = {
        id: `new-agent-${targetAgents.length + 1}`,
        companyId,
        name: input.name,
        status: "active",
        role: input.role ?? "agent",
        title: input.title ?? null,
        icon: input.icon ?? null,
        capabilities: input.capabilities ?? null,
        reportsTo: input.reportsTo ?? null,
        parentType: input.parentType ?? null,
        parentId: input.parentId ?? null,
        adapterType: input.adapterType ?? "process",
        adapterConfig: input.adapterConfig ?? {},
        runtimeConfig: input.runtimeConfig ?? {},
        permissions: input.permissions ?? {},
        budgetMonthlyCents: input.budgetMonthlyCents ?? 0,
        metadata: input.metadata ?? null,
      };
      targetAgents.push(row);
      return row;
    }),
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
    list: vi.fn(async () => []),
    create: vi.fn(),
    update: vi.fn(),
  }),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    list: vi.fn(async () => []),
    create: vi.fn(),
  }),
}));

vi.mock("../services/company-skills.js", () => ({
  companySkillService: () => ({
    listFull: vi.fn(async () => []),
    upsertImportedSkills: vi.fn(async () => []),
  }),
}));

vi.mock("../services/routines.js", () => ({
  routineService: () => ({
    list: vi.fn(async () => []),
    listForExport: vi.fn(async () => []),
    create: vi.fn(),
    update: vi.fn(),
    createTrigger: vi.fn(),
  }),
}));

import { companyPortabilityService } from "../services/company-portability.js";
import type { CompanyPortabilityManifest } from "@armyofagents/shared";

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
    ...overrides,
  };
}

function baseManifest(overrides: Partial<CompanyPortabilityManifest> = {}): CompanyPortabilityManifest {
  return {
    schemaVersion: 2,
    generatedAt: "2026-04-21T00:00:00.000Z",
    source: null,
    includes: { company: true, agents: true, projects: false, issues: false, skills: false, routines: false, envInputs: true },
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
  include: Partial<{
    company: boolean;
    agents: boolean;
    projects: boolean;
    issues: boolean;
    skills: boolean;
    routines: boolean;
    envInputs: boolean;
  }>,
  files: Record<string, string> = { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" },
  target: { mode: "new_company"; newCompanyName?: string | null } | { mode: "existing_company"; companyId: string } = {
    mode: "existing_company" as const,
    companyId: TGT_CO_ID,
  },
) {
  return {
    source: { type: "inline" as const, manifest, files },
    target,
    include,
  };
}

function resetState() {
  sourceAgents = [];
  targetAgents = [];
  agentCreateCalls.length = 0;
}

describe("company-portability envInputs", () => {
  const svc = companyPortabilityService({ select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) } as any);

  it("exportBundle with include.envInputs=true emits envInputs array from agent env", async () => {
    resetState();
    sourceAgents = [
      makeAgent({
        id: "a1",
        name: "Ada",
        adapterConfig: {
          env: {
            API_BASE_URL: { type: "plain", value: "https://api.example.com" },
            LOG_LEVEL: "info",
          },
        },
      }),
    ];
    const result = await svc.exportBundle(SRC_CO_ID, { include: { agents: true, envInputs: true } });
    expect(result.manifest.envInputs).toBeDefined();
    const envInputs = result.manifest.envInputs!;
    expect(envInputs.length).toBeGreaterThanOrEqual(2);
    const apiBase = envInputs.find((e) => e.key === "API_BASE_URL")!;
    expect(apiBase.kind).toBe("plain");
    expect(apiBase.agentSlug).toBe("ada");
    expect(apiBase.defaultValue).toBe("https://api.example.com");
    expect(apiBase.portability).toBe("portable");
    const logLevel = envInputs.find((e) => e.key === "LOG_LEVEL")!;
    expect(logLevel.kind).toBe("plain");
    expect(logLevel.defaultValue).toBe("info");
  });

  it("exportBundle classifies sensitive env keys as secret with defaultValue stripped", async () => {
    resetState();
    sourceAgents = [
      makeAgent({
        id: "a1",
        name: "Ada",
        adapterConfig: {
          env: {
            OPENAI_API_KEY: { type: "plain", value: "sk-should-not-leak" },
            GITHUB_TOKEN: "ghp-also-should-not-leak",
            DB_PASSWORD: { type: "plain", value: "hunter2" },
          },
        },
      }),
    ];
    const result = await svc.exportBundle(SRC_CO_ID, { include: { agents: true, envInputs: true } });
    const envInputs = result.manifest.envInputs!;
    const apiKey = envInputs.find((e) => e.key === "OPENAI_API_KEY")!;
    expect(apiKey.kind).toBe("secret");
    expect(apiKey.defaultValue).toBe("");
    const token = envInputs.find((e) => e.key === "GITHUB_TOKEN")!;
    expect(token.kind).toBe("secret");
    expect(token.defaultValue).toBe("");
    const pw = envInputs.find((e) => e.key === "DB_PASSWORD")!;
    expect(pw.kind).toBe("secret");
    expect(pw.defaultValue).toBe("");
  });

  it("exportBundle does NOT leak secret values into the bundle (stringified check)", async () => {
    resetState();
    sourceAgents = [
      makeAgent({
        id: "a1",
        name: "Ada",
        adapterConfig: {
          env: {
            OPENAI_API_KEY: { type: "plain", value: "sk-VERY-SENSITIVE-SECRET-12345" },
          },
        },
      }),
    ];
    const result = await svc.exportBundle(SRC_CO_ID, { include: { agents: true, envInputs: true } });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk-VERY-SENSITIVE-SECRET-12345");
  });

  it("exportBundle treats secret_ref env bindings as secret envInputs", async () => {
    resetState();
    sourceAgents = [
      makeAgent({
        id: "a1",
        name: "Ada",
        adapterConfig: {
          env: {
            ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "550e8400-e29b-41d4-a716-446655440000" },
          },
        },
      }),
    ];
    const result = await svc.exportBundle(SRC_CO_ID, { include: { agents: true, envInputs: true } });
    const input = result.manifest.envInputs!.find((e) => e.key === "ANTHROPIC_API_KEY")!;
    expect(input.kind).toBe("secret");
    expect(input.defaultValue).toBe("");
  });

  it("exportBundle skips PATH env key and warns", async () => {
    resetState();
    sourceAgents = [
      makeAgent({
        id: "a1",
        name: "Ada",
        adapterConfig: {
          env: {
            PATH: "/usr/local/bin:/usr/bin",
            OTHER: "safe",
          },
        },
      }),
    ];
    const result = await svc.exportBundle(SRC_CO_ID, { include: { agents: true, envInputs: true } });
    expect(result.manifest.envInputs!.find((e) => e.key === "PATH")).toBeUndefined();
    expect(result.warnings.some((w) => /PATH/.test(w))).toBe(true);
  });

  it("exportBundle marks absolute-path plain values as system_dependent", async () => {
    resetState();
    sourceAgents = [
      makeAgent({
        id: "a1",
        name: "Ada",
        adapterConfig: {
          env: {
            BINARY_DIR: { type: "plain", value: "/usr/local/bin/mytool" },
          },
        },
      }),
    ];
    const result = await svc.exportBundle(SRC_CO_ID, { include: { agents: true, envInputs: true } });
    const input = result.manifest.envInputs!.find((e) => e.key === "BINARY_DIR")!;
    expect(input.portability).toBe("system_dependent");
    expect(result.warnings.some((w) => /system-dependent/i.test(w) || /BINARY_DIR/.test(w))).toBe(true);
  });

  it("exportBundle omits envInputs field when include.envInputs=false (DEFAULT)", async () => {
    resetState();
    sourceAgents = [
      makeAgent({
        id: "a1",
        name: "Ada",
        adapterConfig: { env: { LOG_LEVEL: "info" } },
      }),
    ];
    const result = await svc.exportBundle(SRC_CO_ID, { include: { agents: true } });
    expect(result.manifest.envInputs).toBeUndefined();
    expect(result.manifest.includes.envInputs).toBe(false);
  });

  it("exportBundle bumps schemaVersion to 2 when envInputs included", async () => {
    resetState();
    sourceAgents = [
      makeAgent({ id: "a1", name: "Ada", adapterConfig: { env: { LOG_LEVEL: "info" } } }),
    ];
    const withEnv = await svc.exportBundle(SRC_CO_ID, { include: { agents: true, envInputs: true } });
    expect(withEnv.manifest.schemaVersion).toBe(2);
  });

  it("importBundle reconstructs plain env bindings into agent adapterConfig on create", async () => {
    resetState();
    const manifest = baseManifest({
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
        },
      ],
      envInputs: [
        {
          key: "LOG_LEVEL",
          description: null,
          agentSlug: "ada",
          projectSlug: null,
          kind: "plain",
          requirement: "optional",
          defaultValue: "info",
          portability: "portable",
        },
        {
          key: "API_BASE_URL",
          description: null,
          agentSlug: "ada",
          projectSlug: null,
          kind: "plain",
          requirement: "optional",
          defaultValue: "https://api.example.com",
          portability: "portable",
        },
      ],
    });

    await svc.importBundle(
      buildInlineSource(
        manifest,
        { company: false, agents: true, envInputs: true },
        { "COMPANY.md": "", "agents/ada/AGENTS.md": "---\nname: Ada\nslug: ada\n---\n" },
      ),
      "user-1",
    );
    expect(agentCreateCalls).toHaveLength(1);
    const createdConfig = agentCreateCalls[0]!.input.adapterConfig ?? {};
    const env = (createdConfig as any).env ?? {};
    expect(env.LOG_LEVEL).toEqual({ type: "plain", value: "info" });
    expect(env.API_BASE_URL).toEqual({ type: "plain", value: "https://api.example.com" });
  });

  it("importBundle emits requiredSecrets entries for secret envInputs (user must fill in)", async () => {
    resetState();
    const manifest = baseManifest({
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
        },
      ],
      envInputs: [
        {
          key: "OPENAI_API_KEY",
          description: "OpenAI key for Ada",
          agentSlug: "ada",
          projectSlug: null,
          kind: "secret",
          requirement: "required",
          defaultValue: "",
          portability: "portable",
        },
      ],
    });
    const result = await svc.importBundle(
      buildInlineSource(
        manifest,
        { company: false, agents: true, envInputs: true },
        { "COMPANY.md": "", "agents/ada/AGENTS.md": "---\nname: Ada\nslug: ada\n---\n" },
      ),
      "user-1",
    );
    expect(result.requiredSecrets.some((s) => s.key === "OPENAI_API_KEY" && s.agentSlug === "ada")).toBe(true);
  });

  it("importBundle warns on system_dependent envInput", async () => {
    resetState();
    const manifest = baseManifest({
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
        },
      ],
      envInputs: [
        {
          key: "BINARY_DIR",
          description: null,
          agentSlug: "ada",
          projectSlug: null,
          kind: "plain",
          requirement: "optional",
          defaultValue: "/usr/local/bin/mytool",
          portability: "system_dependent",
        },
      ],
    });
    const result = await svc.importBundle(
      buildInlineSource(
        manifest,
        { company: false, agents: true, envInputs: true },
        { "COMPANY.md": "", "agents/ada/AGENTS.md": "---\nname: Ada\nslug: ada\n---\n" },
      ),
      "user-1",
    );
    expect(result.warnings.some((w) => /BINARY_DIR/.test(w.message) || /system.dependent/i.test(w.message))).toBe(true);
  });

  it("importBundle warns when envInput.agentSlug is unresolved", async () => {
    resetState();
    const manifest = baseManifest({
      agents: [],
      envInputs: [
        {
          key: "LOG_LEVEL",
          description: null,
          agentSlug: "ghost",
          projectSlug: null,
          kind: "plain",
          requirement: "optional",
          defaultValue: "info",
          portability: "portable",
        },
      ],
    });
    const result = await svc.importBundle(
      buildInlineSource(
        manifest,
        { company: false, agents: false, envInputs: true },
        { "COMPANY.md": "" },
      ),
      "user-1",
    );
    expect(result.warnings.some((w) => /ghost/.test(w.message) || /unresolved/i.test(w.message))).toBe(true);
  });

  it("KNOWN_SECTIONS includes envInputs (no unknown_section warning)", async () => {
    resetState();
    const manifest = baseManifest({ envInputs: [] });
    const result = await svc.previewImport(
      buildInlineSource(
        manifest,
        { company: false, agents: false, envInputs: true },
        { "COMPANY.md": "" },
      ),
    );
    expect(result.warnings.some((w) => w.kind === "unknown_section" && w.section === "envInputs")).toBe(false);
  });
});
