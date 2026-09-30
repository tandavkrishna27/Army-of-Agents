import type { AgentCompletionPolicy, AgentCompletionPolicySource } from "../constants.js";
import type { CompanySkillSourceType } from "./company-skill.js";

export interface CompanyPortabilityCostEventsDateRange {
  from?: string;
  to?: string;
}

export type CompanyPortabilityCostEventsInclude =
  | boolean
  | CompanyPortabilityCostEventsDateRange;

export interface CompanyPortabilityInclude {
  company: boolean;
  agents: boolean;
  projects: boolean;
  issues: boolean;
  skills: boolean;
  routines: boolean;
  envInputs: boolean;
  internalAgentConfig?: boolean;
  budgetPolicies?: boolean;
  costEvents?: CompanyPortabilityCostEventsInclude;
  financeEvents?: boolean;
  quotaWindows?: boolean;
  workflowTemplates?: boolean;
}

export interface CompanyPortabilitySecretRequirement {
  key: string;
  description: string | null;
  agentSlug: string | null;
  providerHint: string | null;
}

export interface CompanyPortabilityCompanyManifestEntry {
  path: string;
  name: string;
  description: string | null;
  brandColor: string | null;
  requireBoardApprovalForNewAgents: boolean;
  agentCompletionPolicyDefault?: AgentCompletionPolicy;
  agentCompletionReviewGuardrail?: boolean;
}

export interface CompanyPortabilityAgentManifestEntry {
  slug: string;
  name: string;
  path: string;
  role: string;
  title: string | null;
  icon: string | null;
  capabilities: string | null;
  reportsToSlug: string | null;
  parentType?: string | null;
  parentIdRef?: string | null;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  permissions: Record<string, unknown>;
  budgetMonthlyCents: number;
  metadata: Record<string, unknown> | null;
  skillKeys?: string[];
}

export interface CompanyPortabilitySkillFileInventoryEntry {
  path: string;
  kind: string;
}

export interface CompanyPortabilitySkillManifestEntry {
  key: string;
  slug: string;
  name: string;
  path: string;
  description?: string | null;
  markdown?: string;
  sourceType: CompanySkillSourceType;
  sourceLocator?: string | null;
  sourceRef?: string | null;
  trustLevel?: string | null;
  compatibility?: string | null;
  fileInventory?: CompanyPortabilitySkillFileInventoryEntry[];
  metadata?: Record<string, unknown> | null;
}

export type CompanyPortabilityProjectType = "department" | "project";

export interface CompanyPortabilityProjectManifestEntry {
  slug: string;
  name: string;
  type: CompanyPortabilityProjectType;
  description?: string | null;
  parentSlug?: string | null;
  status?: string | null;
  color?: string | null;
  targetDate?: string | null;
  leadAgentSlug?: string | null;
  functionType?: string | null;
  agentCompletionPolicyDefault?: AgentCompletionPolicy | null;
  executionWorkspacePolicy?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export interface CompanyPortabilityRoutineTriggerManifestEntry {
  kind: "schedule" | "webhook" | "api";
  label: string | null;
  enabled: boolean;
  cronExpression?: string | null;
  timezone?: string | null;
  signingMode?: "bearer" | "hmac_sha256" | null;
  replayWindowSec?: number | null;
  publicId?: string | null;
}

export interface CompanyPortabilityRoutineVariableManifestEntry {
  name: string;
  label: string | null;
  type: "text" | "textarea" | "number" | "boolean" | "select";
  defaultValue: string | number | boolean | null;
  required: boolean;
  options: string[];
}

export interface CompanyPortabilityRoutineManifestEntry {
  slug: string;
  title: string;
  description?: string | null;
  status: "active" | "paused" | "archived";
  priority: string;
  concurrencyPolicy: "coalesce_if_active" | "always_enqueue" | "skip_if_active";
  catchUpPolicy: "skip_missed" | "enqueue_missed_with_cap";
  agentCompletionPolicyOverride?: AgentCompletionPolicy | null;
  projectSlug: string;
  assigneeAgentSlug: string;
  variables: CompanyPortabilityRoutineVariableManifestEntry[];
  triggers: CompanyPortabilityRoutineTriggerManifestEntry[];
  metadata?: Record<string, unknown> | null;
}

export type CompanyPortabilityEnvInputKind = "plain" | "secret";
export type CompanyPortabilityEnvInputRequirement = "required" | "optional";
export type CompanyPortabilityEnvInputPortability = "portable" | "system_dependent";

export interface CompanyPortabilityEnvInputManifestEntry {
  key: string;
  description: string | null;
  agentSlug: string | null;
  projectSlug: string | null;
  kind: CompanyPortabilityEnvInputKind;
  requirement: CompanyPortabilityEnvInputRequirement;
  defaultValue: string | null;
  portability: CompanyPortabilityEnvInputPortability;
}

export interface CompanyPortabilityIssueManifestEntry {
  slug: string;
  title: string;
  description?: string | null;
  status?: string | null;
  priority?: string | null;
  projectSlug?: string | null;
  assigneeAgentSlug?: string | null;
  assigneeUserEmail?: string | null;
  labelNames?: string[];
  billingCode?: string | null;
  dueDate?: string | null;
  identifier?: string | null;
  recurring?: boolean | null;
  assigneeAdapterOverrides?: Record<string, unknown> | null;
  executionWorkspaceSettings?: Record<string, unknown> | null;
  acceptanceCriteria?: string[];
  agentCompletionPolicyOverride?: AgentCompletionPolicy | null;
  agentCompletionPolicy?: AgentCompletionPolicy;
  agentCompletionPolicySource?: AgentCompletionPolicySource;
  agentCompletionPolicyResolvedAt?: string;
  metadata?: Record<string, unknown> | null;
}

export type CompanyPortabilityBudgetPolicyScopeType = "company" | "agent";

export interface CompanyPortabilityBudgetPolicyManifestEntry {
  slug: string;
  scopeType: CompanyPortabilityBudgetPolicyScopeType;
  scopeAgentSlug?: string | null;
  metric: string;
  windowKind: string;
  amountCents: number;
  warnPercent: number;
  hardStopEnabled: boolean;
  notifyEnabled: boolean;
  isActive: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface CompanyPortabilityCostEventManifestEntry {
  slug: string;
  agentSlug: string | null;
  issueSlug: string | null;
  projectSlug: string | null;
  goalSlug: string | null;
  occurredAt: string;
  provider: string;
  model: string | null;
  biller: string | null;
  billingType: string | null;
  billingCode: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costCents: number;
  metadata?: Record<string, unknown> | null;
}

export type CompanyPortabilityFinanceEventDirection = "debit" | "credit";

export interface CompanyPortabilityFinanceEventManifestEntry {
  slug: string;
  agentSlug: string | null;
  issueSlug: string | null;
  projectSlug: string | null;
  goalSlug: string | null;
  costEventSlug: string | null;
  occurredAt: string;
  eventKind: string;
  direction: CompanyPortabilityFinanceEventDirection;
  biller: string;
  provider: string | null;
  executionAdapterType: string | null;
  pricingTier: string | null;
  region: string | null;
  model: string | null;
  quantity: number | null;
  unit: string | null;
  amountCents: number;
  currency: string;
  estimated: boolean;
  externalInvoiceId: string | null;
  billingCode: string | null;
  description: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface CompanyPortabilityQuotaWindowManifestEntry {
  slug: string;
  provider: string;
  model: string | null;
  windowKind: string;
  label: string | null;
  limitValue: number | null;
  usedValue: number | null;
  usedPercent: number | null;
  valueLabel: string | null;
  resetAt: string | null;
  lastUpdatedAt: string;
  metadata?: Record<string, unknown> | null;
}

export interface CompanyPortabilityWorkflowTemplateManifestEntry {
  slug: string;
  name: string;
  description: string | null;
  workspaceMode: string;
  agentCompletionPolicyOverride?: AgentCompletionPolicy | null;
  steps: unknown[];
  dependencies: unknown[];
  metadata?: Record<string, unknown> | null;
}

export interface CompanyPortabilityInternalAgentConfigManifestEntry {
  executionMode: string;
  provider?: string | null;
  model?: string | null;
  cliTool?: string | null;
  autonomyLevel: number;
  /**
   * D18 dial-split. Optional so PRE-SPLIT bundles (which carry only the shared
   * `autonomyLevel`) still import: the importer falls back to `autonomyLevel`,
   * reproducing exactly the crew behaviour the bundle was exported with.
   */
  crewAutonomyLevel?: number;
  enabledCapabilities?: string[];
  notificationPreference: string;
  contextTokenBudget: number;
  budgetMonthlyCents?: number | null;
  proactiveIntervalMinutes: number;
  metadata?: Record<string, unknown> | null;
}

export interface CompanyPortabilityManifest {
  schemaVersion: number;
  generatedAt: string;
  source: {
    companyId: string;
    companyName: string;
  } | null;
  includes: CompanyPortabilityInclude;
  company: CompanyPortabilityCompanyManifestEntry | null;
  agents: CompanyPortabilityAgentManifestEntry[];
  projects?: CompanyPortabilityProjectManifestEntry[];
  issues?: CompanyPortabilityIssueManifestEntry[];
  skills?: CompanyPortabilitySkillManifestEntry[];
  routines?: CompanyPortabilityRoutineManifestEntry[];
  envInputs?: CompanyPortabilityEnvInputManifestEntry[];
  internalAgentConfig?: CompanyPortabilityInternalAgentConfigManifestEntry | null;
  budgetPolicies?: CompanyPortabilityBudgetPolicyManifestEntry[];
  costEvents?: CompanyPortabilityCostEventManifestEntry[];
  financeEvents?: CompanyPortabilityFinanceEventManifestEntry[];
  quotaWindows?: CompanyPortabilityQuotaWindowManifestEntry[];
  workflowTemplates?: CompanyPortabilityWorkflowTemplateManifestEntry[];
  requiredSecrets: CompanyPortabilitySecretRequirement[];
}

export interface CompanyPortabilityExportResult {
  manifest: CompanyPortabilityManifest;
  files: Record<string, string>;
  warnings: string[];
}

export interface CompanyPortabilityExportPreviewCounts {
  agents: number;
  projects: number;
  issues: number;
  skills: number;
  routines: number;
  envInputs: number;
  internalAgentConfig?: 0 | 1;
  budgetPolicies?: number;
  costEvents?: number;
  financeEvents?: number;
  quotaWindows?: number;
  workflowTemplates?: number;
}

export interface CompanyPortabilityExportPreviewResult {
  counts: CompanyPortabilityExportPreviewCounts;
  files: string[];
  estimatedBytes: number;
  warnings: string[];
}

export type ImportWarningKind =
  | "unknown_section"
  | "unsupported_version"
  | "deprecated_field"
  | "missing_file"
  | "invalid_frontmatter"
  | "empty_selection"
  | "link_failed"
  | "skipped_update"
  | "large_volume";

export interface ImportWarning {
  kind: ImportWarningKind;
  section?: string;
  message: string;
  count?: number;
}

export type CompanyPortabilitySource =
  | {
      type: "inline";
      manifest: CompanyPortabilityManifest;
      files: Record<string, string>;
    }
  | {
      type: "url";
      url: string;
    }
  | {
      type: "github";
      url: string;
    };

export type CompanyPortabilityImportTarget =
  | {
      mode: "new_company";
      newCompanyName?: string | null;
      organizationId?: string | null;
    }
  | {
      mode: "existing_company";
      companyId: string;
    };

export type CompanyPortabilityAgentSelection = "all" | string[];

export type CompanyPortabilityCollisionStrategy = "rename" | "skip" | "replace";

export interface CompanyPortabilityPreviewRequest {
  source: CompanyPortabilitySource;
  include?: Partial<CompanyPortabilityInclude>;
  target: CompanyPortabilityImportTarget;
  agents?: CompanyPortabilityAgentSelection;
  collisionStrategy?: CompanyPortabilityCollisionStrategy;
  /**
   * Exact manifest skill keys the founder has explicitly allowed this import
   * to overwrite even when the target row carries local edits.
   */
  overwriteCustomizedSkillKeys?: string[];
}

export interface CompanyPortabilityPreviewAgentPlan {
  slug: string;
  action: "create" | "update" | "skip";
  plannedName: string;
  existingAgentId: string | null;
  reason: string | null;
}

export interface CompanyPortabilityPreviewProjectPlan {
  slug: string;
  action: "create" | "update" | "skip";
  plannedName: string;
  existingProjectId: string | null;
  reason: string | null;
}

export interface CompanyPortabilityPreviewIssuePlan {
  slug: string;
  action: "create" | "skip";
  plannedTitle: string;
  reason: string | null;
}

export interface CompanyPortabilityPreviewRoutinePlan {
  slug: string;
  action: "create" | "update" | "skip";
  plannedTitle: string;
  existingRoutineId: string | null;
  reason: string | null;
}

export interface CompanyPortabilityPreviewSkillPlan {
  key: string;
  slug: string;
  action: "create" | "update" | "skip";
  plannedName: string;
  plannedKey: string;
  existingSkillId: string | null;
  existingCustomized: boolean;
  overwriteCustomized: boolean;
  reason: string | null;
}

export interface CompanyPortabilityPreviewResult {
  include: CompanyPortabilityInclude;
  targetCompanyId: string | null;
  targetCompanyName: string | null;
  collisionStrategy: CompanyPortabilityCollisionStrategy;
  selectedAgentSlugs: string[];
  plan: {
    companyAction: "none" | "create" | "update";
    agentPlans: CompanyPortabilityPreviewAgentPlan[];
    projectPlans: CompanyPortabilityPreviewProjectPlan[];
    issuePlans: CompanyPortabilityPreviewIssuePlan[];
    skillPlans: CompanyPortabilityPreviewSkillPlan[];
    routinePlans: CompanyPortabilityPreviewRoutinePlan[];
  };
  requiredSecrets: CompanyPortabilitySecretRequirement[];
  warnings: ImportWarning[];
  errors: string[];
}

export interface CompanyPortabilityImportRequest extends CompanyPortabilityPreviewRequest {}

export interface CompanyPortabilityImportResult {
  company: {
    id: string;
    name: string;
    action: "created" | "updated" | "unchanged";
  };
  agents: {
    slug: string;
    id: string | null;
    action: "created" | "updated" | "skipped";
    name: string;
    reason: string | null;
  }[];
  projects: {
    slug: string;
    id: string | null;
    action: "created" | "updated" | "skipped";
    name: string;
    type: CompanyPortabilityProjectType;
    reason: string | null;
  }[];
  issues: {
    slug: string;
    id: string | null;
    action: "created" | "skipped";
    title: string;
    reason: string | null;
  }[];
  skills: {
    key: string;
    slug: string;
    id: string | null;
    action: "created" | "updated" | "skipped";
    name: string;
    reason: string | null;
  }[];
  routines: {
    slug: string;
    id: string | null;
    action: "created" | "updated" | "skipped";
    title: string;
    reason: string | null;
  }[];
  requiredSecrets: CompanyPortabilitySecretRequirement[];
  warnings: ImportWarning[];
}

export interface CompanyPortabilityExportRequest {
  include?: Partial<CompanyPortabilityInclude>;
}
