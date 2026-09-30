import { z } from "zod";
import { AGENT_COMPLETION_POLICIES, AGENT_COMPLETION_POLICY_SOURCES } from "../constants.js";
import { companySkillSourceTypeSchema } from "./company-skill.js";

export const portabilityCostEventsDateRangeSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

export const portabilityCostEventsIncludeSchema = z.union([
  z.boolean(),
  portabilityCostEventsDateRangeSchema,
]);

export const portabilityIncludeSchema = z
  .object({
    company: z.boolean().optional(),
    agents: z.boolean().optional(),
    projects: z.boolean().optional(),
    issues: z.boolean().optional(),
    skills: z.boolean().optional(),
    routines: z.boolean().optional(),
    envInputs: z.boolean().optional(),
    internalAgentConfig: z.boolean().optional(),
    budgetPolicies: z.boolean().optional(),
    costEvents: portabilityCostEventsIncludeSchema.optional(),
    financeEvents: z.boolean().optional(),
    quotaWindows: z.boolean().optional(),
    workflowTemplates: z.boolean().optional(),
  })
  .partial();

export const portabilitySecretRequirementSchema = z.object({
  key: z.string().min(1),
  description: z.string().nullable(),
  agentSlug: z.string().min(1).nullable(),
  providerHint: z.string().nullable(),
});

export const portabilityCompanyManifestEntrySchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  brandColor: z.string().nullable(),
  requireBoardApprovalForNewAgents: z.boolean(),
  agentCompletionPolicyDefault: z.enum(AGENT_COMPLETION_POLICIES).optional(),
  agentCompletionReviewGuardrail: z.boolean().optional(),
});

export const portabilityAgentManifestEntrySchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  role: z.string().min(1),
  title: z.string().nullable(),
  icon: z.string().nullable(),
  capabilities: z.string().nullable(),
  reportsToSlug: z.string().min(1).nullable(),
  parentType: z.string().min(1).nullable().optional(),
  parentIdRef: z.string().min(1).nullable().optional(),
  adapterType: z.string().min(1),
  adapterConfig: z.record(z.unknown()),
  runtimeConfig: z.record(z.unknown()),
  permissions: z.record(z.unknown()),
  budgetMonthlyCents: z.number().int().nonnegative(),
  metadata: z.record(z.unknown()).nullable(),
  skillKeys: z.array(z.string().min(1)).optional(),
});

export const portabilitySkillFileInventoryEntrySchema = z.object({
  path: z.string().min(1),
  kind: z.string().min(1),
});

export const portabilitySkillManifestEntrySchema = z.object({
  key: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  description: z.string().nullable().optional(),
  markdown: z.string().optional(),
  sourceType: companySkillSourceTypeSchema,
  sourceLocator: z.string().nullable().optional(),
  sourceRef: z.string().nullable().optional(),
  trustLevel: z.string().nullable().optional(),
  compatibility: z.string().nullable().optional(),
  fileInventory: z.array(portabilitySkillFileInventoryEntrySchema).optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

export const portabilityProjectManifestEntrySchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["department", "project"]),
  description: z.string().nullable().optional(),
  parentSlug: z.string().min(1).nullable().optional(),
  status: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  targetDate: z.string().nullable().optional(),
  leadAgentSlug: z.string().min(1).nullable().optional(),
  functionType: z.string().nullable().optional(),
  agentCompletionPolicyDefault: z.enum(AGENT_COMPLETION_POLICIES).nullable().optional(),
  executionWorkspacePolicy: z.record(z.unknown()).nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

export const portabilityIssueManifestEntrySchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  priority: z.string().nullable().optional(),
  projectSlug: z.string().min(1).nullable().optional(),
  assigneeAgentSlug: z.string().min(1).nullable().optional(),
  assigneeUserEmail: z.string().email().nullable().optional(),
  labelNames: z.array(z.string().min(1)).optional(),
  billingCode: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  identifier: z.string().nullable().optional(),
  recurring: z.boolean().nullable().optional(),
  assigneeAdapterOverrides: z.record(z.unknown()).nullable().optional(),
  executionWorkspaceSettings: z.record(z.unknown()).nullable().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  agentCompletionPolicyOverride: z.enum(AGENT_COMPLETION_POLICIES).nullable().optional(),
  agentCompletionPolicy: z.enum(AGENT_COMPLETION_POLICIES).optional(),
  agentCompletionPolicySource: z.enum(AGENT_COMPLETION_POLICY_SOURCES).optional(),
  agentCompletionPolicyResolvedAt: z.string().datetime({ offset: true }).optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

export const portabilityRoutineTriggerManifestEntrySchema = z.object({
  kind: z.enum(["schedule", "webhook", "api"]),
  label: z.string().nullable(),
  enabled: z.boolean(),
  cronExpression: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  signingMode: z.enum(["bearer", "hmac_sha256"]).nullable().optional(),
  replayWindowSec: z.number().int().nonnegative().nullable().optional(),
  publicId: z.string().nullable().optional(),
});

export const portabilityRoutineVariableManifestEntrySchema = z.object({
  name: z.string().min(1),
  label: z.string().nullable(),
  type: z.enum(["text", "textarea", "number", "boolean", "select"]),
  defaultValue: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  required: z.boolean(),
  options: z.array(z.string()),
});

export const portabilityEnvInputManifestEntrySchema = z.object({
  key: z.string().min(1),
  description: z.string().nullable(),
  agentSlug: z.string().min(1).nullable(),
  projectSlug: z.string().min(1).nullable(),
  kind: z.enum(["plain", "secret"]),
  requirement: z.enum(["required", "optional"]),
  defaultValue: z.string().nullable(),
  portability: z.enum(["portable", "system_dependent"]),
});

export const portabilityRoutineManifestEntrySchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  status: z.enum(["active", "paused", "archived"]),
  priority: z.string().min(1),
  concurrencyPolicy: z.enum(["coalesce_if_active", "always_enqueue", "skip_if_active"]),
  catchUpPolicy: z.enum(["skip_missed", "enqueue_missed_with_cap"]),
  agentCompletionPolicyOverride: z.enum(AGENT_COMPLETION_POLICIES).nullable().optional(),
  projectSlug: z.string().min(1),
  assigneeAgentSlug: z.string().min(1),
  variables: z.array(portabilityRoutineVariableManifestEntrySchema),
  triggers: z.array(portabilityRoutineTriggerManifestEntrySchema),
  metadata: z.record(z.unknown()).nullable().optional(),
});

export const portabilityBudgetPolicyManifestSchema = z
  .object({
    slug: z.string().min(1),
    scopeType: z.enum(["company", "agent"]),
    scopeAgentSlug: z.string().min(1).nullable().optional(),
    metric: z.string().min(1),
    windowKind: z.string().min(1),
    amountCents: z.number().int().nonnegative(),
    warnPercent: z.number().int().min(0).max(100),
    hardStopEnabled: z.boolean(),
    notifyEnabled: z.boolean(),
    isActive: z.boolean(),
    metadata: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough();

export const portabilityCostEventManifestSchema = z
  .object({
    slug: z.string().min(1),
    agentSlug: z.string().min(1).nullable(),
    issueSlug: z.string().min(1).nullable(),
    projectSlug: z.string().min(1).nullable(),
    goalSlug: z.string().min(1).nullable(),
    occurredAt: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().nullable(),
    biller: z.string().nullable(),
    billingType: z.string().nullable(),
    billingCode: z.string().nullable(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    costCents: z.number().int().nonnegative(),
    metadata: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough();

export const portabilityFinanceEventManifestSchema = z
  .object({
    slug: z.string().min(1),
    agentSlug: z.string().min(1).nullable(),
    issueSlug: z.string().min(1).nullable(),
    projectSlug: z.string().min(1).nullable(),
    goalSlug: z.string().min(1).nullable(),
    costEventSlug: z.string().min(1).nullable(),
    occurredAt: z.string().min(1),
    eventKind: z.string().min(1),
    direction: z.enum(["debit", "credit"]),
    biller: z.string().min(1),
    provider: z.string().nullable(),
    executionAdapterType: z.string().nullable(),
    pricingTier: z.string().nullable(),
    region: z.string().nullable(),
    model: z.string().nullable(),
    quantity: z.number().int().nullable(),
    unit: z.string().nullable(),
    amountCents: z.number().int(),
    currency: z.string().min(1),
    estimated: z.boolean(),
    externalInvoiceId: z.string().nullable(),
    billingCode: z.string().nullable(),
    description: z.string().nullable(),
    metadata: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough();

export const portabilityQuotaWindowManifestSchema = z
  .object({
    slug: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().nullable(),
    windowKind: z.string().min(1),
    label: z.string().nullable(),
    limitValue: z.number().int().nullable(),
    usedValue: z.number().int().nullable(),
    usedPercent: z.number().int().nullable(),
    valueLabel: z.string().nullable(),
    resetAt: z.string().nullable(),
    lastUpdatedAt: z.string().min(1),
    metadata: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough();

export const portabilityWorkflowTemplateManifestSchema = z
  .object({
    slug: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullable(),
    workspaceMode: z.string().min(1),
    agentCompletionPolicyOverride: z.enum(AGENT_COMPLETION_POLICIES).nullable().optional(),
    steps: z.array(z.unknown()),
    dependencies: z.array(z.unknown()),
    metadata: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough();

export const portabilityInternalAgentConfigManifestSchema = z
  .object({
    executionMode: z.string().min(1),
    provider: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    cliTool: z.string().nullable().optional(),
    autonomyLevel: z.number().int().min(0),
    // D18 dial-split — optional: pre-split bundles carry only `autonomyLevel`.
    crewAutonomyLevel: z.number().int().min(0).optional(),
    enabledCapabilities: z.array(z.string()).optional(),
    notificationPreference: z.string().min(1),
    contextTokenBudget: z.number().int().nonnegative(),
    budgetMonthlyCents: z.number().int().nonnegative().nullable().optional(),
    proactiveIntervalMinutes: z.number().int().nonnegative(),
    metadata: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough();

export const portabilityManifestSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    generatedAt: z.string().datetime(),
    source: z
      .object({
        companyId: z.string().uuid(),
        companyName: z.string().min(1),
      })
      .nullable(),
    includes: z
      .object({
        company: z.boolean(),
        agents: z.boolean(),
        projects: z.boolean().optional(),
        issues: z.boolean().optional(),
        skills: z.boolean().optional(),
        routines: z.boolean().optional(),
        envInputs: z.boolean().optional(),
        internalAgentConfig: z.boolean().optional(),
        budgetPolicies: z.boolean().optional(),
        costEvents: portabilityCostEventsIncludeSchema.optional(),
        financeEvents: z.boolean().optional(),
        quotaWindows: z.boolean().optional(),
        workflowTemplates: z.boolean().optional(),
      })
      .passthrough(),
    company: portabilityCompanyManifestEntrySchema.nullable(),
    agents: z
      .array(portabilityAgentManifestEntrySchema)
      .max(1000, "agents: cap 1000 per bundle"),
    projects: z
      .array(portabilityProjectManifestEntrySchema)
      .max(1000, "projects: cap 1000 per bundle")
      .optional(),
    issues: z
      .array(portabilityIssueManifestEntrySchema)
      .max(10_000, "issues: cap 10000 per bundle")
      .optional(),
    skills: z
      .array(portabilitySkillManifestEntrySchema)
      .max(1000, "skills: cap 1000 per bundle")
      .optional(),
    routines: z
      .array(portabilityRoutineManifestEntrySchema)
      .max(1000, "routines: cap 1000 per bundle")
      .optional(),
    envInputs: z
      .array(portabilityEnvInputManifestEntrySchema)
      .max(1000, "envInputs: cap 1000 per bundle")
      .optional(),
    internalAgentConfig: portabilityInternalAgentConfigManifestSchema.nullable().optional(),
    budgetPolicies: z
      .array(portabilityBudgetPolicyManifestSchema)
      .max(1000, "budgetPolicies: cap 1000 per bundle")
      .optional(),
    costEvents: z
      .array(portabilityCostEventManifestSchema)
      .max(100_000, "costEvents: cap 100000 per bundle (above 10K warn threshold)")
      .optional(),
    financeEvents: z
      .array(portabilityFinanceEventManifestSchema)
      .max(100_000, "financeEvents: cap 100000 per bundle")
      .optional(),
    quotaWindows: z
      .array(portabilityQuotaWindowManifestSchema)
      .max(10_000, "quotaWindows: cap 10000 per bundle")
      .optional(),
    workflowTemplates: z.array(portabilityWorkflowTemplateManifestSchema).optional(),
    requiredSecrets: z.array(portabilitySecretRequirementSchema).default([]),
  })
  .passthrough();

export const portabilitySourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("inline"),
    manifest: portabilityManifestSchema,
    files: z.record(z.string()),
  }),
  z.object({
    type: z.literal("url"),
    url: z.string().url(),
  }),
  z.object({
    type: z.literal("github"),
    url: z.string().url(),
  }),
]);

export const portabilityTargetSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("new_company"),
    newCompanyName: z.string().min(1).optional().nullable(),
    // Multi-tenant (cloud_auth): the owning Organization a bundle-imported
    // company is created under. Server-authorized in POST /import exactly like
    // POST / (resolveCompanyOrganizationId + assertCompanyCreateAuthorized).
    // Omit -> the actor's single org is auto-picked (cloud) or the DEFAULT
    // sentinel is used (self-hosted).
    organizationId: z.string().uuid().optional().nullable(),
  }),
  z.object({
    mode: z.literal("existing_company"),
    companyId: z.string().uuid(),
  }),
]);

export const portabilityAgentSelectionSchema = z.union([
  z.literal("all"),
  z.array(z.string().min(1)),
]);

export const portabilityCollisionStrategySchema = z.enum(["rename", "skip", "replace"]);

export const companyPortabilityExportSchema = z.object({
  include: portabilityIncludeSchema.optional(),
});

export type CompanyPortabilityExport = z.infer<typeof companyPortabilityExportSchema>;

export const companyPortabilityPreviewSchema = z.object({
  source: portabilitySourceSchema,
  include: portabilityIncludeSchema.optional(),
  target: portabilityTargetSchema,
  agents: portabilityAgentSelectionSchema.optional(),
  collisionStrategy: portabilityCollisionStrategySchema.optional(),
  overwriteCustomizedSkillKeys: z.array(z.string().min(1)).optional(),
});

export type CompanyPortabilityPreview = z.infer<typeof companyPortabilityPreviewSchema>;

export const companyPortabilityImportSchema = companyPortabilityPreviewSchema;

export type CompanyPortabilityImport = z.infer<typeof companyPortabilityImportSchema>;
