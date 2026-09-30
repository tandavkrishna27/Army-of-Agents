import { describe, expect, it } from "vitest";
import type { CompanyPortabilityManifest } from "@armyofagents/shared";
import { generateReadme } from "../services/company-export-readme.js";

function baseManifest(overrides: Partial<CompanyPortabilityManifest> = {}): CompanyPortabilityManifest {
  return {
    schemaVersion: 2,
    generatedAt: "2026-04-21T12:00:00.000Z",
    source: { companyId: "co-1", companyName: "Acme Co" },
    includes: {
      company: true,
      agents: true,
      projects: false,
      issues: false,
      skills: false,
      routines: false,
      envInputs: false,
    },
    company: {
      path: "COMPANY.md",
      name: "Acme Co",
      description: "A test company.",
      brandColor: null,
      requireBoardApprovalForNewAgents: false,
    },
    agents: [],
    requiredSecrets: [],
    ...overrides,
  };
}

describe("generateReadme", () => {
  it("renders minimal bundle with just company (no agents)", () => {
    const readme = generateReadme(baseManifest({ agents: [] }));
    expect(readme).toContain("# Acme Co Export Bundle");
    expect(readme).toContain("A test company.");
    // no agent sections
    expect(readme).not.toContain("### Agents");
    // always: generated-at + schemaVersion footer
    expect(readme).toContain("2026-04-21");
    expect(readme).toContain("schemaVersion");
  });

  it("pulls company name + description from options when manifest.company is null", () => {
    const manifest = baseManifest({ company: null });
    const readme = generateReadme(manifest, {
      companyName: "Override Co",
      companyDescription: "Overridden.",
    });
    expect(readme).toContain("# Override Co Export Bundle");
    expect(readme).toContain("Overridden.");
  });

  it("renders agent role roll-up and agents table", () => {
    const manifest = baseManifest({
      agents: [
        {
          slug: "ada",
          name: "Ada",
          path: "agents/ada/AGENTS.md",
          role: "cxo",
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
        {
          slug: "bob",
          name: "Bob",
          path: "agents/bob/AGENTS.md",
          role: "engineer",
          title: null,
          icon: null,
          capabilities: null,
          reportsToSlug: "ada",
          adapterType: "claude_local",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
          budgetMonthlyCents: 0,
          metadata: null,
        },
        {
          slug: "cleo",
          name: "Cleo",
          path: "agents/cleo/AGENTS.md",
          role: "engineer",
          title: null,
          icon: null,
          capabilities: null,
          reportsToSlug: "ada",
          adapterType: "claude_local",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
          budgetMonthlyCents: 0,
          metadata: null,
        },
      ],
    });
    const readme = generateReadme(manifest);
    // Roll-up: 1 cxo (labeled "Executive") + 2 Engineers
    expect(readme).toMatch(/Executive\s*\|\s*1/);
    expect(readme).toMatch(/Engineer\s*\|\s*2/);
    // Agents table has all three
    expect(readme).toContain("Ada");
    expect(readme).toContain("Bob");
    expect(readme).toContain("Cleo");
    // reportsTo column shows ada for bob/cleo
    expect(readme).toMatch(/Bob\s*\|\s*Engineer\s*\|\s*ada/);
  });

  it("renders org tree with nested reportsTo hierarchy", () => {
    const manifest = baseManifest({
      agents: [
        {
          slug: "ada",
          name: "Ada",
          path: "agents/ada/AGENTS.md",
          role: "cxo",
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
        {
          slug: "bob",
          name: "Bob",
          path: "agents/bob/AGENTS.md",
          role: "engineer",
          title: null,
          icon: null,
          capabilities: null,
          reportsToSlug: "ada",
          adapterType: "claude_local",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
          budgetMonthlyCents: 0,
          metadata: null,
        },
      ],
    });
    const readme = generateReadme(manifest);
    expect(readme).toContain("## Org Tree");
    // Bob should be nested under Ada via 2-space indent
    const lines = readme.split("\n");
    const adaIdx = lines.findIndex((l) => /^- \*\*Ada\*\*/.test(l));
    const bobIdx = lines.findIndex((l) => /^ {2}- \*\*Bob\*\*/.test(l));
    expect(adaIdx).toBeGreaterThan(-1);
    expect(bobIdx).toBeGreaterThan(adaIdx);
  });

  it("renders entity counts for projects, issues (as Tasks), skills, routines, envInputs", () => {
    const manifest = baseManifest({
      projects: [
        { slug: "eng", name: "Engineering", type: "department" },
        { slug: "auth", name: "Auth", type: "project", parentSlug: "eng" },
      ],
      issues: [
        { slug: "task-1", title: "Task One" },
        { slug: "task-2", title: "Task Two" },
        { slug: "task-3", title: "Task Three" },
      ],
      skills: [
        {
          key: "skill.one",
          slug: "skill-one",
          name: "Skill One",
          path: "skills/skill-one/SKILL.md",
          sourceType: "builtin",
        },
      ],
      routines: [
        {
          slug: "nightly",
          title: "Nightly",
          status: "active",
          priority: "medium",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          projectSlug: "eng",
          assigneeAgentSlug: "ada",
          variables: [],
          triggers: [],
        },
      ],
      envInputs: [
        {
          key: "API_KEY",
          description: null,
          agentSlug: "ada",
          projectSlug: null,
          kind: "secret",
          requirement: "required",
          defaultValue: "",
          portability: "portable",
        },
      ],
    });
    const readme = generateReadme(manifest);
    // Counts table uses "Tasks" (not "Issues") per naming map
    expect(readme).toMatch(/Tasks\s*\|\s*3/);
    expect(readme).toMatch(/Projects\s*\|\s*2/);
    expect(readme).toMatch(/Skills\s*\|\s*1/);
    expect(readme).toMatch(/Routines\s*\|\s*1/);
    expect(readme).not.toMatch(/\|\s*Issues\s*\|/);
  });

  it("lists required secrets (including secret envInputs) under Required Secrets", () => {
    const manifest = baseManifest({
      requiredSecrets: [
        { key: "OPENAI_API_KEY", description: "OpenAI key", agentSlug: "ada", providerHint: "openai" },
      ],
      envInputs: [
        {
          key: "GITHUB_TOKEN",
          description: null,
          agentSlug: "bob",
          projectSlug: null,
          kind: "secret",
          requirement: "required",
          defaultValue: "",
          portability: "portable",
        },
        {
          key: "API_BASE_URL",
          description: null,
          agentSlug: "bob",
          projectSlug: null,
          kind: "plain",
          requirement: "optional",
          defaultValue: "https://api.example.com",
          portability: "portable",
        },
      ],
    });
    const readme = generateReadme(manifest);
    expect(readme).toContain("## Required Secrets");
    expect(readme).toContain("OPENAI_API_KEY");
    expect(readme).toContain("GITHUB_TOKEN");
    // plain env input is NOT a secret
    expect(readme).not.toMatch(/\|\s*API_BASE_URL\s*\|/);
  });

  it("omits empty sections (no agents, no projects, no skills, no routines, no secrets)", () => {
    const readme = generateReadme(baseManifest({ agents: [] }));
    expect(readme).not.toContain("### Agents");
    expect(readme).not.toContain("### Projects");
    expect(readme).not.toContain("### Skills");
    expect(readme).not.toContain("## Org Tree");
    expect(readme).not.toContain("## Required Secrets");
  });

  it("includes schemaVersion and generatedAt in footer", () => {
    const readme = generateReadme(baseManifest({ schemaVersion: 2, generatedAt: "2026-04-21T12:00:00.000Z" }));
    expect(readme).toContain("schemaVersion 2");
    expect(readme).toContain("2026-04-21");
  });

  it("is a pure function — same input produces same output", () => {
    const a = baseManifest();
    const b = baseManifest();
    expect(generateReadme(a)).toBe(generateReadme(b));
  });
});
