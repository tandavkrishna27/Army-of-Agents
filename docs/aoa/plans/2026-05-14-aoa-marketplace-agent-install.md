# AoA Marketplace Agent Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AoA install marketplace `agent.v1` bundles end to end, including dependency cascade, role/adapter selection, managed instruction bundles, setup warnings, and test coverage.

**Architecture:** Add a small server-side marketplace agent runtime layer that parses the new `agent.v1` contract, normalizes AoA install hints, fetches instruction files, and creates agents through shared install helpers. Keep dependency resolution canonical in `manifest.requires`/catalog `requires`, reuse existing skill/plugin installers, and keep setup collection out of the modal for v1: required setup installs the agent paused and records actionable metadata.

**Tech Stack:** TypeScript, Express, Drizzle, Zod, React, TanStack Query, Vitest, Playwright for final smoke coverage.

---

## Product Decisions

- Required skills auto-install before the agent.
- Required plugins auto-install before the agent.
- The install modal does not collect secret values or plugin config inline.
- If required setup is incomplete, AoA must force the installed agent to `paused`.
- Setup requirements are stored in agent metadata and surfaced in UI.
- The modal shows a suggested role from marketplace, lets the user change it, and validates against AoA roles: `cxo`, `lead`, `general`.
- The modal shows a suggested adapter from marketplace, lets the user choose from supported active AoA adapters, and blocks active install when no supported adapter exists.
- Senior Engineer should install with suggested role `lead`.
- GitHub Issue Triager should install with suggested role `general`.
- Unknown marketplace role or icon values are tolerated and normalized rather than failing install.
- Marketplace setup requirements link users to existing Secrets and Plugin settings screens after install.

## File Structure

- Create `server/src/services/marketplace-install/agent-runtime.ts`
  - Parse `agent.v1` and legacy flat agent templates.
  - Normalize roles, statuses, icons, adapter choices, setup requirements, and instruction descriptors.
  - Derive sibling raw URLs for bundle files from `catalogItem.resourceUrl`.
- Create `server/src/services/marketplace-install/agent-create.ts`
  - Shared helper to insert a marketplace agent row and materialize managed instruction bundles.
  - Used by direct agent install and team install.
- Modify `server/src/services/marketplace-install/types.ts`
  - Add install overrides and setup metadata types.
- Modify `server/src/services/marketplace-install/agent-installer.ts`
  - Use the parser/create helper.
  - Accept selected role/adapter overrides.
  - Honor forced paused behavior.
- Modify `server/src/services/marketplace-install/orchestrator.ts`
  - Execute dependency cascade for direct agent installs before creating the agent.
  - Return cascade results for direct agent installs.
- Modify `server/src/services/marketplace-install/team-installer.ts`
  - Use the same parser/create helper for marketplace agents inside team templates.
- Modify `server/src/services/marketplace-install/resolver.ts`
  - Fix plugin install detection to be company-scoped, matching `plugin-installer.ts`.
  - Optionally add setup preview metadata once the resource parser is available.
- Modify `server/src/services/marketplace-install/fetch-resource.ts`
  - Add safe helper for fetching sibling resource files.
- Modify `server/src/routes/marketplace-installs.ts`
  - Accept role/adapter overrides.
  - Validate override values.
  - Return route-level validation errors for unsupported selections.
- Modify `packages/shared/src/marketplace.ts`
  - Add optional install request override and setup preview types used by UI.
- Modify `ui/src/api/marketplace.ts`
  - Add `role`, `adapterType`, and setup preview fields to request/plan types.
- Modify `ui/src/components/marketplace/install/SnapshotInstallModal.tsx`
  - Fetch resolve plan for agents and teams.
  - Show dependency preview for agents.
  - Add role selector.
  - Add adapter selector.
  - Show setup warning and post-install links.
- Modify `ui/src/components/marketplace/install/CascadeTreePreview.tsx`
  - Generalize heading from team-only wording.
- Add or modify tests under:
  - `server/src/__tests__/marketplace-agent-runtime.test.ts`
  - `server/src/__tests__/marketplace-install-agent.test.ts`
  - `server/src/__tests__/marketplace-install-orchestrator.test.ts`
  - `server/src/__tests__/marketplace-install-resolver.test.ts`
  - `server/src/__tests__/marketplace-install-team-cascade.test.ts`
  - `server/src/__tests__/marketplace-installs-request.test.ts`
  - `ui/src/components/marketplace/install/__tests__/SnapshotInstallModal.test.tsx`
  - `tests/e2e/marketplace-agent-install.spec.ts`

## Task 1: Add Agent Runtime Parser And Normalizer

**Files:**
- Create: `server/src/services/marketplace-install/agent-runtime.ts`
- Modify: `server/src/services/marketplace-install/types.ts`
- Test: `server/src/__tests__/marketplace-agent-runtime.test.ts`

- [ ] **Step 1: Write failing parser tests**

Create `server/src/__tests__/marketplace-agent-runtime.test.ts` with tests for:

```ts
import { describe, expect, it } from "vitest";
import {
  deriveSiblingResourceUrl,
  normalizeMarketplaceAgentTemplate,
  parseMarketplaceAgentTemplate,
} from "../services/marketplace-install/agent-runtime.js";
import type { CatalogItem } from "@armyofagents/shared";

const AGENT_ITEM: CatalogItem = {
  id: "agent:aoa-curated/senior-engineer",
  type: "agent",
  name: "Senior Engineer",
  description: "Senior engineering agent",
  version: "1.0.0",
  source: {
    adapter: "aoa-curated",
    url: "https://github.com/MeteoriteLabs/aoa-marketplace",
    locator: "content/agents/senior-engineer",
    commitSha: "abc123",
  },
  resourceUrl: "https://raw.githubusercontent.com/MeteoriteLabs/aoa-marketplace/abc123/content/agents/senior-engineer/agent.json",
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-05-14T00:00:00Z",
  category: "engineering",
  tags: ["official"],
  requires: [
    { type: "skill", id: "skill:github-skills/obra/superpowers/writing-plans" },
  ],
};

describe("marketplace agent runtime parser", () => {
  it("parses agent.v1 bundle instructions and AoA hints", () => {
    const parsed = parseMarketplaceAgentTemplate(JSON.stringify({
      schemaVersion: "agent.v1",
      id: "senior-engineer",
      name: "Senior Engineer",
      description: "Senior engineering agent",
      instructions: {
        type: "bundle",
        entry: "AGENTS.md",
        files: ["AGENTS.md", "SOUL.md", "TOOLS.md", "HEARTBEAT.md"],
      },
      dependencies: {
        skills: {
          writingPlans: "skill:github-skills/obra/superpowers/writing-plans",
        },
      },
      aoa: {
        adapterCompatibility: {
          recommended: "codex_local",
          supported: ["codex_local", "claude_local"],
          requiresInstructionsBundle: true,
          requiresSkillInjection: true,
        },
        install: {
          defaultRole: "lead",
          defaultStatus: "paused",
          defaultIcon: "code",
        },
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0 } },
        permissions: { canCreateAgents: false },
        skillKeys: ["skill:github-skills/obra/superpowers/writing-plans"],
        setup: {
          notes: ["No external setup."],
        },
      },
    }), AGENT_ITEM);

    expect(parsed.kind).toBe("agent.v1");
    expect(parsed.runtime.instructions.type).toBe("bundle");
    expect(parsed.runtime.aoa?.install?.defaultRole).toBe("lead");
  });

  it("normalizes unknown role and icon safely", () => {
    const parsed = parseMarketplaceAgentTemplate(JSON.stringify({
      schemaVersion: "agent.v1",
      id: "bad-hints",
      name: "Bad Hints",
      description: "Has invalid AoA hints",
      instructions: { type: "inline", content: "Hello." },
      aoa: {
        install: {
          defaultRole: "engineering",
          defaultStatus: "active",
          defaultIcon: "github",
        },
      },
    }), AGENT_ITEM);

    const normalized = normalizeMarketplaceAgentTemplate({
      parsed,
      catalogItem: AGENT_ITEM,
      availableAdapterTypes: ["codex_local", "claude_local"],
    });

    expect(normalized.role).toBe("general");
    expect(normalized.icon).toBe("git-branch");
    expect(normalized.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/unknown role/i),
      expect.stringMatching(/unsupported icon/i),
    ]));
  });

  it("forces paused when required setup is incomplete", () => {
    const parsed = parseMarketplaceAgentTemplate(JSON.stringify({
      schemaVersion: "agent.v1",
      id: "github-issue-triager",
      name: "GitHub Issue Triager",
      description: "Triages GitHub issues",
      instructions: { type: "inline", content: "Triage issues." },
      aoa: {
        install: { defaultRole: "general", defaultStatus: "active", defaultIcon: "git-branch" },
        setup: {
          secrets: [{
            key: "GITHUB_TOKEN",
            label: "GitHub token",
            required: true,
            reason: "Required for GitHub API access.",
            usedBy: "plugin:aoa-curated/aoa-plugin-github-issues",
          }],
          pluginConfig: [{
            plugin: "plugin:aoa-curated/aoa-plugin-github-issues",
            required: true,
            reason: "Repository must be configured.",
          }],
        },
      },
    }), AGENT_ITEM);

    const normalized = normalizeMarketplaceAgentTemplate({
      parsed,
      catalogItem: AGENT_ITEM,
      availableAdapterTypes: ["codex_local"],
    });

    expect(normalized.status).toBe("paused");
    expect(normalized.setupRequired).toBe(true);
    expect(normalized.metadata.marketplaceSetupRequired).toBe(true);
  });

  it("derives sibling bundle URLs from agent.json resourceUrl", () => {
    expect(deriveSiblingResourceUrl(AGENT_ITEM, "AGENTS.md")).toBe(
      "https://raw.githubusercontent.com/MeteoriteLabs/aoa-marketplace/abc123/content/agents/senior-engineer/AGENTS.md",
    );
  });

  it("rejects unsafe sibling bundle paths", () => {
    expect(() => deriveSiblingResourceUrl(AGENT_ITEM, "../AGENTS.md")).toThrow(/unsafe/i);
    expect(() => deriveSiblingResourceUrl(AGENT_ITEM, "/AGENTS.md")).toThrow(/unsafe/i);
    expect(() => deriveSiblingResourceUrl(AGENT_ITEM, "docs//AGENTS.md")).toThrow(/unsafe/i);
  });
});
```

- [ ] **Step 2: Run the parser test and confirm failure**

Run:

```bash
pnpm test:run server/src/__tests__/marketplace-agent-runtime.test.ts
```

Expected: fails because `agent-runtime.ts` does not exist.

- [ ] **Step 3: Add shared types**

In `server/src/services/marketplace-install/types.ts`, add:

```ts
export interface AgentInstallOverrides {
  role?: "cxo" | "lead" | "general";
  adapterType?: string;
}

export interface AgentSetupRequirement {
  kind: "secret" | "plugin_config";
  key: string;
  label?: string;
  required: boolean;
  reason: string;
  usedBy?: string;
}

export interface NormalizedMarketplaceAgentTemplate {
  name: string;
  role: "cxo" | "lead" | "general";
  title?: string | null;
  icon?: string | null;
  status: "active" | "paused" | "idle" | "running" | "error" | "pending_approval" | "terminated";
  capabilities?: string | null;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  permissions: Record<string, unknown>;
  budgetMonthlyCents: number;
  skillKeys: string[];
  instructions:
    | { type: "inline"; files: Record<string, string>; entryFile: string }
    | { type: "file"; path: string; entryFile: string }
    | { type: "bundle"; files: string[]; entryFile: string };
  setupRequirements: AgentSetupRequirement[];
  setupRequired: boolean;
  metadata: Record<string, unknown>;
  warnings: string[];
}
```

- [ ] **Step 4: Implement `agent-runtime.ts`**

Create `server/src/services/marketplace-install/agent-runtime.ts` with:

```ts
import { z } from "zod";
import {
  AGENT_ICON_NAMES,
  AGENT_ROLES,
  AGENT_STATUSES,
  type AgentRole,
  type AgentStatus,
} from "@armyofagents/shared";
import type { CatalogItem } from "@armyofagents/shared";
import type { AgentSetupRequirement, NormalizedMarketplaceAgentTemplate } from "./types.js";

const AgentInstructionPathSchema = z.string().trim().min(1);

const AgentInstructionsSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inline"), content: z.string().trim().min(1) }).strict(),
  z.object({ type: z.literal("file"), path: AgentInstructionPathSchema }).strict(),
  z.object({
    type: z.literal("bundle"),
    entry: AgentInstructionPathSchema,
    files: z.array(AgentInstructionPathSchema).min(1),
  }).strict().superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [index, file] of value.files.entries()) {
      if (seen.has(file)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate bundle file", path: ["files", index] });
      }
      seen.add(file);
    }
    if (!seen.has(value.entry)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "entry must be included in files", path: ["entry"] });
    }
  }),
]);

const AgentRuntimeSchema = z.object({
  schemaVersion: z.literal("agent.v1"),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  instructions: AgentInstructionsSchema,
  dependencies: z.object({
    skills: z.record(z.string().min(1)).optional(),
    plugins: z.record(z.string().min(1)).optional(),
  }).strict().optional(),
  aoa: z.object({
    adapterType: z.string().min(1).optional(),
    adapterCompatibility: z.object({
      recommended: z.string().trim().min(1).optional(),
      supported: z.array(z.string().trim().min(1)).min(1).optional(),
      requiresInstructionsBundle: z.boolean().optional(),
      requiresSkillInjection: z.boolean().optional(),
    }).strict().optional(),
    install: z.object({
      defaultRole: z.string().trim().min(1).optional(),
      defaultStatus: z.enum(["active", "paused", "terminated"]).optional(),
      defaultIcon: z.string().trim().min(1).optional(),
    }).strict().optional(),
    runtimeConfig: z.record(z.unknown()).optional(),
    adapterConfig: z.record(z.unknown()).optional(),
    permissions: z.record(z.unknown()).optional(),
    skillKeys: z.array(z.string().min(1)).optional(),
    setup: z.object({
      secrets: z.array(z.object({
        key: z.string().trim().min(1),
        label: z.string().trim().min(1),
        required: z.boolean().optional(),
        reason: z.string().trim().min(1),
        usedBy: z.string().trim().min(1).optional(),
      }).strict()).optional(),
      pluginConfig: z.array(z.object({
        plugin: z.string().trim().min(1),
        required: z.boolean().optional(),
        reason: z.string().trim().min(1),
      }).strict()).optional(),
      notes: z.array(z.string().trim().min(1)).optional(),
    }).strict().optional(),
  }).strict().optional(),
}).strict();

const LegacyAgentTemplateSchema = z.object({
  role: z.string().optional(),
  title: z.string().optional(),
  icon: z.string().optional(),
  adapterType: z.string().optional(),
  adapterConfig: z.record(z.unknown()).optional(),
  runtimeConfig: z.record(z.unknown()).optional(),
  permissions: z.record(z.unknown()).optional(),
  skillKeys: z.array(z.string()).optional(),
  capabilities: z.string().optional(),
  budgetMonthlyCents: z.number().int().nonnegative().optional(),
}).passthrough();

export type ParsedMarketplaceAgentTemplate =
  | { kind: "agent.v1"; runtime: z.infer<typeof AgentRuntimeSchema> }
  | { kind: "legacy"; template: z.infer<typeof LegacyAgentTemplateSchema> };

const ROLE_SET = new Set<string>(AGENT_ROLES);
const STATUS_SET = new Set<string>(AGENT_STATUSES);
const ICON_SET = new Set<string>(AGENT_ICON_NAMES);

export function isSafeAgentResourcePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized) return false;
  if (normalized.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(normalized)) return false;
  if (normalized.includes("\0")) return false;
  return normalized.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function deriveSiblingResourceUrl(catalogItem: CatalogItem, relativePath: string): string {
  if (!catalogItem.resourceUrl) throw new Error(`agent ${catalogItem.id} has no resourceUrl`);
  if (!isSafeAgentResourcePath(relativePath)) {
    throw new Error(`Unsafe agent resource path: ${relativePath}`);
  }
  const base = new URL(catalogItem.resourceUrl);
  base.pathname = base.pathname.replace(/\/agent\.json$/, `/${relativePath}`);
  return base.toString();
}

export function parseMarketplaceAgentTemplate(bodyText: string, catalogItem: CatalogItem): ParsedMarketplaceAgentTemplate {
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch (err) {
    throw new Error(`Failed to parse agent template JSON for ${catalogItem.id}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const schemaVersion = typeof json === "object" && json !== null && "schemaVersion" in json
    ? (json as { schemaVersion?: unknown }).schemaVersion
    : undefined;
  if (schemaVersion === "agent.v1") {
    return { kind: "agent.v1", runtime: AgentRuntimeSchema.parse(json) };
  }
  return { kind: "legacy", template: LegacyAgentTemplateSchema.parse(json) };
}

function normalizeRole(value: unknown, warnings: string[]): AgentRole {
  if (typeof value === "string" && ROLE_SET.has(value)) return value as AgentRole;
  if (typeof value === "string" && value.trim()) warnings.push(`Unknown marketplace agent role "${value}"; using general.`);
  return "general";
}

function normalizeStatus(value: unknown, setupRequired: boolean): AgentStatus {
  if (setupRequired) return "paused";
  if (typeof value === "string" && STATUS_SET.has(value)) return value as AgentStatus;
  return "paused";
}

function normalizeIcon(value: unknown, warnings: string[]): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  if (ICON_SET.has(value)) return value;
  if (value === "github" && ICON_SET.has("git-branch")) {
    warnings.push('Unsupported marketplace agent icon "github"; using git-branch.');
    return "git-branch";
  }
  warnings.push(`Unsupported marketplace agent icon "${value}"; omitting icon.`);
  return null;
}

function collectSetupRequirements(runtime: z.infer<typeof AgentRuntimeSchema>): AgentSetupRequirement[] {
  const setup = runtime.aoa?.setup;
  const secretRequirements = (setup?.secrets ?? []).map((secret) => ({
    kind: "secret" as const,
    key: secret.key,
    label: secret.label,
    required: secret.required ?? true,
    reason: secret.reason,
    usedBy: secret.usedBy,
  }));
  const pluginRequirements = (setup?.pluginConfig ?? []).map((plugin) => ({
    kind: "plugin_config" as const,
    key: plugin.plugin,
    required: plugin.required ?? true,
    reason: plugin.reason,
    usedBy: plugin.plugin,
  }));
  return [...secretRequirements, ...pluginRequirements];
}

export function normalizeMarketplaceAgentTemplate(opts: {
  parsed: ParsedMarketplaceAgentTemplate;
  catalogItem: CatalogItem;
  availableAdapterTypes: string[];
  overrides?: { role?: AgentRole; adapterType?: string };
}): NormalizedMarketplaceAgentTemplate {
  const { parsed, catalogItem, availableAdapterTypes, overrides } = opts;
  const warnings: string[] = [];
  const installedAt = new Date().toISOString();

  if (parsed.kind === "legacy") {
    const role = overrides?.role ?? normalizeRole(parsed.template.role, warnings);
    const adapterType = overrides?.adapterType ?? parsed.template.adapterType ?? "process";
    const icon = normalizeIcon(parsed.template.icon, warnings);
    return {
      name: catalogItem.name,
      role,
      title: parsed.template.title ?? null,
      icon,
      status: "idle",
      capabilities: parsed.template.capabilities ?? null,
      adapterType,
      adapterConfig: parsed.template.adapterConfig ?? {},
      runtimeConfig: parsed.template.runtimeConfig ?? {},
      permissions: parsed.template.permissions ?? {},
      budgetMonthlyCents: parsed.template.budgetMonthlyCents ?? 0,
      skillKeys: parsed.template.skillKeys ?? [],
      instructions: { type: "inline", entryFile: "AGENTS.md", files: { "AGENTS.md": "" } },
      setupRequirements: [],
      setupRequired: false,
      metadata: {
        catalogCategory: catalogItem.category,
        catalogTags: catalogItem.tags,
        catalogTrustTier: catalogItem.trust.tier,
        installedAt,
      },
      warnings,
    };
  }

  const runtime = parsed.runtime;
  const setupRequirements = collectSetupRequirements(runtime);
  const setupRequired = setupRequirements.some((req) => req.required);
  const role = overrides?.role ?? normalizeRole(runtime.aoa?.install?.defaultRole, warnings);
  const suggestedAdapter =
    runtime.aoa?.adapterCompatibility?.recommended ??
    runtime.aoa?.adapterType ??
    runtime.aoa?.adapterCompatibility?.supported?.[0] ??
    "process";
  const adapterType = overrides?.adapterType ?? suggestedAdapter;
  if (!availableAdapterTypes.includes(adapterType)) {
    warnings.push(`Selected adapter "${adapterType}" is not currently active in AoA.`);
  }

  const instructions = runtime.instructions.type === "inline"
    ? { type: "inline" as const, entryFile: "AGENTS.md", files: { "AGENTS.md": runtime.instructions.content } }
    : runtime.instructions.type === "file"
      ? { type: "file" as const, entryFile: runtime.instructions.path, path: runtime.instructions.path }
      : { type: "bundle" as const, entryFile: runtime.instructions.entry, files: runtime.instructions.files };

  return {
    name: runtime.name || catalogItem.name,
    role,
    title: runtime.name,
    icon: normalizeIcon(runtime.aoa?.install?.defaultIcon, warnings),
    status: normalizeStatus(runtime.aoa?.install?.defaultStatus, setupRequired),
    capabilities: catalogItem.capabilities?.map((cap) => `${cap.id}: ${cap.description}`).join("\n") ?? null,
    adapterType,
    adapterConfig: runtime.aoa?.adapterConfig ?? {},
    runtimeConfig: runtime.aoa?.runtimeConfig ?? {},
    permissions: runtime.aoa?.permissions ?? {},
    budgetMonthlyCents: 0,
    skillKeys: runtime.aoa?.skillKeys ?? Object.values(runtime.dependencies?.skills ?? {}),
    instructions,
    setupRequirements,
    setupRequired,
    metadata: {
      catalogCategory: catalogItem.category,
      catalogTags: catalogItem.tags,
      catalogTrustTier: catalogItem.trust.tier,
      marketplaceAgentSchemaVersion: runtime.schemaVersion,
      marketplaceAgentId: runtime.id,
      marketplaceSetupRequired: setupRequired,
      marketplaceSetupRequirements: setupRequirements,
      marketplaceSetupNotes: runtime.aoa?.setup?.notes ?? [],
      marketplaceInstallWarnings: warnings,
      installedAt,
    },
    warnings,
  };
}
```

- [ ] **Step 5: Run parser tests**

Run:

```bash
pnpm test:run server/src/__tests__/marketplace-agent-runtime.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit parser work**

```bash
git add server/src/services/marketplace-install/agent-runtime.ts server/src/services/marketplace-install/types.ts server/src/__tests__/marketplace-agent-runtime.test.ts
git commit -m "feat(marketplace): parse agent runtime templates"
```

## Task 2: Fetch And Materialize Agent Instruction Bundles

**Files:**
- Modify: `server/src/services/marketplace-install/fetch-resource.ts`
- Create: `server/src/services/marketplace-install/agent-create.ts`
- Modify: `server/src/services/marketplace-install/agent-installer.ts`
- Test: `server/src/__tests__/marketplace-install-agent.test.ts`

- [ ] **Step 1: Add failing install tests for `agent.v1` bundles**

Extend `server/src/__tests__/marketplace-install-agent.test.ts` with:

```ts
it("installs agent.v1, materializes bundle instructions, and stores setup metadata", async () => {
  const materializeManagedBundle = vi.fn(async (_agent, files, options) => ({
    bundle: { files: [], entryFile: options.entryFile, managedRootPath: "/tmp/agent-1", resolvedEntryPath: "/tmp/agent-1/AGENTS.md", warnings: [] },
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
      values: (row: any) => ({
        returning: () => Promise.resolve([{ ...row, id: "agent-uuid-1" }]),
      }),
    }),
    update: () => ({
      set: (patch: any) => {
        updates.push(patch);
        return { where: () => ({ returning: () => Promise.resolve([{ id: "agent-uuid-1", ...patch }]) }) };
      },
    }),
  };

  global.fetch = vi.fn(async (url: string) => {
    if (url.endsWith("/agent.json")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({
        schemaVersion: "agent.v1",
        id: "github-issue-triager",
        name: "GitHub Issue Triager",
        description: "Triages GitHub issues",
        instructions: { type: "bundle", entry: "AGENTS.md", files: ["AGENTS.md", "SOUL.md", "TOOLS.md", "HEARTBEAT.md"] },
        aoa: {
          adapterCompatibility: { recommended: "codex_local", supported: ["codex_local"] },
          install: { defaultRole: "general", defaultStatus: "active", defaultIcon: "git-branch" },
          skillKeys: ["skill:github-skills/openai/skills/gh-address-comments"],
          setup: {
            secrets: [{ key: "GITHUB_TOKEN", label: "GitHub token", required: true, reason: "Required for GitHub." }],
          },
        },
      }) };
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
```

- [ ] **Step 2: Run the focused install test and confirm failure**

Run:

```bash
pnpm test:run server/src/__tests__/marketplace-install-agent.test.ts
```

Expected: new test fails because install agent does not understand `agent.v1`.

- [ ] **Step 3: Add sibling fetch helper**

In `server/src/services/marketplace-install/fetch-resource.ts`, add:

```ts
export async function fetchCatalogResourceUrl(url: string, kind: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${kind}: HTTP ${res.status} from ${url}`);
  }
  return await res.text();
}
```

- [ ] **Step 4: Add shared agent create helper**

Create `server/src/services/marketplace-install/agent-create.ts` with:

```ts
import type { Db } from "@armyofagents/db";
import { agents } from "@armyofagents/db";
import type { CatalogItem } from "@armyofagents/shared";
import { eq } from "drizzle-orm";
import { fetchCatalogResourceUrl } from "./fetch-resource.js";
import { deriveSiblingResourceUrl } from "./agent-runtime.js";
import type { NormalizedMarketplaceAgentTemplate } from "./types.js";

export interface AgentInstructionsServiceLike {
  materializeManagedBundle(
    agent: {
      id: string;
      companyId: string;
      name: string;
      role: string;
      adapterType: string;
      adapterConfig: unknown;
    },
    files: Record<string, string>,
    options?: { clearLegacyPromptTemplate?: boolean; replaceExisting?: boolean; entryFile?: string },
  ): Promise<{ adapterConfig: Record<string, unknown> }>;
}

export async function loadMarketplaceInstructionFiles(
  catalogItem: CatalogItem,
  template: NormalizedMarketplaceAgentTemplate,
): Promise<{ files: Record<string, string>; entryFile: string } | null> {
  if (template.instructions.type === "inline") {
    return { files: template.instructions.files, entryFile: template.instructions.entryFile };
  }
  if (template.instructions.type === "file") {
    const url = deriveSiblingResourceUrl(catalogItem, template.instructions.path);
    return {
      files: { [template.instructions.entryFile]: await fetchCatalogResourceUrl(url, "agent instructions") },
      entryFile: template.instructions.entryFile,
    };
  }
  const entries = await Promise.all(template.instructions.files.map(async (file) => {
    const url = deriveSiblingResourceUrl(catalogItem, file);
    return [file, await fetchCatalogResourceUrl(url, `agent instruction file ${file}`)] as const;
  }));
  return { files: Object.fromEntries(entries), entryFile: template.instructions.entryFile };
}

export async function createMarketplaceAgent(opts: {
  catalogItem: CatalogItem;
  companyId: string;
  db: Db;
  desiredName: string;
  template: NormalizedMarketplaceAgentTemplate;
  instructionsService?: AgentInstructionsServiceLike;
}): Promise<{ agentId: string }> {
  const { catalogItem, companyId, db, desiredName, template, instructionsService } = opts;

  const inserted = await db
    .insert(agents)
    .values({
      companyId,
      name: desiredName,
      role: template.role,
      title: template.title,
      icon: template.icon,
      status: template.status,
      capabilities: template.capabilities,
      adapterType: template.adapterType,
      adapterConfig: template.adapterConfig,
      runtimeConfig: template.runtimeConfig,
      permissions: template.permissions,
      budgetMonthlyCents: template.budgetMonthlyCents,
      skillKeys: template.skillKeys,
      templateOrigin: catalogItem.id,
      templateVersion: catalogItem.version,
      metadata: template.metadata,
    })
    .returning();

  const agent = inserted[0];
  const instructions = instructionsService
    ? await loadMarketplaceInstructionFiles(catalogItem, template)
    : null;

  if (instructions && instructionsService) {
    const materialized = await instructionsService.materializeManagedBundle(
      agent,
      instructions.files,
      { entryFile: instructions.entryFile, replaceExisting: true, clearLegacyPromptTemplate: true },
    );
    await db
      .update(agents)
      .set({ adapterConfig: materialized.adapterConfig, updatedAt: new Date() })
      .where(eq(agents.id, agent.id));
  }

  return { agentId: agent.id };
}
```

- [ ] **Step 5: Update `installAgent` to use parser/create helper**

Modify `server/src/services/marketplace-install/agent-installer.ts`:

```ts
export interface InstallAgentOpts {
  catalogItem: CatalogItem;
  companyId: string;
  db: Db;
  desiredName: string;
  overrides?: AgentInstallOverrides;
  availableAdapterTypes?: string[];
  instructionsService?: AgentInstructionsServiceLike;
}
```

Then parse and normalize:

```ts
const parsed = parseMarketplaceAgentTemplate(bodyText, catalogItem);
const template = normalizeMarketplaceAgentTemplate({
  parsed,
  catalogItem,
  availableAdapterTypes: opts.availableAdapterTypes ?? [],
  overrides: opts.overrides,
});
return createMarketplaceAgent({
  catalogItem,
  companyId,
  db,
  desiredName,
  template,
  instructionsService: opts.instructionsService,
});
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm test:run server/src/__tests__/marketplace-agent-runtime.test.ts server/src/__tests__/marketplace-install-agent.test.ts
```

Expected: both pass.

- [ ] **Step 7: Commit instruction install work**

```bash
git add server/src/services/marketplace-install/fetch-resource.ts server/src/services/marketplace-install/agent-create.ts server/src/services/marketplace-install/agent-installer.ts server/src/__tests__/marketplace-install-agent.test.ts
git commit -m "feat(marketplace): install agent instruction bundles"
```

## Task 3: Execute Direct Agent Dependency Cascade

**Files:**
- Modify: `server/src/services/marketplace-install/orchestrator.ts`
- Modify: `server/src/services/marketplace-install/resolver.ts`
- Test: `server/src/__tests__/marketplace-install-orchestrator.test.ts`
- Test: `server/src/__tests__/marketplace-install-resolver.test.ts`

- [ ] **Step 1: Add failing direct agent cascade test**

In `server/src/__tests__/marketplace-install-orchestrator.test.ts`, add:

```ts
it("installs direct agent dependencies before creating the agent", async () => {
  const SKILL = { ...SKILL_ITEM, id: "skill:aoa-curated/code-review", type: "skill" as const, name: "Code Review" };
  const PLUGIN = {
    ...SKILL_ITEM,
    id: "plugin:aoa-curated/aoa-plugin-github-issues",
    type: "plugin" as const,
    name: "GitHub Issues",
    npm: { packageName: "aoa-plugin-github-issues", version: "1.0.0" },
  };
  const AGENT = {
    ...SKILL_ITEM,
    id: "agent:aoa-curated/github-issue-triager",
    type: "agent" as const,
    name: "GitHub Issue Triager",
    requires: [
      { type: "skill", id: SKILL.id },
      { type: "plugin", id: PLUGIN.id },
    ],
  };
  const callOrder: string[] = [];

  await dispatchInstall({
    operation: { id: "op-1", catalogItemId: AGENT.id, itemType: "agent", companyId: "c1", targetDepartmentId: "dept-1" } as any,
    catalogItem: AGENT,
    catalog: { schemaVersion: "1.0.0", generatedAt: "2026-05-14T00:00:00Z", itemCount: 3, items: [AGENT, SKILL, PLUGIN] },
    db: { select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) } as any,
    installers: {
      installSkill: vi.fn(async () => { callOrder.push("skill"); return { skillId: "skill-row" }; }),
      installPlugin: vi.fn(async () => { callOrder.push("plugin"); return { pluginId: "plugin-row", alreadyInstalled: false }; }),
      installAgent: vi.fn(async () => { callOrder.push("agent"); return { agentId: "agent-row" }; }),
      installTeam: vi.fn(),
    },
    updateOperation: vi.fn(),
    publishLiveEvent: vi.fn(),
  });

  expect(callOrder).toEqual(["skill", "plugin", "agent"]);
});
```

- [ ] **Step 2: Add failing resolver company-scope test**

In `server/src/__tests__/marketplace-install-resolver.test.ts`, add:

```ts
it("plugin classification is company-scoped", async () => {
  const calls: unknown[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: (condition: unknown) => {
          calls.push(condition);
          return { limit: () => Promise.resolve([]) };
        },
      }),
    }),
  };

  const result = await classifyAction({ item: SLACK_PLUGIN, db: db as any, companyId: "company-a" });
  expect(result.action).toBe("install-new");
  expect(calls).toHaveLength(1);
});
```

This test mainly protects the fix; also inspect `resolver.ts` manually to ensure `companyId` is used in the plugin query.

- [ ] **Step 3: Run tests and confirm failure**

Run:

```bash
pnpm test:run server/src/__tests__/marketplace-install-orchestrator.test.ts server/src/__tests__/marketplace-install-resolver.test.ts
```

Expected: direct agent cascade test fails.

- [ ] **Step 4: Fix resolver plugin classification**

In `server/src/services/marketplace-install/resolver.ts`, change the plugin query to:

```ts
.where(
  and(
    eq(plugins.companyId, companyId),
    eq(plugins.packageName, item.npm.packageName),
  ),
)
```

Update the misleading comment to state plugins are company-scoped in current AoA install state.

- [ ] **Step 5: Add cascade helper in orchestrator**

In `server/src/services/marketplace-install/orchestrator.ts`, add a helper:

```ts
async function installDependenciesForItem(opts: {
  root: CatalogItem;
  catalog: MarketplaceCatalogFile;
  companyId: string;
  db: Db;
  installers: Installers;
}): Promise<CascadeStepResult[]> {
  const itemsById = new Map(opts.catalog.items.map((item) => [item.id, item]));
  const results: CascadeStepResult[] = [];

  for (const req of opts.root.requires ?? []) {
    const item = itemsById.get(req.id);
    if (!item) throw new Error(`Required catalog item not found: ${req.id}`);
    const started = Date.now();
    if (item.type === "skill") {
      const result = await opts.installers.installSkill({ catalogItem: item, companyId: opts.companyId, db: opts.db });
      results.push({
        step: "skill-install",
        itemId: item.id,
        status: result.alreadyInstalled ? "skipped" : "success",
        resultEntityId: result.skillId,
        durationMs: Date.now() - started,
      });
    } else if (item.type === "plugin") {
      const result = await opts.installers.installPlugin({ catalogItem: item, companyId: opts.companyId, db: opts.db });
      results.push({
        step: "plugin-precondition",
        itemId: item.id,
        status: result.alreadyInstalled ? "skipped" : "success",
        resultEntityId: result.pluginId,
        durationMs: Date.now() - started,
      });
    } else {
      throw new Error(`Direct agent dependency ${item.id} has unsupported type ${item.type}`);
    }
  }

  return results;
}
```

- [ ] **Step 6: Use dependency helper for agent branch**

In the `catalogItem.type === "agent"` branch, call dependency helper before `installAgent`:

```ts
cascadeResults = await installDependenciesForItem({
  root: catalogItem,
  catalog,
  companyId: operation.companyId,
  db,
  installers,
});
const r = await installers.installAgent({
  catalogItem,
  companyId: operation.companyId,
  db,
  desiredName: resolvedName,
  overrides: operation.installOverrides,
});
cascadeResults.push({
  step: "agent-install",
  itemId: catalogItem.id,
  status: "success",
  resultEntityId: r.agentId,
  durationMs: 0,
});
```

Do not add install overrides to `OperationRow` or the database table. Keep overrides request-scoped on `DispatchInstallOpts` so idempotency/status rows remain unchanged.

- [ ] **Step 7: Run focused tests**

Run:

```bash
pnpm test:run server/src/__tests__/marketplace-install-orchestrator.test.ts server/src/__tests__/marketplace-install-resolver.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit cascade work**

```bash
git add server/src/services/marketplace-install/orchestrator.ts server/src/services/marketplace-install/resolver.ts server/src/__tests__/marketplace-install-orchestrator.test.ts server/src/__tests__/marketplace-install-resolver.test.ts
git commit -m "feat(marketplace): cascade agent dependencies"
```

## Task 4: Add Install Request Overrides And Server Validation

**Files:**
- Modify: `server/src/services/marketplace-install/types.ts`
- Modify: `server/src/routes/marketplace-installs.ts`
- Modify: `server/src/services/marketplace-install/orchestrator.ts`
- Test: `server/src/__tests__/marketplace-installs-request.test.ts`

- [ ] **Step 1: Add failing route tests**

In `server/src/__tests__/marketplace-installs-request.test.ts`, add tests:

```ts
it("accepts agent install role and adapter overrides", async () => {
  const res = await request(app)
    .post("/api/companies/c1/marketplace/install")
    .send({
      catalogItemId: "agent:aoa-curated/senior-engineer",
      targetDepartmentId: "11111111-1111-4111-8111-111111111111",
      role: "lead",
      adapterType: "codex_local",
    });

  expect(res.status).toBe(202);
  expect(dispatchInstall).toHaveBeenCalledWith(expect.objectContaining({
    installOverrides: { role: "lead", adapterType: "codex_local" },
  }));
});

it("rejects invalid agent role override", async () => {
  const res = await request(app)
    .post("/api/companies/c1/marketplace/install")
    .send({
      catalogItemId: "agent:aoa-curated/senior-engineer",
      targetDepartmentId: "11111111-1111-4111-8111-111111111111",
      role: "engineering",
    });

  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Update install request schema**

In `server/src/routes/marketplace-installs.ts`:

```ts
const InstallRequestSchema = z.object({
  catalogItemId: z.string().min(1),
  targetDepartmentId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(1).max(100).optional(),
  role: z.enum(["cxo", "lead", "general"]).optional(),
  adapterType: z.string().min(1).optional(),
});
```

- [ ] **Step 3: Extend `InstallRequest` type**

In `server/src/services/marketplace-install/types.ts`:

```ts
export interface InstallRequest {
  catalogItemId: string;
  targetDepartmentId?: string;
  idempotencyKey?: string;
  role?: "cxo" | "lead" | "general";
  adapterType?: string;
}
```

- [ ] **Step 4: Pass overrides into dispatch**

In route:

```ts
void dispatchInstall({
  operation,
  catalogItem,
  catalog,
  db,
  installers,
  publishLiveEvent,
  installOverrides: {
    role: request.role,
    adapterType: request.adapterType,
  },
});
```

In orchestrator `DispatchInstallOpts`, add:

```ts
installOverrides?: AgentInstallOverrides;
```

Then pass to `installAgent`.

- [ ] **Step 5: Pass active adapter information**

In `server/src/routes/marketplace-installs.ts`, import `listServerAdapters` and pass:

```ts
availableAdapterTypes: listServerAdapters().map((adapter) => adapter.type),
instructionsService: agentInstructionsService(),
```

into `installAgent` through the installer wrapper.

- [ ] **Step 6: Run route tests**

Run:

```bash
pnpm test:run server/src/__tests__/marketplace-installs-request.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit route override work**

```bash
git add server/src/routes/marketplace-installs.ts server/src/services/marketplace-install/types.ts server/src/services/marketplace-install/orchestrator.ts server/src/__tests__/marketplace-installs-request.test.ts
git commit -m "feat(marketplace): accept agent install overrides"
```

## Task 5: Add Agent Setup Preview To Resolve Plan

**Files:**
- Modify: `server/src/services/marketplace-install/types.ts`
- Modify: `server/src/services/marketplace-install/resolver.ts`
- Modify: `ui/src/api/marketplace.ts`
- Test: `server/src/__tests__/marketplace-install-resolver.test.ts`

- [ ] **Step 1: Add failing resolver test**

Add:

```ts
it("includes agent setup and install suggestions in resolve plan", async () => {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      schemaVersion: "agent.v1",
      id: "github-issue-triager",
      name: "GitHub Issue Triager",
      description: "Triages GitHub issues",
      instructions: { type: "inline", content: "Triage issues." },
      aoa: {
        adapterCompatibility: { recommended: "codex_local", supported: ["codex_local", "claude_local"] },
        install: { defaultRole: "general", defaultStatus: "paused", defaultIcon: "git-branch" },
        setup: {
          secrets: [{ key: "GITHUB_TOKEN", label: "GitHub token", required: true, reason: "Required for GitHub." }],
        },
      },
    }),
  })) as any;

  const plan = await resolveInstallPlan({
    catalogItemId: REQUIRED_AGENT.id,
    catalog: FULL_CATALOG,
    db: mockEmptyDb() as any,
    companyId: "c1",
    availableAdapterTypes: ["codex_local", "claude_local"],
  });

  expect(plan.agentInstall?.suggestedRole).toBe("general");
  expect(plan.agentInstall?.suggestedAdapterType).toBe("codex_local");
  expect(plan.agentInstall?.setupRequired).toBe(true);
  expect(plan.agentInstall?.setupRequirements[0].key).toBe("GITHUB_TOKEN");
});
```

- [ ] **Step 2: Extend `InstallPlan` type**

In `server/src/services/marketplace-install/types.ts`:

```ts
export interface AgentInstallPreview {
  suggestedRole: "cxo" | "lead" | "general";
  supportedRoles: Array<"cxo" | "lead" | "general">;
  suggestedAdapterType: string;
  supportedAdapterTypes: string[];
  availableAdapterTypes: string[];
  setupRequired: boolean;
  setupRequirements: AgentSetupRequirement[];
  warnings: string[];
}

export interface InstallPlan {
  rootItem: CatalogItem;
  steps: InstallPlanStep[];
  conflicts: ConflictWarning[];
  agentInstall?: AgentInstallPreview;
}
```

- [ ] **Step 3: Add resolver preview logic**

In `resolver.ts`, extend `ResolveOpts`:

```ts
availableAdapterTypes?: string[];
```

If root item is `agent`, fetch `agent.json`, parse, normalize, and set `agentInstall`.

- [ ] **Step 4: Extend UI API types**

In `ui/src/api/marketplace.ts`, mirror `AgentInstallPreview` and add optional `agentInstall?: AgentInstallPreview` to `InstallPlan`.

- [ ] **Step 5: Run resolver test**

Run:

```bash
pnpm test:run server/src/__tests__/marketplace-install-resolver.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit preview work**

```bash
git add server/src/services/marketplace-install/types.ts server/src/services/marketplace-install/resolver.ts ui/src/api/marketplace.ts server/src/__tests__/marketplace-install-resolver.test.ts
git commit -m "feat(marketplace): preview agent install setup"
```

## Task 6: Update Install Modal For Agents

**Files:**
- Modify: `ui/src/components/marketplace/install/SnapshotInstallModal.tsx`
- Modify: `ui/src/components/marketplace/install/CascadeTreePreview.tsx`
- Test: `ui/src/components/marketplace/install/__tests__/SnapshotInstallModal.test.tsx`
- Test: `ui/src/components/marketplace/install/__tests__/CascadeTreePreview.test.tsx`

- [ ] **Step 1: Add failing UI tests**

In `SnapshotInstallModal.test.tsx`, add:

```tsx
it("renders dependency preview, role selector, adapter selector, and setup warning for agents", async () => {
  const agent = {
    ...CODE_REVIEW_SKILL,
    id: "agent:aoa-curated/github-issue-triager",
    type: "agent" as const,
    name: "GitHub Issue Triager",
    requires: [{ type: "plugin", id: "plugin:aoa-curated/aoa-plugin-github-issues" }],
  };

  vi.mocked(marketplaceApi.resolvePlan).mockResolvedValue({
    rootItem: { id: agent.id, name: agent.name, type: "agent", version: "1.0.0" },
    steps: [
      { catalogItemId: "plugin:aoa-curated/aoa-plugin-github-issues", itemType: "plugin", name: "GitHub Issues", version: "1.0.0", action: "install-new" },
      { catalogItemId: agent.id, itemType: "agent", name: agent.name, version: "1.0.0", action: "install-new" },
    ],
    conflicts: [],
    agentInstall: {
      suggestedRole: "general",
      supportedRoles: ["cxo", "lead", "general"],
      suggestedAdapterType: "codex_local",
      supportedAdapterTypes: ["codex_local", "claude_local"],
      availableAdapterTypes: ["codex_local", "claude_local"],
      setupRequired: true,
      setupRequirements: [{ kind: "secret", key: "GITHUB_TOKEN", label: "GitHub token", required: true, reason: "Required for GitHub." }],
      warnings: [],
    },
  });

  wrap(<SnapshotInstallModal item={agent} open onOpenChange={() => {}} />);

  expect(await screen.findByText(/Installing this agent will also install/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/Role/i)).toHaveValue("general");
  expect(screen.getByLabelText(/Adapter/i)).toHaveValue("codex_local");
  expect(screen.getByText(/will be installed paused/i)).toBeInTheDocument();
  expect(screen.getByText(/GITHUB_TOKEN/i)).toBeInTheDocument();
});
```

Add install payload assertion:

```tsx
it("submits selected role and adapter for agent install", async () => {
  // Render agent modal, select role lead and adapter claude_local, click Install.
  // Assert marketplaceApi.install called with { role: "lead", adapterType: "claude_local" }.
});
```

- [ ] **Step 2: Generalize cascade heading**

In `CascadeTreePreview.tsx`, add prop:

```ts
export interface CascadeTreePreviewProps {
  plan: InstallPlan;
  rootType?: "agent" | "team";
}
```

Heading:

```tsx
const noun = rootType ?? plan.rootItem.type;
<h4>{`Installing this ${noun} will also install:`}</h4>
```

- [ ] **Step 3: Resolve plan for agents and teams**

In `SnapshotInstallModal.tsx`, replace:

```ts
const isTeam = item.type === "team";
```

with:

```ts
const hasCascadePreview = item.type === "team" || item.type === "agent";
```

Call `useResolvePlan` when `hasCascadePreview`.

- [ ] **Step 4: Add local role and adapter state**

```ts
const [selectedRole, setSelectedRole] = useState<"cxo" | "lead" | "general">("general");
const [selectedAdapterType, setSelectedAdapterType] = useState<string>("");

useEffect(() => {
  if (plan?.agentInstall) {
    setSelectedRole(plan.agentInstall.suggestedRole);
    setSelectedAdapterType(plan.agentInstall.suggestedAdapterType);
  }
}, [plan?.agentInstall]);
```

- [ ] **Step 5: Render role selector for agents**

Use existing UI select component if available. If there is no local select primitive, use a styled native select:

```tsx
{item.type === "agent" && plan?.agentInstall && (
  <label className="block space-y-1 text-sm">
    <span className="font-medium">Role</span>
    <select
      aria-label="Role"
      value={selectedRole}
      onChange={(event) => setSelectedRole(event.target.value as typeof selectedRole)}
      className="h-9 w-full rounded-md border bg-background px-3 text-sm"
    >
      <option value="lead">Lead</option>
      <option value="general">General</option>
      <option value="cxo">Executive</option>
    </select>
  </label>
)}
```

- [ ] **Step 6: Render adapter selector for agents**

```tsx
const adapterOptions = plan?.agentInstall?.supportedAdapterTypes.filter((adapter) =>
  plan.agentInstall?.availableAdapterTypes.includes(adapter)
) ?? [];
```

Render:

```tsx
{item.type === "agent" && plan?.agentInstall && (
  <label className="block space-y-1 text-sm">
    <span className="font-medium">Adapter</span>
    <select
      aria-label="Adapter"
      value={selectedAdapterType}
      onChange={(event) => setSelectedAdapterType(event.target.value)}
      className="h-9 w-full rounded-md border bg-background px-3 text-sm"
      disabled={adapterOptions.length === 0}
    >
      {adapterOptions.map((adapter) => (
        <option key={adapter} value={adapter}>{adapter}</option>
      ))}
    </select>
  </label>
)}
```

- [ ] **Step 7: Render setup warning**

```tsx
{item.type === "agent" && plan?.agentInstall?.setupRequired && (
  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
    This agent will be installed paused until setup is complete.
    <ul className="mt-2 list-disc pl-5">
      {plan.agentInstall.setupRequirements.map((req) => (
        <li key={`${req.kind}:${req.key}`}>
          <strong>{req.label ?? req.key}</strong>: {req.reason}
        </li>
      ))}
    </ul>
  </div>
)}
```

- [ ] **Step 8: Include overrides in install payload**

In `handleInstall`:

```ts
const agentOverrides = item.type === "agent"
  ? { role: selectedRole, adapterType: selectedAdapterType }
  : {};

const result = await installMutation.mutateAsync({
  catalogItemId: item.id,
  ...(needsDept && deptId ? { targetDepartmentId: deptId } : {}),
  ...agentOverrides,
});
```

- [ ] **Step 9: Run UI focused tests**

Run:

```bash
pnpm --filter @armyofagents/ui test:run ui/src/components/marketplace/install/__tests__/SnapshotInstallModal.test.tsx ui/src/components/marketplace/install/__tests__/CascadeTreePreview.test.tsx
```

Expected: pass.

- [ ] **Step 10: Commit UI modal work**

```bash
git add ui/src/components/marketplace/install/SnapshotInstallModal.tsx ui/src/components/marketplace/install/CascadeTreePreview.tsx ui/src/components/marketplace/install/__tests__/SnapshotInstallModal.test.tsx ui/src/components/marketplace/install/__tests__/CascadeTreePreview.test.tsx
git commit -m "feat(marketplace): configure agent installs in modal"
```

## Task 7: Keep Team Agent Installs Compatible

**Files:**
- Modify: `server/src/services/marketplace-install/team-installer.ts`
- Test: `server/src/__tests__/marketplace-install-team-cascade.test.ts`

- [ ] **Step 1: Add failing team test with `agent.v1` body**

In `marketplace-install-team-cascade.test.ts`, change one test fetch response for `agent.json` to return `agent.v1` and assert agent row:

```ts
text: async () => JSON.stringify({
  schemaVersion: "agent.v1",
  id: "engineer",
  name: "Engineer",
  description: "Engineer agent",
  instructions: { type: "inline", content: "Engineer instructions." },
  aoa: {
    adapterCompatibility: { recommended: "codex_local", supported: ["codex_local"] },
    install: { defaultRole: "lead", defaultStatus: "paused", defaultIcon: "code" },
    skillKeys: [SKILL.id],
  },
}),
```

Assert:

```ts
expect(agentInserts[0].role).toBe("lead");
expect(agentInserts[0].adapterType).toBe("codex_local");
expect(agentInserts[0].status).toBe("paused");
expect(agentInserts[0].skillKeys).toEqual([SKILL.id]);
```

- [ ] **Step 2: Refactor team installer agent body parsing**

In `team-installer.ts`, replace `AgentTemplateBody` parsing with:

```ts
const parsed = parseMarketplaceAgentTemplate(text, a);
const normalized = normalizeMarketplaceAgentTemplate({
  parsed,
  catalogItem: a,
  availableAdapterTypes: ["codex_local", "claude_local", "cursor", "opencode_local", "gemini_local", "process", "http"],
});
agentBodies.set(a.id, normalized);
```

Use `NormalizedMarketplaceAgentTemplate` for agent row insert.

- [ ] **Step 3: Preserve current team behavior**

Add `instructionsService?: AgentInstructionsServiceLike` to `InstallTeamOpts`, pass it from `marketplace-installs.ts`, and use `createMarketplaceAgent` for each team agent so team-installed marketplace agents get the same managed instruction bundles as direct agent installs.

When calling `createMarketplaceAgent` inside the team transaction, pass `db: tx as unknown as Db` and keep the existing team-member linking logic based on the returned `agentId`.

- [ ] **Step 4: Run team cascade tests**

Run:

```bash
pnpm test:run server/src/__tests__/marketplace-install-team-cascade.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit team compatibility**

```bash
git add server/src/services/marketplace-install/team-installer.ts server/src/__tests__/marketplace-install-team-cascade.test.ts
git commit -m "fix(marketplace): support agent runtime templates in team installs"
```

## Task 8: Add Post-Install Setup Links

**Files:**
- Modify: `ui/src/components/marketplace/install/SnapshotInstallModal.tsx`
- Modify: `ui/src/components/marketplace/toast/useInstallToast.ts`
- Test: `ui/src/components/marketplace/install/__tests__/SnapshotInstallModal.test.tsx`

- [ ] **Step 1: Add UI test for setup guidance after install**

Add:

```tsx
it("shows setup guidance when setup-required agent install succeeds", async () => {
  vi.mocked(marketplaceApi.install).mockResolvedValue({ operationId: "op-1", status: "pending" });
  vi.mocked(marketplaceApi.getOperation).mockResolvedValue({
    id: "op-1",
    companyId: "c1",
    catalogItemId: "agent:aoa-curated/github-issue-triager",
    itemType: "agent",
    targetDepartmentId: "d1",
    status: "success",
    resultEntityId: "agent-1",
    errorMessage: null,
    cascadeResults: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  });

  // Render, install, and assert toast/detail text includes "Finish setup".
});
```

- [ ] **Step 2: Add toast detail message for setup-required plans**

When `opStatus.status === "success"` and `item.type === "agent"` and `plan.agentInstall.setupRequired`, set toast message/detail:

```ts
update(pendingToastId, {
  status: "success",
  message: `Installed ${item.name} paused`,
  detail: "Finish required secrets or plugin configuration before activating this agent.",
});
```

- [ ] **Step 3: Add in-modal static links before install**

For setup-required agents, show text:

```tsx
After install, configure required secrets from Settings > Secrets and plugin settings from Plugins.
```

Use text guidance plus stable routes:

```tsx
<p className="text-xs text-muted-foreground">
  After install, configure secrets from Settings &gt; Secrets and plugin settings from Instance Settings &gt; Plugins.
</p>
```

- [ ] **Step 4: Run UI focused tests**

Run:

```bash
pnpm --filter @armyofagents/ui test:run ui/src/components/marketplace/install/__tests__/SnapshotInstallModal.test.tsx
```

Expected: pass.

- [ ] **Step 5: Commit setup guidance**

```bash
git add ui/src/components/marketplace/install/SnapshotInstallModal.tsx ui/src/components/marketplace/toast/useInstallToast.ts ui/src/components/marketplace/install/__tests__/SnapshotInstallModal.test.tsx
git commit -m "feat(marketplace): guide setup-required agent installs"
```

## Task 9: End-To-End Smoke Test

**Files:**
- Create: `tests/e2e/marketplace-agent-install.spec.ts`
- Modify: `tests/e2e/playwright.config.ts` only if the suite requires explicit inclusion.

- [ ] **Step 1: Add E2E scenario**

Create `tests/e2e/marketplace-agent-install.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("marketplace agent install shows dependencies and setup warning", async ({ page }) => {
  await page.goto("/marketplace");
  await page.getByRole("button", { name: /Agents/i }).click();
  await page.getByText("GitHub Issue Triager").click();
  await page.getByRole("button", { name: /^Install$/ }).click();

  await expect(page.getByText(/GitHub Issues/i)).toBeVisible();
  await expect(page.getByLabel(/Role/i)).toBeVisible();
  await expect(page.getByLabel(/Adapter/i)).toBeVisible();
  await expect(page.getByText(/installed paused/i)).toBeVisible();
});
```

Use the visible Marketplace filter/button labels from `ui/src/pages/Marketplace.tsx` and the install modal labels added in Task 6.

- [ ] **Step 2: Run E2E test**

Run:

```bash
pnpm test:e2e -- marketplace-agent-install.spec.ts
```

Expected: pass locally with dev server fixture.

- [ ] **Step 3: Commit E2E test**

```bash
git add tests/e2e/marketplace-agent-install.spec.ts tests/e2e/playwright.config.ts
git commit -m "test(e2e): cover marketplace agent install preview"
```

## Task 10: Final Verification

**Files:**
- All modified files.

- [ ] **Step 1: Run focused server tests**

```bash
pnpm test:run \
  server/src/__tests__/marketplace-agent-runtime.test.ts \
  server/src/__tests__/marketplace-install-agent.test.ts \
  server/src/__tests__/marketplace-install-orchestrator.test.ts \
  server/src/__tests__/marketplace-install-resolver.test.ts \
  server/src/__tests__/marketplace-install-team-cascade.test.ts \
  server/src/__tests__/marketplace-installs-request.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run focused UI tests**

```bash
pnpm --filter @armyofagents/ui test:run \
  ui/src/components/marketplace/install/__tests__/SnapshotInstallModal.test.tsx \
  ui/src/components/marketplace/install/__tests__/CascadeTreePreview.test.tsx
```

Expected: all pass.

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```

Expected: all packages typecheck.

- [ ] **Step 4: Run full unit test suite if focused tests pass**

```bash
pnpm test:run
```

Expected: pass. If unrelated tests fail, record exact failures before deciding whether to fix or defer.

- [ ] **Step 5: Run E2E smoke**

```bash
pnpm test:e2e -- marketplace-agent-install.spec.ts
```

Expected: pass.

- [ ] **Step 6: Check diff hygiene**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intended files changed.

## Implementation Notes

- Do not collect secret values in the marketplace install modal in this PR.
- Do not auto-activate an agent with required setup. Force `paused`.
- Do not silently use `process` when a marketplace agent asks for Codex/Claude and no supported adapter is active. Show UI warning and keep install paused.
- Keep `manifest.requires`/catalog `requires` as the only install dependency source.
- Use `agent.json.dependencies` and `aoa.skillKeys` as runtime mapping hints only.
- Keep parser tolerant to legacy flat `agent.json` until old catalog fixtures are migrated.
- Prefer shared helper functions over duplicating the legacy agent insert shape in direct agent and team install paths.

## Self-Review Checklist

- [ ] Direct agent install installs required skills first.
- [ ] Direct agent install installs required plugins first.
- [ ] Direct agent install creates the agent only after dependency install succeeds.
- [ ] Agent install supports `agent.v1` bundle instructions.
- [ ] Agent install still supports legacy flat agent templates.
- [ ] Required setup forces `paused`.
- [ ] Suggested role is visible and editable in the UI.
- [ ] Suggested adapter is visible and editable in the UI.
- [ ] Unknown role/icon marketplace hints do not crash install.
- [ ] Setup requirements are visible before install and stored after install.
- [ ] Tests cover skill-only and skill+plugin+setup agents.
- [ ] Typecheck and focused tests are included in final verification.
