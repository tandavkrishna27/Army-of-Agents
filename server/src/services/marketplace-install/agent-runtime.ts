import { z } from "zod";
import {
  AGENT_ICON_NAMES,
  AGENT_ROLES,
  AGENT_STATUSES,
  type AgentRole,
  type AgentStatus,
  type CatalogItem,
} from "@armyofagents/shared";
import type { AgentSetupRequirement, NormalizedMarketplaceAgentTemplate } from "./types.js";

const AgentInstructionPathSchema = z.string().trim().min(1);

const AgentInlineInstructionsSchema = z.object({
  type: z.literal("inline"),
  content: z.string().trim().min(1),
}).strict();

const AgentFileInstructionsSchema = z.object({
  type: z.literal("file"),
  path: AgentInstructionPathSchema,
}).strict();

const AgentBundleInstructionsSchema = z.object({
  type: z.literal("bundle"),
  entry: AgentInstructionPathSchema,
  files: z.array(AgentInstructionPathSchema).min(1),
}).strict().superRefine((instructions, ctx) => {
  const seenFiles = new Set<string>();
  for (const [index, file] of instructions.files.entries()) {
    if (seenFiles.has(file)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "duplicate bundle file",
        path: ["files", index],
      });
    }
    seenFiles.add(file);
  }

  if (!seenFiles.has(instructions.entry)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "entry must be included in files",
      path: ["entry"],
    });
  }
});

const AgentInstructionsSchema = z.union([
  AgentInlineInstructionsSchema,
  AgentFileInstructionsSchema,
  AgentBundleInstructionsSchema,
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
    // Phase 3 (T3.2): crew agent kind + triggers.
    // kind="aoa" marks this agent as trigger-driven (not heartbeat-driven).
    // triggers lists the aoa_agent_triggers rows to insert on install.
    kind: z.enum(["org", "aoa"]).optional(),
    // T2.3d: `enabled` is part of the published contract — every crew agent in
    // `aoa-curated` declares it (9/9 of those that declare triggers, verified
    // 2026-07-24). Omitting it from this `.strict()` object rejected every
    // published crew body with `unrecognized_keys: ["enabled"]`, which aborted
    // `installTeam` and degraded every live company create to the `@legacy`
    // seeders. Defaulting to `true` keeps pre-`enabled` templates behaving
    // exactly as before; the value is threaded to `aoa_agent_triggers.enabled`
    // at BOTH insert sites (`agent-create.ts`, `crew-updater.ts`) so a trigger
    // the catalog disabled is never installed — or re-enabled on update — as
    // enabled.
    triggers: z.array(
      z.object({
        kind: z.string().min(1),
        enabled: z.boolean().optional().default(true),
        config: z.record(z.unknown()).optional().default({}),
      }).strict(),
    ).optional(),
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

export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>;

export type ParsedMarketplaceAgentTemplate =
  | { kind: "agent.v1"; runtime: AgentRuntime }
  | { kind: "legacy"; template: z.infer<typeof LegacyAgentTemplateSchema> };

const ROLE_SET = new Set<string>(AGENT_ROLES);
const STATUS_SET = new Set<string>(AGENT_STATUSES);
const ICON_SET = new Set<string>(AGENT_ICON_NAMES);

export function isSafeAgentResourcePath(resourcePath: string): boolean {
  const normalized = resourcePath.replace(/\\/g, "/");
  if (!normalized) return false;
  if (normalized.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(normalized)) return false;
  if (normalized.includes("\0")) return false;
  return normalized
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function deriveSiblingResourceUrl(catalogItem: CatalogItem, relativePath: string): string {
  if (!catalogItem.resourceUrl) {
    throw new Error(`Agent ${catalogItem.id} has no resourceUrl`);
  }
  if (!isSafeAgentResourcePath(relativePath)) {
    throw new Error(`Unsafe agent resource path: ${relativePath}`);
  }

  const url = new URL(catalogItem.resourceUrl);
  if (!url.pathname.endsWith("/agent.json")) {
    throw new Error(`Agent ${catalogItem.id} resourceUrl must end with /agent.json`);
  }
  url.pathname = url.pathname.replace(/\/agent\.json$/, `/${relativePath}`);
  return url.toString();
}

export function parseMarketplaceAgentTemplate(
  bodyText: string,
  catalogItem: CatalogItem,
): ParsedMarketplaceAgentTemplate {
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch (err) {
    throw new Error(
      `Failed to parse agent template JSON for ${catalogItem.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
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
  if (typeof value === "string" && value.trim()) {
    warnings.push(`Unknown marketplace agent role "${value}"; using general.`);
  }
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

function collectSetupRequirements(runtime: AgentRuntime): AgentSetupRequirement[] {
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
    const role = overrides?.role ?? parsed.template.role ?? "general";
    const adapterType = overrides?.adapterType ?? parsed.template.adapterType ?? "process";
    const icon = normalizeIcon(parsed.template.icon, warnings);
    const adapterConfig = parsed.template.adapterConfig ?? {};
    const promptTemplate = adapterConfig.promptTemplate;
    const legacyPrompt = typeof promptTemplate === "string" ? promptTemplate.trim() : "";
    if (!legacyPrompt) {
      throw new Error("Legacy marketplace agent is missing non-empty adapterConfig.promptTemplate instructions.");
    }

    return {
      name: catalogItem.name,
      role,
      // Legacy agents are always org-kind; no triggers supported.
      kind: "org" as const,
      triggers: [],
      title: parsed.template.title ?? null,
      icon,
      status: "idle",
      capabilities: parsed.template.capabilities ?? null,
      adapterType,
      adapterConfig,
      runtimeConfig: parsed.template.runtimeConfig ?? {},
      permissions: parsed.template.permissions ?? {},
      budgetMonthlyCents: parsed.template.budgetMonthlyCents ?? 0,
      skillKeys: parsed.template.skillKeys ?? [],
      instructions: { type: "inline", entryFile: "AGENTS.md", files: { "AGENTS.md": legacyPrompt } },
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
  const setupRequired = setupRequirements.some((requirement) => requirement.required);
  const role = overrides?.role ?? normalizeRole(runtime.aoa?.install?.defaultRole, warnings);
  const suggestedAdapter =
    runtime.aoa?.adapterCompatibility?.recommended ??
    runtime.aoa?.adapterType ??
    runtime.aoa?.adapterCompatibility?.supported?.[0] ??
    "process";
  const adapterType = overrides?.adapterType ?? suggestedAdapter;
  if (availableAdapterTypes.length > 0 && !availableAdapterTypes.includes(adapterType)) {
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
    // kind defaults to "org" so existing agent.v1 catalog items without the field
    // continue to work. aoa.kind="aoa" marks the agent as trigger-driven.
    kind: (runtime.aoa?.kind ?? "org") as "org" | "aoa",
    triggers: (runtime.aoa?.triggers ?? []).map((t) => ({
      kind: t.kind,
      // Absent in the body → `true` via the schema default, so this preserves
      // the pre-T2.3d behaviour for templates that predate the field.
      enabled: t.enabled ?? true,
      config: t.config ?? {},
    })),
    title: runtime.name,
    icon: normalizeIcon(runtime.aoa?.install?.defaultIcon, warnings),
    status: normalizeStatus(runtime.aoa?.install?.defaultStatus, setupRequired),
    capabilities: catalogItem.capabilities
      ?.map((capability) => `${capability.id}: ${capability.description}`)
      .join("\n") ?? null,
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
