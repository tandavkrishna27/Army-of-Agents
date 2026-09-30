import { promises as fs } from "node:fs";
import path from "node:path";
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  budgetPolicies,
  companies as companiesTable,
  costEvents,
  financeEvents,
  internalAgentConfig,
  projects as projectsTable,
  providerQuotaWindows,
  workflowTemplates,
} from "@armyofagents/db";
import type {
  CompanyPortabilityAgentManifestEntry,
  CompanyPortabilityBudgetPolicyManifestEntry,
  CompanyPortabilityCollisionStrategy,
  CompanyPortabilityCostEventManifestEntry,
  CompanyPortabilityCostEventsInclude,
  CompanyPortabilityEnvInputManifestEntry,
  CompanyPortabilityExport,
  CompanyPortabilityExportPreviewResult,
  CompanyPortabilityExportResult,
  CompanyPortabilityFinanceEventManifestEntry,
  CompanyPortabilityImport,
  CompanyPortabilityImportResult,
  CompanyPortabilityInclude,
  CompanyPortabilityInternalAgentConfigManifestEntry,
  CompanyPortabilityIssueManifestEntry,
  CompanyPortabilityManifest,
  CompanyPortabilityPreview,
  CompanyPortabilityPreviewAgentPlan,
  CompanyPortabilityPreviewIssuePlan,
  CompanyPortabilityPreviewProjectPlan,
  CompanyPortabilityPreviewResult,
  CompanyPortabilityPreviewRoutinePlan,
  CompanyPortabilityPreviewSkillPlan,
  CompanyPortabilityProjectManifestEntry,
  CompanyPortabilityQuotaWindowManifestEntry,
  CompanyPortabilityRoutineManifestEntry,
  CompanyPortabilitySkillManifestEntry,
  CompanyPortabilityWorkflowTemplateManifestEntry,
  ImportWarning,
} from "@armyofagents/shared";
import {
  deriveProjectUrlKey,
  normalizeAgentUrlKey,
  normalizeProjectUrlKey,
  portabilityManifestSchema,
} from "@armyofagents/shared";
import { notFound, unprocessable } from "../errors.js";
import { accessService } from "./access.js";
import { agentService } from "./agents.js";
import { companyService } from "./companies.js";
import { companySkillService, normalizeSkillKey } from "./company-skills.js";
import { generateReadme } from "./company-export-readme.js";
import { issueService } from "./issues.js";
import { executePinnedRequest, validateAndResolveFetchUrl } from "./outbound-url-guard.js";
import { projectService } from "./projects.js";
import { routineService } from "./routines.js";
import { lockBudgetAuthority } from "./budget-capacity.js";

const DEFAULT_INCLUDE: CompanyPortabilityInclude = {
  company: true,
  agents: true,
  projects: false,
  issues: false,
  skills: false,
  routines: false,
  envInputs: false,
  internalAgentConfig: true,
  budgetPolicies: false,
  costEvents: false,
  financeEvents: false,
  quotaWindows: false,
  workflowTemplates: false,
};

const COST_EVENT_VOLUME_THRESHOLD = 10000;
const COST_EVENT_INSERT_BATCH_SIZE = 1000;
const FINANCE_EVENT_INSERT_BATCH_SIZE = 1000;

const ISSUE_STATUSES = new Set([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
]);

const ISSUE_PRIORITIES = new Set(["critical", "high", "medium", "low"]);

const DEFAULT_COLLISION_STRATEGY: CompanyPortabilityCollisionStrategy = "rename";

const MANIFEST_WRAPPER_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "generatedAt",
  "source",
  "includes",
  "requiredSecrets",
]);

const KNOWN_SECTIONS: ReadonlySet<string> = new Set(["company", "agents", "projects", "issues", "skills", "routines", "envInputs", "internalAgentConfig", "budgetPolicies", "costEvents", "financeEvents", "quotaWindows", "workflowTemplates"]);

const MAX_SUPPORTED_SCHEMA_VERSION = 2;

const SENSITIVE_ENV_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:[-_]?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring|(?:^|[_-])token(?:$|[_-]))/i;

type ResolvedSource = {
  manifest: CompanyPortabilityManifest;
  files: Record<string, string>;
  warnings: ImportWarning[];
};

function collectManifestWarnings(manifest: CompanyPortabilityManifest): ImportWarning[] {
  const warnings: ImportWarning[] = [];
  if (manifest.schemaVersion > MAX_SUPPORTED_SCHEMA_VERSION) {
    warnings.push({
      kind: "unsupported_version",
      message: `Bundle schemaVersion ${manifest.schemaVersion} is newer than supported (max ${MAX_SUPPORTED_SCHEMA_VERSION}). Unknown fields will be ignored.`,
    });
  }
  const manifestRecord = manifest as unknown as Record<string, unknown>;
  for (const key of Object.keys(manifestRecord)) {
    if (MANIFEST_WRAPPER_KEYS.has(key)) continue;
    if (KNOWN_SECTIONS.has(key)) continue;
    const value = manifestRecord[key];
    const count = Array.isArray(value) ? value.length : undefined;
    warnings.push({
      kind: "unknown_section",
      section: key,
      count,
      message:
        count !== undefined
          ? `Bundle section "${key}" (${count} item${count === 1 ? "" : "s"}) is not supported by this version and will be ignored.`
          : `Bundle section "${key}" is not supported by this version and will be ignored.`,
    });
  }
  return warnings;
}

type MarkdownDoc = {
  frontmatter: Record<string, unknown>;
  body: string;
};

type ImportPlanInternal = {
  preview: CompanyPortabilityPreviewResult;
  source: ResolvedSource;
  include: CompanyPortabilityInclude;
  collisionStrategy: CompanyPortabilityCollisionStrategy;
  selectedAgents: CompanyPortabilityAgentManifestEntry[];
  selectedProjects: CompanyPortabilityProjectManifestEntry[];
  selectedIssues: CompanyPortabilityIssueManifestEntry[];
  selectedSkills: CompanyPortabilitySkillManifestEntry[];
  selectedRoutines: CompanyPortabilityRoutineManifestEntry[];
  mutableWorkflowTemplateSlugs: Set<string>;
  replaceWorkflowTemplateIdsBySlug: Map<string, Set<string>>;
  workflowTemplatePolicyChangeSlugs: Set<string>;
};

type ImportAuthorizationContext = {
  changesCompletionPolicy: boolean;
  requiresTaskAssignmentPermission: boolean;
  importsWorkflowTemplates: boolean;
  // D2/H2: an existing-company agent import is a company-structure mutation and
  // must require founder/team_lead. Surfaced so the route can gate it; the
  // service no longer re-owns the caller via ensureRealOperator.
  importsAgents: boolean;
  // D2 (privilege-escalation hardening): the two founder-PLANE sections. Surfaced
  // so POST /import can require FOUNDER (not merely founder/team_lead) for them.
  // internal_agent_config carries crewAutonomyLevel / budgetMonthlyCents /
  // enabledCapabilities; budget_policies carries hardStopEnabled. Both are
  // company-governance controls a team_lead has no business overwriting via a
  // bundle. These fire exactly when the corresponding writes fire (same
  // normalized `plan.include` object + manifest section presence).
  importsInternalAgentConfig: boolean;
  importsBudgetPolicies: boolean;
};

function getImportAuthorizationContext(plan: ImportPlanInternal): ImportAuthorizationContext {
  const manifest = plan.source.manifest;
  const mutableProjectSlugs = new Set(
    plan.preview.plan.projectPlans
      .filter((project) => project.action !== "skip")
      .map((project) => project.slug),
  );
  const mutableRoutineSlugs = new Set(
    plan.preview.plan.routinePlans
      .filter((routine) => routine.action !== "skip")
      .map((routine) => routine.slug),
  );
  const mutableIssues = plan.selectedIssues.filter((issue) => !issue.recurring);
  const mutableRoutines = plan.selectedRoutines.filter((routine) =>
    mutableRoutineSlugs.has(routine.slug),
  );
  const companyPolicyChanges =
    plan.include.company &&
    !!manifest.company &&
    (manifest.company.agentCompletionPolicyDefault !== undefined ||
      manifest.company.agentCompletionReviewGuardrail !== undefined);
  const projectPolicyChanges = plan.selectedProjects.some(
    (project) =>
      mutableProjectSlugs.has(project.slug) &&
      project.agentCompletionPolicyDefault !== undefined,
  );
  const issuePolicyChanges = mutableIssues.some(
    (issue) =>
      issue.agentCompletionPolicyOverride !== undefined ||
      issue.agentCompletionPolicy !== undefined,
  );
  const routinePolicyChanges = mutableRoutines.some(
    (routine) => routine.agentCompletionPolicyOverride !== undefined,
  );
  const workflowTemplatePolicyChanges =
    plan.include.workflowTemplates === true &&
    plan.workflowTemplatePolicyChangeSlugs.size > 0;

  const changesCompletionPolicy =
    companyPolicyChanges ||
    projectPolicyChanges ||
    issuePolicyChanges ||
    routinePolicyChanges ||
    workflowTemplatePolicyChanges;
  const importsAssignedIssues = mutableIssues.some(
    (issue) => !!issue.assigneeAgentSlug,
  );

  return {
    changesCompletionPolicy,
    requiresTaskAssignmentPermission:
      changesCompletionPolicy || mutableRoutines.length > 0 || importsAssignedIssues,
    importsWorkflowTemplates:
      plan.include.workflowTemplates === true && (manifest.workflowTemplates?.length ?? 0) > 0,
    importsAgents: plan.include.agents === true && plan.selectedAgents.length > 0,
    importsInternalAgentConfig:
      plan.include.internalAgentConfig === true && !!manifest.internalAgentConfig,
    importsBudgetPolicies:
      plan.include.budgetPolicies === true && (manifest.budgetPolicies?.length ?? 0) > 0,
  };
}

function sortProjectsTopologically(
  projects: CompanyPortabilityProjectManifestEntry[],
): CompanyPortabilityProjectManifestEntry[] {
  // Departments always first (no parent), then projects. Within each group, preserve input order.
  // Within projects, entries whose parentSlug is already emitted come before those whose parent
  // hasn't been seen — which keeps the parent-first invariant the plan calls for.
  const departments: CompanyPortabilityProjectManifestEntry[] = [];
  const others: CompanyPortabilityProjectManifestEntry[] = [];
  for (const project of projects) {
    if (project.type === "department") departments.push(project);
    else others.push(project);
  }
  return [...departments, ...others];
}

type AgentLike = {
  id: string;
  name: string;
  adapterConfig: Record<string, unknown>;
};

const RUNTIME_DEFAULT_RULES: Array<{ path: string[]; value: unknown }> = [
  { path: ["heartbeat", "cooldownSec"], value: 10 },
  { path: ["heartbeat", "intervalSec"], value: 3600 },
  { path: ["heartbeat", "wakeOnOnDemand"], value: true },
  { path: ["heartbeat", "wakeOnAssignment"], value: true },
  { path: ["heartbeat", "wakeOnAutomation"], value: true },
  { path: ["heartbeat", "wakeOnDemand"], value: true },
  { path: ["heartbeat", "maxConcurrentRuns"], value: 3 },
];

const ADAPTER_DEFAULT_RULES_BY_TYPE: Record<string, Array<{ path: string[]; value: unknown }>> = {
  codex_local: [
    { path: ["timeoutSec"], value: 0 },
    { path: ["graceSec"], value: 15 },
  ],
  opencode_local: [
    { path: ["timeoutSec"], value: 0 },
    { path: ["graceSec"], value: 15 },
  ],
  cursor: [
    { path: ["timeoutSec"], value: 0 },
    { path: ["graceSec"], value: 15 },
  ],
  claude_local: [
    { path: ["timeoutSec"], value: 0 },
    { path: ["graceSec"], value: 15 },
    { path: ["maxTurnsPerRun"], value: 80 },
  ],
  openclaw: [
    { path: ["method"], value: "POST" },
    { path: ["timeoutSec"], value: 30 },
  ],
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toSafeSlug(input: string, fallback: string) {
  return normalizeAgentUrlKey(input) ?? fallback;
}

function uniqueSlug(base: string, used: Set<string>) {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let idx = 2;
  while (true) {
    const candidate = `${base}-${idx}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    idx += 1;
  }
}

function uniqueSkillKeyByNormalizedKey(base: string, usedNormalizedKeys: Set<string>) {
  const normalizedBase = normalizeSkillKey(base) ?? base;
  if (!usedNormalizedKeys.has(normalizedBase)) {
    usedNormalizedKeys.add(normalizedBase);
    return base;
  }
  let idx = 2;
  while (true) {
    const candidate = `${normalizedBase}-${idx}`;
    if (!usedNormalizedKeys.has(candidate)) {
      usedNormalizedKeys.add(candidate);
      return candidate;
    }
    idx += 1;
  }
}

function uniqueNameBySlug(baseName: string, existingSlugs: Set<string>) {
  const baseSlug = normalizeAgentUrlKey(baseName) ?? "agent";
  if (!existingSlugs.has(baseSlug)) return baseName;
  let idx = 2;
  while (true) {
    const candidateName = `${baseName} ${idx}`;
    const candidateSlug = normalizeAgentUrlKey(candidateName) ?? `agent-${idx}`;
    if (!existingSlugs.has(candidateSlug)) return candidateName;
    idx += 1;
  }
}

function uniqueProjectNameBySlug(baseName: string, existingSlugs: Set<string>) {
  const baseSlug = normalizeProjectUrlKey(baseName) ?? "project";
  if (!existingSlugs.has(baseSlug)) return baseName;
  let idx = 2;
  while (true) {
    const candidateName = `${baseName} ${idx}`;
    const candidateSlug = normalizeProjectUrlKey(candidateName) ?? `project-${idx}`;
    if (!existingSlugs.has(candidateSlug)) return candidateName;
    idx += 1;
  }
}

function normalizeInclude(input?: Partial<CompanyPortabilityInclude>): CompanyPortabilityInclude {
  return {
    company: input?.company ?? DEFAULT_INCLUDE.company,
    agents: input?.agents ?? DEFAULT_INCLUDE.agents,
    projects: input?.projects ?? DEFAULT_INCLUDE.projects,
    issues: input?.issues ?? DEFAULT_INCLUDE.issues,
    skills: input?.skills ?? DEFAULT_INCLUDE.skills,
    routines: input?.routines ?? DEFAULT_INCLUDE.routines,
    envInputs: input?.envInputs ?? DEFAULT_INCLUDE.envInputs,
    internalAgentConfig: input?.internalAgentConfig ?? DEFAULT_INCLUDE.internalAgentConfig,
    budgetPolicies: input?.budgetPolicies ?? DEFAULT_INCLUDE.budgetPolicies,
    costEvents: input?.costEvents ?? DEFAULT_INCLUDE.costEvents,
    financeEvents: input?.financeEvents ?? DEFAULT_INCLUDE.financeEvents,
    quotaWindows: input?.quotaWindows ?? DEFAULT_INCLUDE.quotaWindows,
    workflowTemplates: input?.workflowTemplates ?? DEFAULT_INCLUDE.workflowTemplates,
  };
}

function isCostEventsEnabled(value: CompanyPortabilityCostEventsInclude | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  return true;
}

function costEventsDateRange(
  value: CompanyPortabilityCostEventsInclude | undefined,
): { from: Date | null; to: Date | null } {
  if (!value || typeof value === "boolean") return { from: null, to: null };
  const parseMaybe = (raw: string | undefined): Date | null => {
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  return { from: parseMaybe(value.from), to: parseMaybe(value.to) };
}

function serializeInternalAgentConfigRow(row: Record<string, unknown>): CompanyPortabilityInternalAgentConfigManifestEntry {
  const capabilitiesRaw = row.enabledCapabilities;
  const enabledCapabilities = Array.isArray(capabilitiesRaw)
    ? capabilitiesRaw.filter((item): item is string => typeof item === "string")
    : undefined;
  return {
    executionMode: typeof row.executionMode === "string" ? row.executionMode : "api",
    provider: (row.provider as string | null | undefined) ?? null,
    model: (row.model as string | null | undefined) ?? null,
    cliTool: (row.cliTool as string | null | undefined) ?? null,
    autonomyLevel: typeof row.autonomyLevel === "number" ? row.autonomyLevel : 0,
    // D18 dial-split: exported alongside the Commander dial, never derived from it.
    crewAutonomyLevel:
      typeof row.crewAutonomyLevel === "number" ? row.crewAutonomyLevel : 0,
    ...(enabledCapabilities ? { enabledCapabilities } : {}),
    notificationPreference:
      typeof row.notificationPreference === "string" ? row.notificationPreference : "realtime",
    contextTokenBudget: typeof row.contextTokenBudget === "number" ? row.contextTokenBudget : 8000,
    budgetMonthlyCents:
      typeof row.budgetMonthlyCents === "number" ? row.budgetMonthlyCents : null,
    proactiveIntervalMinutes:
      typeof row.proactiveIntervalMinutes === "number" ? row.proactiveIntervalMinutes : 240,
    metadata: (row.metadata as Record<string, unknown> | null | undefined) ?? null,
  };
}

function synthesizeWorkflowTemplateSlug(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return normalized.length > 0 ? normalized : "workflow-template";
}

function getWorkflowTemplateManifestSlug(
  template: CompanyPortabilityWorkflowTemplateManifestEntry,
): string {
  return typeof template.slug === "string" && template.slug.length > 0
    ? template.slug
    : synthesizeWorkflowTemplateSlug(template.name);
}

function serializeWorkflowTemplateRow(
  row: Record<string, unknown>,
): CompanyPortabilityWorkflowTemplateManifestEntry {
  const name = typeof row.name === "string" ? row.name : "Untitled";
  return {
    slug: synthesizeWorkflowTemplateSlug(name),
    name,
    description: typeof row.description === "string" ? row.description : null,
    workspaceMode:
      typeof row.workspaceMode === "string" ? row.workspaceMode : "department_default",
    agentCompletionPolicyOverride:
      row.agentCompletionPolicyOverride === "review_required" ||
      row.agentCompletionPolicyOverride === "agent_can_complete"
        ? row.agentCompletionPolicyOverride
        : null,
    steps: Array.isArray(row.steps) ? (row.steps as unknown[]) : [],
    dependencies: Array.isArray(row.dependencies) ? (row.dependencies as unknown[]) : [],
  };
}

function synthesizeBudgetPolicySlug(params: {
  scopeType: "company" | "agent";
  scopeAgentSlug: string | null;
  metric: string;
  windowKind: string;
}): string {
  const parts = params.scopeType === "agent"
    ? ["agent", params.scopeAgentSlug ?? "unknown-agent", params.metric, params.windowKind]
    : ["company", params.metric, params.windowKind];
  return parts.join("-");
}

function serializeBudgetPolicyRow(
  row: Record<string, unknown>,
  scopeAgentSlug: string | null,
): CompanyPortabilityBudgetPolicyManifestEntry {
  const scopeType = row.scopeType === "agent" ? "agent" : "company";
  const metric = typeof row.metric === "string" ? row.metric : "cost_cents";
  const windowKind = typeof row.windowKind === "string" ? row.windowKind : "calendar_month_utc";
  return {
    slug: synthesizeBudgetPolicySlug({ scopeType, scopeAgentSlug, metric, windowKind }),
    scopeType,
    scopeAgentSlug: scopeType === "agent" ? scopeAgentSlug : null,
    metric,
    windowKind,
    amountCents: typeof row.amountCents === "number" ? row.amountCents : 0,
    warnPercent: typeof row.warnPercent === "number" ? row.warnPercent : 80,
    hardStopEnabled: row.hardStopEnabled !== false,
    notifyEnabled: row.notifyEnabled !== false,
    isActive: row.isActive !== false,
    metadata: null,
  };
}

function serializeCostEventRow(
  row: Record<string, unknown>,
  slugs: {
    agentSlug: string | null;
    issueSlug: string | null;
    projectSlug: string | null;
  },
): CompanyPortabilityCostEventManifestEntry {
  const occurredAt = row.occurredAt instanceof Date
    ? row.occurredAt.toISOString()
    : typeof row.occurredAt === "string"
      ? row.occurredAt
      : new Date().toISOString();
  const id = typeof row.id === "string" ? row.id : null;
  const slug = id ?? `${occurredAt}-${slugs.agentSlug ?? "orphan"}`;
  return {
    slug,
    agentSlug: slugs.agentSlug,
    issueSlug: slugs.issueSlug,
    projectSlug: slugs.projectSlug,
    goalSlug: null,
    occurredAt,
    provider: typeof row.provider === "string" ? row.provider : "unknown",
    model: typeof row.model === "string" ? row.model : null,
    biller: typeof row.biller === "string" ? row.biller : null,
    billingType: typeof row.billingType === "string" ? row.billingType : null,
    billingCode: typeof row.billingCode === "string" ? row.billingCode : null,
    inputTokens: typeof row.inputTokens === "number" ? row.inputTokens : 0,
    outputTokens: typeof row.outputTokens === "number" ? row.outputTokens : 0,
    cachedInputTokens: typeof row.cachedInputTokens === "number" ? row.cachedInputTokens : 0,
    costCents: typeof row.costCents === "number" ? row.costCents : 0,
    metadata: null,
  };
}

function serializeFinanceEventRow(
  row: Record<string, unknown>,
  slugs: {
    agentSlug: string | null;
    issueSlug: string | null;
    projectSlug: string | null;
    costEventSlug: string | null;
  },
): CompanyPortabilityFinanceEventManifestEntry {
  const occurredAt = row.occurredAt instanceof Date
    ? row.occurredAt.toISOString()
    : typeof row.occurredAt === "string"
      ? row.occurredAt
      : new Date().toISOString();
  const id = typeof row.id === "string" ? row.id : null;
  const slug = id ?? `${occurredAt}-${slugs.agentSlug ?? "orphan"}`;
  const direction = row.direction === "credit" ? "credit" : "debit";
  const metadata = row.metadataJson as Record<string, unknown> | null | undefined;
  return {
    slug,
    agentSlug: slugs.agentSlug,
    issueSlug: slugs.issueSlug,
    projectSlug: slugs.projectSlug,
    goalSlug: null,
    costEventSlug: slugs.costEventSlug,
    occurredAt,
    eventKind: typeof row.eventKind === "string" ? row.eventKind : "unknown",
    direction,
    biller: typeof row.biller === "string" ? row.biller : "unknown",
    provider: typeof row.provider === "string" ? row.provider : null,
    executionAdapterType: typeof row.executionAdapterType === "string" ? row.executionAdapterType : null,
    pricingTier: typeof row.pricingTier === "string" ? row.pricingTier : null,
    region: typeof row.region === "string" ? row.region : null,
    model: typeof row.model === "string" ? row.model : null,
    quantity: typeof row.quantity === "number" ? row.quantity : null,
    unit: typeof row.unit === "string" ? row.unit : null,
    amountCents: typeof row.amountCents === "number" ? row.amountCents : 0,
    currency: typeof row.currency === "string" ? row.currency : "USD",
    estimated: row.estimated === true,
    externalInvoiceId: typeof row.externalInvoiceId === "string" ? row.externalInvoiceId : null,
    billingCode: typeof row.billingCode === "string" ? row.billingCode : null,
    description: typeof row.description === "string" ? row.description : null,
    metadata: metadata ?? null,
  };
}

function serializeQuotaWindowRow(row: Record<string, unknown>): CompanyPortabilityQuotaWindowManifestEntry {
  const provider = typeof row.provider === "string" ? row.provider : "unknown";
  const model = typeof row.model === "string" ? row.model : null;
  const windowKind = typeof row.windowKind === "string" ? row.windowKind : "unknown";
  const resetAt = row.resetAt instanceof Date
    ? row.resetAt.toISOString()
    : typeof row.resetAt === "string"
      ? row.resetAt
      : null;
  const lastUpdatedAt = row.lastUpdatedAt instanceof Date
    ? row.lastUpdatedAt.toISOString()
    : typeof row.lastUpdatedAt === "string"
      ? row.lastUpdatedAt
      : new Date().toISOString();
  const id = typeof row.id === "string" ? row.id : null;
  const slug = id ?? `${provider}-${model ?? "any"}-${windowKind}`;
  return {
    slug,
    provider,
    model,
    windowKind,
    label: typeof row.label === "string" ? row.label : null,
    limitValue: typeof row.limitValue === "number" ? row.limitValue : null,
    usedValue: typeof row.usedValue === "number" ? row.usedValue : null,
    usedPercent: typeof row.usedPercent === "number" ? row.usedPercent : null,
    valueLabel: typeof row.valueLabel === "string" ? row.valueLabel : null,
    resetAt,
    lastUpdatedAt,
    metadata: null,
  };
}

function ensureMarkdownPath(pathValue: string) {
  const normalized = pathValue.replace(/\\/g, "/");
  if (!normalized.endsWith(".md")) {
    throw unprocessable(`Manifest file path must end in .md: ${pathValue}`);
  }
  return normalized;
}

function normalizePortableEnv(
  agentSlug: string,
  envValue: unknown,
  requiredSecrets: CompanyPortabilityManifest["requiredSecrets"],
) {
  if (typeof envValue !== "object" || envValue === null || Array.isArray(envValue)) return {};
  const env = envValue as Record<string, unknown>;
  const next: Record<string, unknown> = {};

  for (const [key, binding] of Object.entries(env)) {
    if (SENSITIVE_ENV_KEY_RE.test(key)) {
      requiredSecrets.push({
        key,
        description: `Set ${key} for agent ${agentSlug}`,
        agentSlug,
        providerHint: null,
      });
      continue;
    }
    next[key] = binding;
  }
  return next;
}

function isAbsoluteEnvPath(value: string) {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function extractPortableEnvInputs(
  agentSlug: string,
  envValue: unknown,
  warnings: string[],
): CompanyPortabilityEnvInputManifestEntry[] {
  if (typeof envValue !== "object" || envValue === null || Array.isArray(envValue)) return [];
  const env = envValue as Record<string, unknown>;
  const inputs: CompanyPortabilityEnvInputManifestEntry[] = [];

  for (const [key, binding] of Object.entries(env)) {
    if (key.toUpperCase() === "PATH") {
      warnings.push(`Agent ${agentSlug} PATH override was omitted from envInputs export because it is system-dependent.`);
      continue;
    }

    const sensitive = SENSITIVE_ENV_KEY_RE.test(key);

    if (isPlainRecord(binding) && binding.type === "secret_ref") {
      inputs.push({
        key,
        description: `Provide ${key} for agent ${agentSlug}`,
        agentSlug,
        projectSlug: null,
        kind: "secret",
        requirement: "optional",
        defaultValue: "",
        portability: "portable",
      });
      continue;
    }

    let rawValue: string | null = null;
    if (typeof binding === "string") {
      rawValue = binding;
    } else if (isPlainRecord(binding) && binding.type === "plain" && typeof binding.value === "string") {
      rawValue = binding.value;
    }

    const portability: "portable" | "system_dependent" =
      rawValue !== null && !sensitive && isAbsoluteEnvPath(rawValue) ? "system_dependent" : "portable";
    if (portability === "system_dependent") {
      warnings.push(`Agent ${agentSlug} env ${key} default was exported as system-dependent and may need manual adjustment after import.`);
    }

    inputs.push({
      key,
      description: sensitive
        ? `Provide ${key} for agent ${agentSlug}`
        : `Optional default for ${key} on agent ${agentSlug}`,
      agentSlug,
      projectSlug: null,
      kind: sensitive ? "secret" : "plain",
      requirement: "optional",
      defaultValue: sensitive ? "" : (rawValue ?? ""),
      portability,
    });
  }

  return inputs;
}

function dedupeEnvInputs(values: CompanyPortabilityEnvInputManifestEntry[]): CompanyPortabilityEnvInputManifestEntry[] {
  const seen = new Set<string>();
  const out: CompanyPortabilityEnvInputManifestEntry[] = [];
  for (const value of values) {
    const dedupeKey = `${value.agentSlug ?? ""}:${value.projectSlug ?? ""}:${value.key.toUpperCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(value);
  }
  return out;
}

function normalizePortableConfig(
  value: unknown,
  agentSlug: string,
  requiredSecrets: CompanyPortabilityManifest["requiredSecrets"],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(input)) {
    if (key === "cwd" || key === "instructionsFilePath") continue;
    if (key === "env") {
      next[key] = normalizePortableEnv(agentSlug, entry, requiredSecrets);
      continue;
    }
    next[key] = entry;
  }

  return next;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPathDefault(pathSegments: string[], value: unknown, rules: Array<{ path: string[]; value: unknown }>) {
  return rules.some((rule) => jsonEqual(rule.path, pathSegments) && jsonEqual(rule.value, value));
}

function pruneDefaultLikeValue(
  value: unknown,
  opts: {
    dropFalseBooleans: boolean;
    path?: string[];
    defaultRules?: Array<{ path: string[]; value: unknown }>;
  },
): unknown {
  const pathSegments = opts.path ?? [];
  if (opts.defaultRules && isPathDefault(pathSegments, value, opts.defaultRules)) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => pruneDefaultLikeValue(entry, { ...opts, path: pathSegments }));
  }
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const next = pruneDefaultLikeValue(entry, {
        ...opts,
        path: [...pathSegments, key],
      });
      if (next === undefined) continue;
      out[key] = next;
    }
    return out;
  }
  if (value === undefined) return undefined;
  if (opts.dropFalseBooleans && value === false) return undefined;
  return value;
}

function renderYamlScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}

function isEmptyObject(value: unknown): boolean {
  return isPlainRecord(value) && Object.keys(value).length === 0;
}

function renderYamlBlock(value: unknown, indentLevel: number): string[] {
  const indent = "  ".repeat(indentLevel);

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}[]`];
    const lines: string[] = [];
    for (const entry of value) {
      const scalar =
        entry === null ||
        typeof entry === "string" ||
        typeof entry === "boolean" ||
        typeof entry === "number" ||
        Array.isArray(entry) && entry.length === 0 ||
        isEmptyObject(entry);
      if (scalar) {
        lines.push(`${indent}- ${renderYamlScalar(entry)}`);
        continue;
      }
      lines.push(`${indent}-`);
      lines.push(...renderYamlBlock(entry, indentLevel + 1));
    }
    return lines;
  }

  if (isPlainRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${indent}{}`];
    const lines: string[] = [];
    for (const [key, entry] of entries) {
      const scalar =
        entry === null ||
        typeof entry === "string" ||
        typeof entry === "boolean" ||
        typeof entry === "number" ||
        Array.isArray(entry) && entry.length === 0 ||
        isEmptyObject(entry);
      if (scalar) {
        lines.push(`${indent}${key}: ${renderYamlScalar(entry)}`);
        continue;
      }
      lines.push(`${indent}${key}:`);
      lines.push(...renderYamlBlock(entry, indentLevel + 1));
    }
    return lines;
  }

  return [`${indent}${renderYamlScalar(value)}`];
}

function renderFrontmatter(frontmatter: Record<string, unknown>) {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    const scalar =
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      typeof value === "number" ||
      Array.isArray(value) && value.length === 0 ||
      isEmptyObject(value);
    if (scalar) {
      lines.push(`${key}: ${renderYamlScalar(value)}`);
      continue;
    }
    lines.push(`${key}:`);
    lines.push(...renderYamlBlock(value, 1));
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

function buildMarkdown(frontmatter: Record<string, unknown>, body: string) {
  const cleanBody = body.replace(/\r\n/g, "\n").trim();
  if (!cleanBody) {
    return `${renderFrontmatter(frontmatter)}\n`;
  }
  return `${renderFrontmatter(frontmatter)}\n${cleanBody}\n`;
}

function renderCompanyAgentsSection(agentSummaries: Array<{ slug: string; name: string }>) {
  const lines = ["# Agents", ""];
  if (agentSummaries.length === 0) {
    lines.push("- _none_");
    return lines.join("\n");
  }
  for (const agent of agentSummaries) {
    lines.push(`- ${agent.slug} - ${agent.name}`);
  }
  return lines.join("\n");
}

function parseFrontmatterMarkdown(raw: string): MarkdownDoc {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  const frontmatterRaw = normalized.slice(4, closing).trim();
  const body = normalized.slice(closing + 5).trim();
  const frontmatter: Record<string, unknown> = {};
  for (const line of frontmatterRaw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const rawValue = line.slice(idx + 1).trim();
    if (!key) continue;
    if (rawValue === "null") {
      frontmatter[key] = null;
      continue;
    }
    if (rawValue === "true" || rawValue === "false") {
      frontmatter[key] = rawValue === "true";
      continue;
    }
    if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
      frontmatter[key] = Number(rawValue);
      continue;
    }
    try {
      frontmatter[key] = JSON.parse(rawValue);
      continue;
    } catch {
      frontmatter[key] = rawValue;
    }
  }
  return { frontmatter, body };
}

async function fetchJson(url: string) {
  const body = await fetchText(url);
  try {
    return JSON.parse(body);
  } catch {
    throw unprocessable(`Failed to parse JSON from ${url}`);
  }
}

async function fetchText(url: string) {
  // SSRF guard: protocol whitelist + DNS resolution + private IP rejection,
  // then pin the resolved IP into the request to close the DNS-rebind window.
  const target = await validateAndResolveFetchUrl(url);
  const response = await executePinnedRequest(target, undefined, AbortSignal.timeout(30_000));
  if (response.status >= 400) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.body;
}

/** Test-only handle to the module-private fetch helpers. Do not import from production code. */
export const __test__ = { fetchJson, fetchText };

function dedupeRequiredSecrets(values: CompanyPortabilityManifest["requiredSecrets"]) {
  const seen = new Set<string>();
  const out: CompanyPortabilityManifest["requiredSecrets"] = [];
  for (const value of values) {
    const key = `${value.agentSlug ?? ""}:${value.key.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function parseGitHubTreeUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.hostname !== "github.com") {
    throw unprocessable("GitHub source must use github.com URL");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw unprocessable("Invalid GitHub URL");
  }
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, "");
  let ref = "main";
  let basePath = "";
  if (parts[2] === "tree") {
    ref = parts[3] ?? "main";
    basePath = parts.slice(4).join("/");
  }
  return { owner, repo, ref, basePath };
}

function resolveRawGitHubUrl(owner: string, repo: string, ref: string, filePath: string) {
  const normalizedFilePath = filePath.replace(/^\/+/, "");
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${normalizedFilePath}`;
}

async function readAgentInstructions(agent: AgentLike): Promise<{ body: string; warning: string | null }> {
  const config = agent.adapterConfig as Record<string, unknown>;
  const instructionsFilePath = asString(config.instructionsFilePath);
  if (instructionsFilePath) {
    const workspaceCwd = asString(process.env.AOA_WORKSPACE_CWD);
    const candidates = new Set<string>();
    if (path.isAbsolute(instructionsFilePath)) {
      candidates.add(instructionsFilePath);
    } else {
      if (workspaceCwd) candidates.add(path.resolve(workspaceCwd, instructionsFilePath));
      candidates.add(path.resolve(process.cwd(), instructionsFilePath));
    }

    for (const candidate of candidates) {
      try {
        const stat = await fs.stat(candidate);
        if (!stat.isFile() || stat.size > 1024 * 1024) continue;
        const body = await Promise.race([
          fs.readFile(candidate, "utf8"),
          new Promise<string>((_, reject) => {
            setTimeout(() => reject(new Error("timed out reading instructions file")), 1500);
          }),
        ]);
        return { body, warning: null };
      } catch {
        // try next candidate
      }
    }
  }
  const promptTemplate = asString(config.promptTemplate);
  if (promptTemplate) {
    const warning = instructionsFilePath
      ? `Agent ${agent.name} instructionsFilePath was not readable; fell back to promptTemplate.`
      : null;
    return {
      body: promptTemplate,
      warning,
    };
  }
  return {
    body: "_No AGENTS instructions were resolved from current agent config._",
    warning: `Agent ${agent.name} has no resolvable instructionsFilePath/promptTemplate; exported placeholder AGENTS.md.`,
  };
}

export function companyPortabilityService(db: Db) {
  const companies = companyService(db);
  const agents = agentService(db);
  // P3: the former `access` service handle held ONLY the now-removed
  // `ensureRealOperator` call — company + founder membership are now written
  // atomically inside `companies.createWithOperator`, which takes a tx-bound
  // `accessService` factory directly. `accessService` stays imported for that
  // factory below.
  const projects = projectService(db);
  const issues = issueService(db);
  const skills = companySkillService(db);
  const routines = routineService(db);

  async function resolveSource(source: CompanyPortabilityPreview["source"]): Promise<ResolvedSource> {
    if (source.type === "inline") {
      const manifest = portabilityManifestSchema.parse(source.manifest) as CompanyPortabilityManifest;
      return {
        manifest,
        files: source.files,
        warnings: collectManifestWarnings(manifest),
      };
    }

    if (source.type === "url") {
      const manifestJson = await fetchJson(source.url);
      const manifest = portabilityManifestSchema.parse(manifestJson) as CompanyPortabilityManifest;
      const base = new URL(".", source.url);
      const files: Record<string, string> = {};
      const warnings: ImportWarning[] = collectManifestWarnings(manifest);

      if (manifest.company?.path) {
        const companyPath = ensureMarkdownPath(manifest.company.path);
        files[companyPath] = await fetchText(new URL(companyPath, base).toString());
      }
      for (const agent of manifest.agents) {
        const filePath = ensureMarkdownPath(agent.path);
        files[filePath] = await fetchText(new URL(filePath, base).toString());
      }

      return { manifest, files, warnings };
    }

    const parsed = parseGitHubTreeUrl(source.url);
    let ref = parsed.ref;
    const manifestRelativePath = [parsed.basePath, "paperclip.manifest.json"].filter(Boolean).join("/");
    let manifest: CompanyPortabilityManifest | null = null;
    const warnings: ImportWarning[] = [];
    try {
      manifest = portabilityManifestSchema.parse(
        await fetchJson(resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, manifestRelativePath)),
      ) as CompanyPortabilityManifest;
    } catch (err) {
      if (ref === "main") {
        ref = "master";
        warnings.push({
          kind: "deprecated_field",
          message: "GitHub ref main not found; falling back to master.",
        });
        manifest = portabilityManifestSchema.parse(
          await fetchJson(resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, manifestRelativePath)),
        ) as CompanyPortabilityManifest;
      } else {
        throw err;
      }
    }

    // manifest is guaranteed non-null: if both parse attempts fail, the catch rethrows
    const resolvedManifest = manifest!;
    warnings.push(...collectManifestWarnings(resolvedManifest));
    const files: Record<string, string> = {};
    if (resolvedManifest.company?.path) {
      files[resolvedManifest.company.path] = await fetchText(
        resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, [parsed.basePath, resolvedManifest.company.path].filter(Boolean).join("/")),
      );
    }
    for (const agent of resolvedManifest.agents) {
      files[agent.path] = await fetchText(
        resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, [parsed.basePath, agent.path].filter(Boolean).join("/")),
      );
    }
    return { manifest: resolvedManifest, files, warnings };
  }

  async function exportBundle(
    companyId: string,
    input: CompanyPortabilityExport,
  ): Promise<CompanyPortabilityExportResult> {
    const include = normalizeInclude(input.include);
    const company = await companies.getById(companyId);
    if (!company) throw notFound("Company not found");

    const files: Record<string, string> = {};
    const warnings: string[] = [];
    const requiredSecrets: CompanyPortabilityManifest["requiredSecrets"] = [];
    const generatedAt = new Date().toISOString();

    const manifest: CompanyPortabilityManifest = {
      schemaVersion: include.projects || include.issues || include.skills || include.routines || include.envInputs ? 2 : 1,
      generatedAt,
      source: {
        companyId: company.id,
        companyName: company.name,
      },
      includes: include,
      company: null,
      agents: [],
      requiredSecrets: [],
    };

    const envInputs: CompanyPortabilityEnvInputManifestEntry[] = [];

    const costEventsEnabled = isCostEventsEnabled(include.costEvents);
    const financeEventsEnabled = include.financeEvents === true;
    const needAgentSlugs = include.agents || include.issues || include.routines || include.envInputs || include.budgetPolicies || costEventsEnabled || financeEventsEnabled;
    const needSkills = include.skills;
    const skillRows = needSkills ? await skills.listFull(companyId) : [];
    const validSkillKeys = new Set(skillRows.map((skill) => skill.key));
    const allAgentRows = needAgentSlugs ? await agents.list(companyId, { includeTerminated: true }) : [];
    const agentRows = allAgentRows.filter((agent) => agent.status !== "terminated");
    if (include.agents) {
      const skipped = allAgentRows.length - agentRows.length;
      if (skipped > 0) {
        warnings.push(`Skipped ${skipped} terminated agent${skipped === 1 ? "" : "s"} from export.`);
      }
    }

    const usedSlugs = new Set<string>();
    const idToSlug = new Map<string, string>();
    for (const agent of agentRows) {
      const baseSlug = toSafeSlug(agent.name, "agent");
      const slug = uniqueSlug(baseSlug, usedSlugs);
      idToSlug.set(agent.id, slug);
    }

    if (include.company) {
      const companyPath = "COMPANY.md";
      const companyAgentSummaries = agentRows.map((agent) => ({
        slug: idToSlug.get(agent.id) ?? "agent",
        name: agent.name,
      }));
      files[companyPath] = buildMarkdown(
        {
          kind: "company",
          name: company.name,
          description: company.description ?? null,
          brandColor: company.brandColor ?? null,
          requireBoardApprovalForNewAgents: company.requireBoardApprovalForNewAgents,
        },
        renderCompanyAgentsSection(companyAgentSummaries),
      );
      manifest.company = {
        path: companyPath,
        name: company.name,
        description: company.description ?? null,
        brandColor: company.brandColor ?? null,
        requireBoardApprovalForNewAgents: company.requireBoardApprovalForNewAgents,
        agentCompletionPolicyDefault: company.agentCompletionPolicyDefault === "agent_can_complete"
          ? "agent_can_complete"
          : "review_required",
        agentCompletionReviewGuardrail: company.agentCompletionReviewGuardrail,
      };
    }

    if (include.agents) {
      for (const agent of agentRows) {
        const slug = idToSlug.get(agent.id)!;
        const instructions = await readAgentInstructions(agent);
        if (instructions.warning) warnings.push(instructions.warning);
        const agentPath = `agents/${slug}/AGENTS.md`;

        const secretStart = requiredSecrets.length;
        const adapterDefaultRules = ADAPTER_DEFAULT_RULES_BY_TYPE[agent.adapterType] ?? [];
        const portableAdapterConfig = pruneDefaultLikeValue(
          normalizePortableConfig(agent.adapterConfig, slug, requiredSecrets),
          {
            dropFalseBooleans: true,
            defaultRules: adapterDefaultRules,
          },
        ) as Record<string, unknown>;
        const portableRuntimeConfig = pruneDefaultLikeValue(
          normalizePortableConfig(agent.runtimeConfig, slug, requiredSecrets),
          {
            dropFalseBooleans: true,
            defaultRules: RUNTIME_DEFAULT_RULES,
          },
        ) as Record<string, unknown>;
        const portablePermissions = pruneDefaultLikeValue(agent.permissions ?? {}, { dropFalseBooleans: true }) as Record<string, unknown>;
        const agentRequiredSecrets = dedupeRequiredSecrets(
          requiredSecrets
            .slice(secretStart)
            .filter((requirement) => requirement.agentSlug === slug),
        );
        const reportsToSlug = agent.reportsTo ? (idToSlug.get(agent.reportsTo) ?? null) : null;
        const parentType = agent.parentType ?? (agent.reportsTo ? "agent" : null);
        const parentIdSlug = parentType === "agent" && agent.parentId
          ? (idToSlug.get(agent.parentId) ?? null)
          : null;

        files[agentPath] = buildMarkdown(
          {
            name: agent.name,
            slug,
            role: agent.role,
            adapterType: agent.adapterType,
            kind: "agent",
            icon: agent.icon ?? null,
            capabilities: agent.capabilities ?? null,
            reportsTo: reportsToSlug,
            parentType,
            parentIdRef: parentType === "user" ? (agent.parentId ?? null) : parentIdSlug,
            runtimeConfig: portableRuntimeConfig,
            permissions: portablePermissions,
            adapterConfig: portableAdapterConfig,
            requiredSecrets: agentRequiredSecrets,
          },
          instructions.body,
        );

        const agentSkillKeys = Array.isArray((agent as { skillKeys?: unknown }).skillKeys)
          ? ((agent as { skillKeys: unknown[] }).skillKeys.filter((k): k is string => typeof k === "string"))
          : [];
        const portableSkillKeys = needSkills
          ? agentSkillKeys.filter((key) => validSkillKeys.has(key))
          : agentSkillKeys;
        manifest.agents.push({
          slug,
          name: agent.name,
          path: agentPath,
          role: agent.role,
          title: agent.title ?? null,
          icon: agent.icon ?? null,
          capabilities: agent.capabilities ?? null,
          reportsToSlug,
          parentType,
          parentIdRef: parentType === "user" ? (agent.parentId ?? null) : parentIdSlug,
          adapterType: agent.adapterType,
          adapterConfig: portableAdapterConfig,
          runtimeConfig: portableRuntimeConfig,
          permissions: portablePermissions,
          budgetMonthlyCents: agent.budgetMonthlyCents ?? 0,
          metadata: (agent.metadata as Record<string, unknown> | null) ?? null,
          ...(portableSkillKeys.length > 0 ? { skillKeys: portableSkillKeys } : {}),
        });
      }
    }

    const projectIdToSlug = new Map<string, string>();
    const needProjectSlugs = include.projects || include.issues || include.routines || costEventsEnabled || financeEventsEnabled;
    if (needProjectSlugs) {
      const projectRows = await projects.list(companyId);
      const liveProjects = projectRows.filter((project) => !project.archivedAt);
      const usedProjectSlugs = new Set<string>();
      const projectManifest: CompanyPortabilityProjectManifestEntry[] = [];
      for (const project of liveProjects) {
        const baseSlug = deriveProjectUrlKey(project.name, project.id);
        const slug = uniqueSlug(baseSlug, usedProjectSlugs);
        projectIdToSlug.set(project.id, slug);
        if (!include.projects) continue;
        const leadAgentSlug = project.leadAgentId ? (idToSlug.get(project.leadAgentId) ?? null) : null;
        const type: CompanyPortabilityProjectManifestEntry["type"] =
          project.type === "project" ? "project" : "department";
        projectManifest.push({
          slug,
          name: project.name,
          type,
          description: project.description ?? null,
          parentSlug: null,
          status: project.status ?? null,
          color: project.color ?? null,
          targetDate: project.targetDate ?? null,
          leadAgentSlug,
          functionType: project.functionType ?? null,
          agentCompletionPolicyDefault:
            project.agentCompletionPolicyDefault === "review_required" ||
            project.agentCompletionPolicyDefault === "agent_can_complete"
              ? project.agentCompletionPolicyDefault
              : null,
          executionWorkspacePolicy:
            (project.executionWorkspacePolicy as Record<string, unknown> | null) ?? null,
        });
      }
      if (include.projects) {
        manifest.projects = sortProjectsTopologically(projectManifest);
      }
    }

    const issueIdToSlug = new Map<string, string>();
    const needIssueSlugs = include.issues || costEventsEnabled || financeEventsEnabled;
    if (needIssueSlugs) {
      // Company export = the full task graph. Crew-agent tasks must be included
      // in the bundle (the fail-safe list() default is 'org' as of 2026-06-02;
      // pass 'all' explicitly so an export never silently drops crew tasks).
      const issueRows = await issues.list(companyId, { taskScope: "all" });
      const usedIssueSlugs = new Set<string>();
      const issueManifest: CompanyPortabilityIssueManifestEntry[] = [];
      for (const issue of issueRows) {
        const baseSlug = toSafeSlug(
          issue.identifier ?? issue.title,
          `issue-${issueManifest.length + 1}`,
        );
        const slug = uniqueSlug(baseSlug, usedIssueSlugs);
        issueIdToSlug.set(issue.id, slug);
        if (!include.issues) continue;
        const projectSlug = issue.projectId ? (projectIdToSlug.get(issue.projectId) ?? null) : null;
        const assigneeAgentSlug = issue.assigneeAgentId
          ? (idToSlug.get(issue.assigneeAgentId) ?? null)
          : null;
        const labelNames = Array.isArray((issue as { labels?: Array<{ name: string }> }).labels)
          ? ((issue as { labels: Array<{ name: string }> }).labels.map((label) => label.name))
          : [];
        issueManifest.push({
          slug,
          title: issue.title,
          description: issue.description ?? null,
          status: issue.status ?? null,
          priority: issue.priority ?? null,
          projectSlug,
          assigneeAgentSlug,
          assigneeUserEmail: null,
          labelNames,
          billingCode: issue.billingCode ?? null,
          dueDate: issue.dueDate ? new Date(issue.dueDate).toISOString() : null,
          identifier: issue.identifier ?? null,
          recurring: false,
          assigneeAdapterOverrides:
            (issue.assigneeAdapterOverrides as Record<string, unknown> | null) ?? null,
          executionWorkspaceSettings:
            (issue.executionWorkspaceSettings as Record<string, unknown> | null) ?? null,
          acceptanceCriteria: Array.isArray(issue.acceptanceCriteria)
            ? issue.acceptanceCriteria.filter((criterion): criterion is string => typeof criterion === "string")
            : [],
          agentCompletionPolicyOverride:
            issue.agentCompletionPolicyOverride === "review_required" ||
            issue.agentCompletionPolicyOverride === "agent_can_complete"
              ? issue.agentCompletionPolicyOverride
              : null,
          agentCompletionPolicy:
            issue.agentCompletionPolicy === "agent_can_complete"
              ? "agent_can_complete"
              : "review_required",
          agentCompletionPolicySource:
            issue.agentCompletionPolicySource === "company" ||
            issue.agentCompletionPolicySource === "department" ||
            issue.agentCompletionPolicySource === "project" ||
            issue.agentCompletionPolicySource === "routine" ||
            issue.agentCompletionPolicySource === "workflow_template" ||
            issue.agentCompletionPolicySource === "task"
              ? issue.agentCompletionPolicySource
              : "legacy_backfill",
          ...(!Number.isNaN(new Date(issue.agentCompletionPolicyResolvedAt).getTime())
            ? { agentCompletionPolicyResolvedAt: new Date(issue.agentCompletionPolicyResolvedAt).toISOString() }
            : {}),
          metadata: null,
        });
      }
      if (include.issues) {
        manifest.issues = issueManifest;
      }
    }

    if (include.skills) {
      const skillManifest: CompanyPortabilitySkillManifestEntry[] = [];
      for (const skill of skillRows) {
        const skillPath = `skills/${skill.slug}/SKILL.md`;
        files[skillPath] = skill.markdown ?? "";
        skillManifest.push({
          key: skill.key,
          slug: skill.slug,
          name: skill.name,
          path: skillPath,
          description: skill.description ?? null,
          markdown: skill.markdown ?? "",
          sourceType: skill.sourceType,
          sourceLocator: skill.sourceLocator ?? null,
          sourceRef: skill.sourceRef ?? null,
          trustLevel: skill.trustLevel ?? null,
          compatibility: skill.compatibility ?? null,
          fileInventory: Array.isArray(skill.fileInventory)
            ? skill.fileInventory.map((entry) => ({
                path: String((entry as { path?: unknown }).path ?? ""),
                kind: String((entry as { kind?: unknown }).kind ?? "other"),
              })).filter((entry) => entry.path.length > 0)
            : [],
          metadata: (skill.metadata as Record<string, unknown> | null) ?? null,
        });
      }
      manifest.skills = skillManifest;
    }

    if (include.routines) {
      const routineRows = await routines.listForExport(companyId);
      const usedRoutineSlugs = new Set<string>();
      const routineManifest: CompanyPortabilityRoutineManifestEntry[] = [];
      for (const { routine, triggers } of routineRows) {
        const projectSlug = routine.projectId ? projectIdToSlug.get(routine.projectId) : undefined;
        const assigneeAgentSlug = routine.assigneeAgentId
          ? idToSlug.get(routine.assigneeAgentId)
          : undefined;
        if (!projectSlug) {
          warnings.push(
            `Skipped routine "${routine.title}" because its project was not resolvable in the export scope.`,
          );
          continue;
        }
        if (!assigneeAgentSlug) {
          warnings.push(
            `Skipped routine "${routine.title}" because its assignee agent was not resolvable in the export scope.`,
          );
          continue;
        }
        const baseSlug = toSafeSlug(routine.title, `routine-${routineManifest.length + 1}`);
        const slug = uniqueSlug(baseSlug, usedRoutineSlugs);
        routineManifest.push({
          slug,
          title: routine.title,
          description: routine.description ?? null,
          status: routine.status,
          priority: routine.priority,
          concurrencyPolicy: routine.concurrencyPolicy,
          catchUpPolicy: routine.catchUpPolicy,
          agentCompletionPolicyOverride: routine.agentCompletionPolicyOverride ?? null,
          projectSlug,
          assigneeAgentSlug,
          variables: routine.variables.map((variable) => ({
            name: variable.name,
            label: variable.label,
            type: variable.type,
            defaultValue: variable.defaultValue,
            required: variable.required,
            options: variable.options,
          })),
          triggers: triggers.map((trigger) => ({
            kind: trigger.kind,
            label: trigger.label,
            enabled: trigger.enabled,
            cronExpression: trigger.kind === "schedule" ? (trigger.cronExpression ?? null) : null,
            timezone: trigger.kind === "schedule" ? (trigger.timezone ?? null) : null,
            signingMode: trigger.kind === "webhook" ? (trigger.signingMode ?? null) : null,
            replayWindowSec: trigger.kind === "webhook" ? (trigger.replayWindowSec ?? null) : null,
            publicId: trigger.publicId && trigger.publicId.length > 0 ? trigger.publicId : null,
          })),
        });
      }
      manifest.routines = routineManifest;
    }

    if (include.envInputs) {
      for (const agent of agentRows) {
        const slug = idToSlug.get(agent.id)!;
        const agentEnv = (agent.adapterConfig as Record<string, unknown> | null | undefined)?.env;
        envInputs.push(...extractPortableEnvInputs(slug, agentEnv, warnings));
      }
      manifest.envInputs = dedupeEnvInputs(envInputs);
    }

    if (include.internalAgentConfig) {
      const rows = (await db
        .select()
        .from(internalAgentConfig)
        .where(eq(internalAgentConfig.companyId, companyId))) as Record<string, unknown>[];
      const row = rows[0];
      if (row) {
        manifest.internalAgentConfig = serializeInternalAgentConfigRow(row);
      }
    }

    if (include.budgetPolicies) {
      const rows = (await db
        .select()
        .from(budgetPolicies)
        .where(eq(budgetPolicies.companyId, companyId))) as Record<string, unknown>[];
      const serialized: CompanyPortabilityBudgetPolicyManifestEntry[] = [];
      for (const row of rows) {
        if (row.scopeType === "agent") {
          const scopeAgentId = typeof row.scopeId === "string" ? row.scopeId : null;
          const scopeAgentSlug = scopeAgentId ? (idToSlug.get(scopeAgentId) ?? null) : null;
          if (!scopeAgentSlug) {
            warnings.push(
              `Skipped agent-scoped budget policy ${String(row.id ?? "")}: agent not in export scope.`,
            );
            continue;
          }
          serialized.push(serializeBudgetPolicyRow(row, scopeAgentSlug));
        } else {
          serialized.push(serializeBudgetPolicyRow(row, null));
        }
      }
      manifest.budgetPolicies = serialized;
    }

    const exportedCostEventIds = new Set<string>();
    if (costEventsEnabled) {
      const { from, to } = costEventsDateRange(include.costEvents);
      const conditions = [eq(costEvents.companyId, companyId)];
      if (from) conditions.push(gte(costEvents.occurredAt, from));
      if (to) conditions.push(lte(costEvents.occurredAt, to));
      const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);
      const rows = (await db
        .select()
        .from(costEvents)
        .where(whereClause)) as Record<string, unknown>[];
      const serialized: CompanyPortabilityCostEventManifestEntry[] = [];
      for (const row of rows) {
        const agentId = typeof row.agentId === "string" ? row.agentId : null;
        const issueId = typeof row.issueId === "string" ? row.issueId : null;
        const projectId = typeof row.projectId === "string" ? row.projectId : null;
        const agentSlug = agentId ? (idToSlug.get(agentId) ?? null) : null;
        const issueSlug = issueId ? (issueIdToSlug.get(issueId) ?? null) : null;
        const projectSlug = projectId ? (projectIdToSlug.get(projectId) ?? null) : null;
        if (typeof row.id === "string") exportedCostEventIds.add(row.id);
        serialized.push(serializeCostEventRow(row, { agentSlug, issueSlug, projectSlug }));
      }
      manifest.costEvents = serialized;
      if (serialized.length > COST_EVENT_VOLUME_THRESHOLD) {
        warnings.push(
          `Large bundle: ${serialized.length} cost events exported (exceeds ${COST_EVENT_VOLUME_THRESHOLD} threshold). Consider using a date range filter.`,
        );
      }
    }

    if (financeEventsEnabled) {
      const rows = (await db
        .select()
        .from(financeEvents)
        .where(eq(financeEvents.companyId, companyId))) as Record<string, unknown>[];
      const serialized: CompanyPortabilityFinanceEventManifestEntry[] = [];
      for (const row of rows) {
        const agentId = typeof row.agentId === "string" ? row.agentId : null;
        const issueId = typeof row.issueId === "string" ? row.issueId : null;
        const projectId = typeof row.projectId === "string" ? row.projectId : null;
        const costEventId = typeof row.costEventId === "string" ? row.costEventId : null;
        const agentSlug = agentId ? (idToSlug.get(agentId) ?? null) : null;
        const issueSlug = issueId ? (issueIdToSlug.get(issueId) ?? null) : null;
        const projectSlug = projectId ? (projectIdToSlug.get(projectId) ?? null) : null;
        const costEventSlug = costEventId && exportedCostEventIds.has(costEventId) ? costEventId : null;
        serialized.push(serializeFinanceEventRow(row, { agentSlug, issueSlug, projectSlug, costEventSlug }));
      }
      manifest.financeEvents = serialized;
    }

    if (include.quotaWindows) {
      const rows = (await db
        .select()
        .from(providerQuotaWindows)
        .where(eq(providerQuotaWindows.companyId, companyId))) as Record<string, unknown>[];
      manifest.quotaWindows = rows.map((row) => serializeQuotaWindowRow(row));
    }

    if (include.workflowTemplates) {
      const rows = (await db
        .select()
        .from(workflowTemplates)
        .where(eq(workflowTemplates.companyId, companyId))) as Record<string, unknown>[];
      manifest.workflowTemplates = rows.map((row) => serializeWorkflowTemplateRow(row));
    }

    manifest.requiredSecrets = dedupeRequiredSecrets(requiredSecrets);

    files["README.md"] = generateReadme(manifest, {
      companyName: company.name,
      companyDescription: company.description ?? null,
    });

    return {
      manifest,
      files,
      warnings,
    };
  }

  async function previewExport(
    companyId: string,
    input: CompanyPortabilityExport,
  ): Promise<CompanyPortabilityExportPreviewResult> {
    const bundle = await exportBundle(companyId, input);
    const filePaths = Object.keys(bundle.files).sort((a, b) => a.localeCompare(b));
    const manifestBytes = JSON.stringify(bundle.manifest).length;
    let fileBytes = 0;
    for (const body of Object.values(bundle.files)) {
      fileBytes += body.length;
    }
    return {
      counts: {
        agents: bundle.manifest.agents.length,
        projects: bundle.manifest.projects?.length ?? 0,
        issues: bundle.manifest.issues?.length ?? 0,
        skills: bundle.manifest.skills?.length ?? 0,
        routines: bundle.manifest.routines?.length ?? 0,
        envInputs: bundle.manifest.envInputs?.length ?? 0,
        internalAgentConfig: bundle.manifest.internalAgentConfig ? 1 : 0,
        budgetPolicies: bundle.manifest.budgetPolicies?.length ?? 0,
        costEvents: bundle.manifest.costEvents?.length ?? 0,
        financeEvents: bundle.manifest.financeEvents?.length ?? 0,
        quotaWindows: bundle.manifest.quotaWindows?.length ?? 0,
        workflowTemplates: bundle.manifest.workflowTemplates?.length ?? 0,
      },
      files: filePaths,
      estimatedBytes: manifestBytes + fileBytes,
      warnings: bundle.warnings,
    };
  }

  async function buildPreview(input: CompanyPortabilityPreview): Promise<ImportPlanInternal> {
    const include = normalizeInclude(input.include);
    const source = await resolveSource(input.source);
    const manifest = source.manifest;
    const collisionStrategy = input.collisionStrategy ?? DEFAULT_COLLISION_STRATEGY;
    const overwriteCustomizedSkillKeys = new Set(input.overwriteCustomizedSkillKeys ?? []);
    const warnings = [...source.warnings];
    const errors: string[] = [];

    if (include.company && !manifest.company) {
      errors.push("Manifest does not include company metadata.");
    }

    const selectedSlugs = input.agents && input.agents !== "all"
      ? Array.from(new Set(input.agents))
      : manifest.agents.map((agent) => agent.slug);

    const selectedAgents = manifest.agents.filter((agent) => selectedSlugs.includes(agent.slug));
    const selectedMissing = selectedSlugs.filter((slug) => !manifest.agents.some((agent) => agent.slug === slug));
    for (const missing of selectedMissing) {
      errors.push(`Selected agent slug not found in manifest: ${missing}`);
    }

    if (include.agents && selectedAgents.length === 0) {
      warnings.push({
        kind: "empty_selection",
        message: "No agents selected for import.",
      });
    }

    for (const agent of selectedAgents) {
      const filePath = ensureMarkdownPath(agent.path);
      const markdown = source.files[filePath];
      if (typeof markdown !== "string") {
        errors.push(`Missing markdown file for agent ${agent.slug}: ${filePath}`);
        continue;
      }
      const parsed = parseFrontmatterMarkdown(markdown);
      if (parsed.frontmatter.kind !== "agent") {
        warnings.push({
          kind: "invalid_frontmatter",
          message: `Agent markdown ${filePath} does not declare kind: agent in frontmatter.`,
        });
      }
    }

    let targetCompanyId: string | null = null;
    let targetCompanyName: string | null = null;

    if (input.target.mode === "existing_company") {
      const targetCompany = await companies.getById(input.target.companyId);
      if (!targetCompany) throw notFound("Target company not found");
      targetCompanyId = targetCompany.id;
      targetCompanyName = targetCompany.name;
    }

    const agentPlans: CompanyPortabilityPreviewAgentPlan[] = [];
    const existingSlugToAgent = new Map<string, { id: string; name: string }>();
    const existingSlugs = new Set<string>();

    if (input.target.mode === "existing_company") {
      const existingAgents = await agents.list(input.target.companyId);
      for (const existing of existingAgents) {
        const slug = normalizeAgentUrlKey(existing.name) ?? existing.id;
        if (!existingSlugToAgent.has(slug)) existingSlugToAgent.set(slug, existing);
        existingSlugs.add(slug);
      }
    }

    for (const manifestAgent of selectedAgents) {
      const existing = existingSlugToAgent.get(manifestAgent.slug) ?? null;
      if (!existing) {
        agentPlans.push({
          slug: manifestAgent.slug,
          action: "create",
          plannedName: manifestAgent.name,
          existingAgentId: null,
          reason: null,
        });
        continue;
      }

      if (collisionStrategy === "replace") {
        agentPlans.push({
          slug: manifestAgent.slug,
          action: "update",
          plannedName: existing.name,
          existingAgentId: existing.id,
          reason: "Existing slug matched; replace strategy.",
        });
        continue;
      }

      if (collisionStrategy === "skip") {
        agentPlans.push({
          slug: manifestAgent.slug,
          action: "skip",
          plannedName: existing.name,
          existingAgentId: existing.id,
          reason: "Existing slug matched; skip strategy.",
        });
        continue;
      }

      const renamed = uniqueNameBySlug(manifestAgent.name, existingSlugs);
      existingSlugs.add(normalizeAgentUrlKey(renamed) ?? manifestAgent.slug);
      agentPlans.push({
        slug: manifestAgent.slug,
        action: "create",
        plannedName: renamed,
        existingAgentId: existing.id,
        reason: "Existing slug matched; rename strategy.",
      });
    }

    const manifestProjects = manifest.projects ?? [];
    const selectedProjects: CompanyPortabilityProjectManifestEntry[] = include.projects
      ? sortProjectsTopologically(manifestProjects)
      : [];

    const projectPlans: CompanyPortabilityPreviewProjectPlan[] = [];
    const existingProjectSlugToRow = new Map<string, { id: string; name: string }>();
    const existingProjectSlugs = new Set<string>();

    if (include.projects && input.target.mode === "existing_company") {
      const existingProjects = await projects.list(input.target.companyId);
      for (const existing of existingProjects) {
        const slug = normalizeProjectUrlKey(existing.name) ?? existing.id;
        if (!existingProjectSlugToRow.has(slug)) existingProjectSlugToRow.set(slug, { id: existing.id, name: existing.name });
        existingProjectSlugs.add(slug);
      }
    }

    if (include.projects) {
      for (const manifestProject of selectedProjects) {
        const existing = existingProjectSlugToRow.get(manifestProject.slug) ?? null;
        if (!existing) {
          projectPlans.push({
            slug: manifestProject.slug,
            action: "create",
            plannedName: manifestProject.name,
            existingProjectId: null,
            reason: null,
          });
          continue;
        }
        if (collisionStrategy === "replace") {
          projectPlans.push({
            slug: manifestProject.slug,
            action: "update",
            plannedName: existing.name,
            existingProjectId: existing.id,
            reason: "Existing slug matched; replace strategy.",
          });
          continue;
        }
        if (collisionStrategy === "skip") {
          projectPlans.push({
            slug: manifestProject.slug,
            action: "skip",
            plannedName: existing.name,
            existingProjectId: existing.id,
            reason: "Existing slug matched; skip strategy.",
          });
          continue;
        }
        // rename
        const renamed = uniqueProjectNameBySlug(manifestProject.name, existingProjectSlugs);
        existingProjectSlugs.add(normalizeProjectUrlKey(renamed) ?? manifestProject.slug);
        projectPlans.push({
          slug: manifestProject.slug,
          action: "create",
          plannedName: renamed,
          existingProjectId: existing.id,
          reason: "Existing slug matched; rename strategy.",
        });
      }
    }

    const manifestIssues = manifest.issues ?? [];
    const selectedIssues: CompanyPortabilityIssueManifestEntry[] = include.issues
      ? manifestIssues
      : [];
    const issuePlans: CompanyPortabilityPreviewIssuePlan[] = [];
    if (include.issues) {
      for (const manifestIssue of selectedIssues) {
        issuePlans.push({
          slug: manifestIssue.slug,
          action: "create",
          plannedTitle: manifestIssue.title,
          reason: manifestIssue.recurring
            ? "Recurring task — will be handled by routines port (E.1.4)."
            : null,
        });
      }
    }

    const manifestSkills = manifest.skills ?? [];
    const selectedSkills: CompanyPortabilitySkillManifestEntry[] = include.skills ? manifestSkills : [];
    const skillPlans: CompanyPortabilityPreviewSkillPlan[] = [];
    const existingSkillKeyToRow = new Map<string, {
      id: string;
      name: string;
      key: string;
      customized: boolean;
    }>();
    const existingSkillNormalizedKeyToRow = new Map<string, {
      id: string;
      name: string;
      key: string;
      customized: boolean;
    }>();
    // Key lookup and upsert both normalize canonical keys. Allocation must use
    // that same namespace or a raw-key rename such as ALPHA -> alpha can be
    // normalized back onto the row it was supposed to avoid.
    const allocatedSkillNormalizedKeys = new Set<string>();
    if (include.skills && input.target.mode === "existing_company") {
      const existingSkills = await skills.listFullWithCustomization(input.target.companyId);
      for (const existing of existingSkills) {
        const row = {
          id: existing.id,
          name: existing.name,
          key: existing.key,
          customized: existing.customized,
        };
        existingSkillKeyToRow.set(existing.key, row);
        const normalizedKey = normalizeSkillKey(existing.key);
        if (normalizedKey && !existingSkillNormalizedKeyToRow.has(normalizedKey)) {
          existingSkillNormalizedKeyToRow.set(normalizedKey, row);
        }
        allocatedSkillNormalizedKeys.add(normalizedKey ?? existing.key);
      }
    }
    if (include.skills) {
      const seenManifestSkillKeys = new Set<string>();
      for (const manifestSkill of selectedSkills) {
        const normalizedManifestKey =
          normalizeSkillKey(manifestSkill.key) ?? manifestSkill.key;
        if (seenManifestSkillKeys.has(normalizedManifestKey)) {
          errors.push(
            `Duplicate skill key after normalization: ${manifestSkill.key}`,
          );
          continue;
        }
        seenManifestSkillKeys.add(normalizedManifestKey);

        const existing =
          existingSkillKeyToRow.get(manifestSkill.key)
          ?? existingSkillNormalizedKeyToRow.get(normalizedManifestKey)
          ?? null;
        if (!existing) {
          const plannedKey = uniqueSkillKeyByNormalizedKey(
            manifestSkill.key,
            allocatedSkillNormalizedKeys,
          );
          skillPlans.push({
            key: manifestSkill.key,
            slug: manifestSkill.slug,
            action: "create",
            plannedName: manifestSkill.name,
            plannedKey,
            existingSkillId: null,
            existingCustomized: false,
            overwriteCustomized: false,
            reason: plannedKey === manifestSkill.key
              ? null
              : "A prior planned skill reserved this normalized key; renamed.",
          });
          continue;
        }
        if (collisionStrategy === "replace") {
          const overwriteCustomized =
            existing.customized && overwriteCustomizedSkillKeys.has(manifestSkill.key);
          if (existing.customized && !overwriteCustomized) {
            skillPlans.push({
              key: manifestSkill.key,
              slug: manifestSkill.slug,
              action: "skip",
              plannedName: existing.name,
              plannedKey: existing.key,
              existingSkillId: existing.id,
              existingCustomized: true,
              overwriteCustomized: false,
              reason:
                "Existing skill has founder edits; preserved by default. " +
                "Explicitly select this skill key to overwrite it.",
            });
            continue;
          }
          skillPlans.push({
            key: manifestSkill.key,
            slug: manifestSkill.slug,
            action: "update",
            plannedName: manifestSkill.name,
            plannedKey: existing.key,
            existingSkillId: existing.id,
            existingCustomized: existing.customized,
            overwriteCustomized,
            reason: overwriteCustomized
              ? "Existing skill has founder edits; explicit per-item overwrite selected."
              : "Existing key matched; replace strategy.",
          });
          continue;
        }
        if (collisionStrategy === "skip") {
          skillPlans.push({
            key: manifestSkill.key,
            slug: manifestSkill.slug,
            action: "skip",
            plannedName: existing.name,
            plannedKey: existing.key,
            existingSkillId: existing.id,
            existingCustomized: existing.customized,
            overwriteCustomized: false,
            reason: "Existing key matched; skip strategy.",
          });
          continue;
        }
        // rename: generate unique key
        const renamedKey = uniqueSkillKeyByNormalizedKey(
          manifestSkill.key,
          allocatedSkillNormalizedKeys,
        );
        skillPlans.push({
          key: manifestSkill.key,
          slug: manifestSkill.slug,
          action: "create",
          plannedName: manifestSkill.name,
          plannedKey: renamedKey,
          existingSkillId: existing.id,
          existingCustomized: existing.customized,
          overwriteCustomized: false,
          reason: "Existing key matched; rename strategy.",
        });
      }
    }

    const manifestRoutines = manifest.routines ?? [];
    const selectedRoutines: CompanyPortabilityRoutineManifestEntry[] = include.routines ? manifestRoutines : [];
    const routinePlans: CompanyPortabilityPreviewRoutinePlan[] = [];
    const existingRoutineByProjectTitle = new Map<string, { id: string; title: string }>();
    const existingTitlesByProject = new Map<string, Set<string>>();
    if (include.routines && input.target.mode === "existing_company") {
      const existingProjectRows = await projects.list(input.target.companyId);
      const projectIdToSlugTarget = new Map<string, string>();
      for (const project of existingProjectRows) {
        projectIdToSlugTarget.set(project.id, normalizeProjectUrlKey(project.name) ?? project.id);
      }
      const existingRoutineRows = await routines.list(input.target.companyId);
      for (const existing of existingRoutineRows) {
        const projectSlug = existing.projectId ? (projectIdToSlugTarget.get(existing.projectId) ?? "") : "";
        const key = `${projectSlug}::${existing.title}`;
        existingRoutineByProjectTitle.set(key, { id: existing.id, title: existing.title });
        const titles = existingTitlesByProject.get(projectSlug) ?? new Set<string>();
        titles.add(existing.title);
        existingTitlesByProject.set(projectSlug, titles);
      }
    }
    if (include.routines) {
      for (const manifestRoutine of selectedRoutines) {
        const key = `${manifestRoutine.projectSlug}::${manifestRoutine.title}`;
        const existing = existingRoutineByProjectTitle.get(key) ?? null;
        if (!existing) {
          routinePlans.push({
            slug: manifestRoutine.slug,
            action: "create",
            plannedTitle: manifestRoutine.title,
            existingRoutineId: null,
            reason: null,
          });
          continue;
        }
        if (collisionStrategy === "replace") {
          routinePlans.push({
            slug: manifestRoutine.slug,
            action: "update",
            plannedTitle: manifestRoutine.title,
            existingRoutineId: existing.id,
            reason: "Existing routine title matched in project; replace strategy.",
          });
          continue;
        }
        if (collisionStrategy === "skip") {
          routinePlans.push({
            slug: manifestRoutine.slug,
            action: "skip",
            plannedTitle: existing.title,
            existingRoutineId: existing.id,
            reason: "Existing routine title matched in project; skip strategy.",
          });
          continue;
        }
        // rename
        const titles = existingTitlesByProject.get(manifestRoutine.projectSlug) ?? new Set<string>();
        let renamed = manifestRoutine.title;
        let idx = 2;
        while (titles.has(renamed)) {
          renamed = `${manifestRoutine.title} ${idx}`;
          idx += 1;
        }
        titles.add(renamed);
        existingTitlesByProject.set(manifestRoutine.projectSlug, titles);
        routinePlans.push({
          slug: manifestRoutine.slug,
          action: "create",
          plannedTitle: renamed,
          existingRoutineId: existing.id,
          reason: "Existing routine title matched in project; rename strategy.",
        });
      }
    }

    const selectedWorkflowTemplates = include.workflowTemplates
      ? (manifest.workflowTemplates ?? [])
      : [];
    const mutableWorkflowTemplateSlugs = new Set(
      selectedWorkflowTemplates.map(getWorkflowTemplateManifestSlug),
    );
    const workflowTemplatePolicyChangeSlugs = new Set(
      selectedWorkflowTemplates
        .filter((template) => template.agentCompletionPolicyOverride != null)
        .map(getWorkflowTemplateManifestSlug),
    );
    const replaceWorkflowTemplateIdsBySlug = new Map<string, Set<string>>();
    if (
      selectedWorkflowTemplates.length > 0 &&
      (collisionStrategy === "skip" || collisionStrategy === "replace") &&
      input.target.mode === "existing_company"
    ) {
      const existingWorkflowTemplateRows = (await db
        .select({ id: workflowTemplates.id, name: workflowTemplates.name })
        .from(workflowTemplates)
        .where(eq(workflowTemplates.companyId, input.target.companyId))) as Array<{
          id: string;
          name: string;
        }>;
      for (const existingTemplate of existingWorkflowTemplateRows) {
        const slug = synthesizeWorkflowTemplateSlug(existingTemplate.name);
        const matchingTemplates = selectedWorkflowTemplates.filter(
          (template) => getWorkflowTemplateManifestSlug(template) === slug,
        );
        if (matchingTemplates.length === 0) continue;

        if (collisionStrategy === "skip") {
          mutableWorkflowTemplateSlugs.delete(slug);
          workflowTemplatePolicyChangeSlugs.delete(slug);
          continue;
        }

        const authorizedIds = replaceWorkflowTemplateIdsBySlug.get(slug) ?? new Set<string>();
        authorizedIds.add(existingTemplate.id);
        replaceWorkflowTemplateIdsBySlug.set(slug, authorizedIds);
        if (matchingTemplates.some((template) => template.agentCompletionPolicyOverride === null)) {
          workflowTemplatePolicyChangeSlugs.add(slug);
        }
      }
    }

    const preview: CompanyPortabilityPreviewResult = {
      include,
      targetCompanyId,
      targetCompanyName,
      collisionStrategy,
      selectedAgentSlugs: selectedAgents.map((agent) => agent.slug),
      plan: {
        companyAction: input.target.mode === "new_company"
          ? "create"
          : include.company
            ? "update"
            : "none",
        agentPlans,
        projectPlans,
        issuePlans,
        skillPlans,
        routinePlans,
      },
      requiredSecrets: manifest.requiredSecrets ?? [],
      warnings,
      errors,
    };

    return {
      preview,
      source,
      include,
      collisionStrategy,
      selectedAgents,
      selectedProjects,
      selectedIssues,
      selectedSkills,
      selectedRoutines,
      mutableWorkflowTemplateSlugs,
      replaceWorkflowTemplateIdsBySlug,
      workflowTemplatePolicyChangeSlugs,
    };
  }

  async function previewImport(input: CompanyPortabilityPreview): Promise<CompanyPortabilityPreviewResult> {
    const plan = await buildPreview(input);
    return plan.preview;
  }

  async function importBundle(
    input: CompanyPortabilityImport,
    actorUserId: string | null | undefined,
    authorize?: (context: ImportAuthorizationContext) => Promise<void>,
    opts?: { organizationId?: string | null },
  ): Promise<CompanyPortabilityImportResult> {
    const plan = await buildPreview(input);
    if (plan.preview.errors.length > 0) {
      throw unprocessable(`Import preview has errors: ${plan.preview.errors.join("; ")}`);
    }
    await authorize?.(getImportAuthorizationContext(plan));

    const sourceManifest = plan.source.manifest;
    const warnings = [...plan.preview.warnings];
    const include = plan.include;

    let targetCompany: { id: string; name: string } | null = null;
    let companyAction: "created" | "updated" | "unchanged" = "unchanged";
    let deferredCompanyCompletionPolicyPatch: {
      agentCompletionPolicyDefault?: "review_required" | "agent_can_complete";
      agentCompletionReviewGuardrail?: boolean;
    } | null = null;

    if (input.target.mode === "new_company") {
      const companyName =
        asString(input.target.newCompanyName) ??
        sourceManifest.company?.name ??
        sourceManifest.source?.companyName ??
        "Imported Company";
      // T2.3 (R8): this is the SECOND caller of `companies.create`, so a
      // bundle import into a new company ALSO marketplace-provisions the crew.
      // That is deliberate, not incidental: an imported company must be as
      // updateable as a created one, and skipping it would mint a second class
      // of permanently-`@legacy` companies — exactly the state Phase 2 exists
      // to eliminate.
      //
      // It is safe against the bundle's own agents: the crew is `kind='aoa'`
      // and every import/export agent path is `kind='org'`
      // (`agents.list()` defaults to org), so the two rosters never see each
      // other and the name-match merge below cannot touch a crew row. Bundles
      // carry no crew/team section at all (see KNOWN_SECTIONS).
      //
      // Latency is bounded by CREW_INSTALL_DEADLINE_MS + the catalog budget
      // (~42s worst case); import is already a long-running operation.
      // P3 (mirrors Fix 5): the company row AND the importer's founder
      // membership/role/org membership are written atomically inside ONE
      // transaction (`createWithOperator`), so a transient fault mid-import can
      // never commit an orphan company with no membership for anyone. This
      // REPLACES the previous non-atomic `create` + separate `ensureRealOperator`
      // pair. `buildAccess` is bound to the tx handle so the operator writes join
      // it. Group A (operator-independent seeders) runs best-effort post-commit
      // inside createWithOperator; Group B (route-only, operator-dependent) is
      // deliberately NOT run on the import path.
      //
      // D2/H2 + no-self-lockout: seeding the IMPORTER as a genuine founder
      // (company owner membership + founder role + org owner membership) also
      // guarantees a real human founder for the agent-restoration parenting
      // below. Replaces the old bare "board" company-only membership.
      const created = await companies.createWithOperator({
        name: companyName,
        description: include.company ? (sourceManifest.company?.description ?? null) : null,
        brandColor: include.company ? (sourceManifest.company?.brandColor ?? null) : null,
        requireBoardApprovalForNewAgents: include.company
          ? (sourceManifest.company?.requireBoardApprovalForNewAgents ?? true)
          : true,
        agentCompletionPolicyDefault: include.company
          ? (sourceManifest.company?.agentCompletionPolicyDefault ?? "review_required")
          : "review_required",
        agentCompletionReviewGuardrail: include.company
          ? (sourceManifest.company?.agentCompletionReviewGuardrail ?? false)
          : false,
        // D2/H3: the owning Organization is server-resolved + authorized in the
        // route (mirrors POST /) — the self-hosted Default Org for the
        // isolation-not-enforced path, or the real tenant in cloud_auth — and
        // passed here as opts.organizationId. TEN-006a / E2-D07: the fail-OPEN
        // sentinel default is GONE — if no Organization was resolved (a direct
        // non-route caller), createWithOperator now fails CLOSED rather than
        // silently bucketing to the sentinel. (`?? undefined` only normalizes a
        // null opts value to undefined for the writer's `organizationId?: string`
        // field; it is not a fallback.)
        organizationId: opts?.organizationId ?? undefined,
      }, { requestedByUserId: actorUserId ?? null }, actorUserId, (tx) => accessService(tx));
      targetCompany = created.company;
      companyAction = "created";
    } else {
      targetCompany = await companies.getById(input.target.companyId);
      if (!targetCompany) throw notFound("Target company not found");
      if (include.company && sourceManifest.company) {
        const completionPolicyPatch = {
          ...(sourceManifest.company.agentCompletionPolicyDefault !== undefined
            ? { agentCompletionPolicyDefault: sourceManifest.company.agentCompletionPolicyDefault }
            : {}),
          ...(sourceManifest.company.agentCompletionReviewGuardrail !== undefined
            ? { agentCompletionReviewGuardrail: sourceManifest.company.agentCompletionReviewGuardrail }
            : {}),
        };
        deferredCompanyCompletionPolicyPatch = Object.keys(completionPolicyPatch).length > 0
          ? completionPolicyPatch
          : null;
        const updated = await companies.update(targetCompany.id, {
          name: sourceManifest.company.name,
          description: sourceManifest.company.description,
          brandColor: sourceManifest.company.brandColor,
          requireBoardApprovalForNewAgents: sourceManifest.company.requireBoardApprovalForNewAgents,
        });
        targetCompany = updated ?? targetCompany;
        companyAction = "updated";
      }
    }

    if (!targetCompany) throw notFound("Target company not found");

    // D2/H2: NO ensureRealOperator here. Operator provisioning is a NEW-company
    // concern only and now happens in the new_company branch above (seeding the
    // importer as founder). For an EXISTING company we must never re-own the
    // caller: agentService.create parents restored org agents to the company's
    // pre-existing human founder (orgHierarchy.getFounderUserId), and the route
    // separately requires founder/team_lead to import agents (importsAgents gate).
    // A company with no human founder correctly hard-fails in agentService.create
    // ("no human founder exists") rather than silently promoting the caller.

    const resultAgents: CompanyPortabilityImportResult["agents"] = [];
    const importedSlugToAgentId = new Map<string, string>();
    const existingSlugToAgentId = new Map<string, string>();
    const existingAgents = await agents.list(targetCompany.id);
    for (const existing of existingAgents) {
      existingSlugToAgentId.set(normalizeAgentUrlKey(existing.name) ?? existing.id, existing.id);
    }

    const manifestEnvInputs: CompanyPortabilityEnvInputManifestEntry[] =
      include.envInputs && Array.isArray(sourceManifest.envInputs) ? sourceManifest.envInputs : [];
    const envInputsByAgentSlug = new Map<string, CompanyPortabilityEnvInputManifestEntry[]>();
    for (const envInput of manifestEnvInputs) {
      if (!envInput.agentSlug) continue;
      const existing = envInputsByAgentSlug.get(envInput.agentSlug) ?? [];
      existing.push(envInput);
      envInputsByAgentSlug.set(envInput.agentSlug, existing);
    }

    if (include.agents) {
      for (const planAgent of plan.preview.plan.agentPlans) {
        const manifestAgent = plan.selectedAgents.find((agent) => agent.slug === planAgent.slug);
        if (!manifestAgent) continue;
        if (planAgent.action === "skip") {
          resultAgents.push({
            slug: planAgent.slug,
            id: planAgent.existingAgentId,
            action: "skipped",
            name: planAgent.plannedName,
            reason: planAgent.reason,
          });
          continue;
        }

        const markdownRaw = plan.source.files[manifestAgent.path];
        if (!markdownRaw) {
          warnings.push({
            kind: "missing_file",
            message: `Missing AGENTS markdown for ${manifestAgent.slug}; imported without prompt template.`,
          });
        }
        const markdown = markdownRaw ? parseFrontmatterMarkdown(markdownRaw) : { frontmatter: {}, body: "" };
        const adapterConfig = {
          ...manifestAgent.adapterConfig,
          promptTemplate: markdown.body || asString((manifestAgent.adapterConfig as Record<string, unknown>).promptTemplate) || "",
        } as Record<string, unknown>;
        delete adapterConfig.instructionsFilePath;

        const envInputsForAgent = envInputsByAgentSlug.get(manifestAgent.slug) ?? [];
        if (envInputsForAgent.length > 0) {
          const envRecord = isPlainRecord(adapterConfig.env) ? { ...adapterConfig.env } : {};
          for (const envInput of envInputsForAgent) {
            if (envInput.kind !== "plain") continue;
            if (envInput.defaultValue === null || envInput.defaultValue === "") continue;
            if (envRecord[envInput.key] !== undefined) continue;
            envRecord[envInput.key] = { type: "plain", value: envInput.defaultValue };
          }
          if (Object.keys(envRecord).length > 0) {
            adapterConfig.env = envRecord;
          }
        }
        const patch = {
          name: planAgent.plannedName,
          role: manifestAgent.role,
          title: manifestAgent.title,
          icon: manifestAgent.icon,
          capabilities: manifestAgent.capabilities,
          reportsTo: null as string | null,
          parentType: null as string | null,
          parentId: null as string | null,
          adapterType: manifestAgent.adapterType,
          adapterConfig,
          runtimeConfig: manifestAgent.runtimeConfig,
          budgetMonthlyCents: manifestAgent.budgetMonthlyCents,
          permissions: manifestAgent.permissions,
          metadata: manifestAgent.metadata,
        };

        if (planAgent.action === "update" && planAgent.existingAgentId) {
          const updated = await agents.update(planAgent.existingAgentId, patch);
          if (!updated) {
            warnings.push({
              kind: "skipped_update",
              message: `Skipped update for missing agent ${planAgent.existingAgentId}.`,
            });
            resultAgents.push({
              slug: planAgent.slug,
              id: null,
              action: "skipped",
              name: planAgent.plannedName,
              reason: "Existing target agent not found.",
            });
            continue;
          }
          importedSlugToAgentId.set(planAgent.slug, updated.id);
          existingSlugToAgentId.set(normalizeAgentUrlKey(updated.name) ?? updated.id, updated.id);
          resultAgents.push({
            slug: planAgent.slug,
            id: updated.id,
            action: "updated",
            name: updated.name,
            reason: planAgent.reason,
          });
          continue;
        }

        const created = await agents.create(targetCompany.id, patch);
        importedSlugToAgentId.set(planAgent.slug, created.id);
        existingSlugToAgentId.set(normalizeAgentUrlKey(created.name) ?? created.id, created.id);
        resultAgents.push({
          slug: planAgent.slug,
          id: created.id,
          action: "created",
          name: created.name,
          reason: planAgent.reason,
        });
      }

      // Apply reporting links once all imported agent ids are available.
      for (const manifestAgent of plan.selectedAgents) {
        const agentId = importedSlugToAgentId.get(manifestAgent.slug);
        if (!agentId) continue;

        // Resolve parentType/parentId if present in manifest
        const mParentType = manifestAgent.parentType ?? null;
        const mParentIdRef = manifestAgent.parentIdRef ?? null;

        if (mParentType === "user" && mParentIdRef) {
          // parentIdRef is a user ID for user parents — set directly
          try {
            await agents.update(agentId, {
              parentType: "user",
              parentId: mParentIdRef,
              reportsTo: null,
            });
          } catch {
            warnings.push({
              kind: "link_failed",
              message: `Could not assign user parent ${mParentIdRef} for imported agent ${manifestAgent.slug}.`,
            });
          }
          continue;
        }

        // Agent parent: resolve via slug (same as legacy reportsTo)
        const managerSlug = manifestAgent.reportsToSlug;
        if (!managerSlug) continue;
        const managerId = importedSlugToAgentId.get(managerSlug) ?? existingSlugToAgentId.get(managerSlug) ?? null;
        if (!managerId || managerId === agentId) continue;
        try {
          await agents.update(agentId, {
            reportsTo: managerId,
            parentType: "agent",
            parentId: managerId,
          });
        } catch {
          warnings.push({
            kind: "link_failed",
            message: `Could not assign manager ${managerSlug} for imported agent ${manifestAgent.slug}.`,
          });
        }
      }
    }

    const resultProjects: CompanyPortabilityImportResult["projects"] = [];
    const importedSlugToProjectId = new Map<string, string>();
    const deferredProjectCompletionPolicyPatches: Array<{
      id: string;
      policy: "review_required" | "agent_can_complete" | null;
    }> = [];

    if (include.projects) {
      const existingProjectRows = await projects.list(targetCompany.id);
      const existingProjectSlugToId = new Map<string, string>();
      for (const existing of existingProjectRows) {
        existingProjectSlugToId.set(normalizeProjectUrlKey(existing.name) ?? existing.id, existing.id);
      }

      // plan.selectedProjects is already topologically sorted (departments first).
      for (const planProject of plan.preview.plan.projectPlans) {
        const manifestProject = plan.selectedProjects.find((project) => project.slug === planProject.slug);
        if (!manifestProject) continue;

        const type: "department" | "project" = manifestProject.type === "project" ? "project" : "department";

        if (planProject.action === "skip") {
          if (planProject.existingProjectId) {
            importedSlugToProjectId.set(planProject.slug, planProject.existingProjectId);
          }
          resultProjects.push({
            slug: planProject.slug,
            id: planProject.existingProjectId,
            action: "skipped",
            name: planProject.plannedName,
            type,
            reason: planProject.reason,
          });
          continue;
        }

        const projectPatch = {
          name: planProject.plannedName,
          type,
          description: manifestProject.description ?? null,
          status: manifestProject.status ?? undefined,
          color: manifestProject.color ?? null,
          targetDate: manifestProject.targetDate ?? null,
          functionType: manifestProject.functionType ?? null,
          executionWorkspacePolicy:
            (manifestProject.executionWorkspacePolicy as Record<string, unknown> | null | undefined) ?? null,
        };

        if (planProject.action === "update" && planProject.existingProjectId) {
          const updated = await projects.update(planProject.existingProjectId, projectPatch);
          if (!updated) {
            warnings.push({
              kind: "skipped_update",
              message: `Skipped update for missing project ${planProject.existingProjectId}.`,
            });
            resultProjects.push({
              slug: planProject.slug,
              id: null,
              action: "skipped",
              name: planProject.plannedName,
              type,
              reason: "Existing target project not found.",
            });
            continue;
          }
          importedSlugToProjectId.set(planProject.slug, updated.id);
          existingProjectSlugToId.set(normalizeProjectUrlKey(updated.name) ?? updated.id, updated.id);
          if (manifestProject.agentCompletionPolicyDefault !== undefined) {
            deferredProjectCompletionPolicyPatches.push({
              id: updated.id,
              policy: manifestProject.agentCompletionPolicyDefault,
            });
          }
          resultProjects.push({
            slug: planProject.slug,
            id: updated.id,
            action: "updated",
            name: updated.name,
            type,
            reason: planProject.reason,
          });
          continue;
        }

        const deferCreatedProjectCompletionPolicy =
          input.target.mode === "existing_company" &&
          manifestProject.agentCompletionPolicyDefault !== undefined;
        const created = await projects.create(targetCompany.id, {
          ...projectPatch,
          ...(!deferCreatedProjectCompletionPolicy && manifestProject.agentCompletionPolicyDefault !== undefined
            ? { agentCompletionPolicyDefault: manifestProject.agentCompletionPolicyDefault }
            : {}),
        });
        if (deferCreatedProjectCompletionPolicy) {
          deferredProjectCompletionPolicyPatches.push({
            id: created.id,
            policy: manifestProject.agentCompletionPolicyDefault!,
          });
        }
        importedSlugToProjectId.set(planProject.slug, created.id);
        existingProjectSlugToId.set(normalizeProjectUrlKey(created.name) ?? created.id, created.id);
        resultProjects.push({
          slug: planProject.slug,
          id: created.id,
          action: "created",
          name: created.name,
          type,
          reason: planProject.reason,
        });
      }
    }

    const resultIssues: CompanyPortabilityImportResult["issues"] = [];
    if (include.issues) {
      const existingProjectRows = await projects.list(targetCompany.id);
      const existingProjectSlugToId = new Map<string, string>();
      for (const existing of existingProjectRows) {
        existingProjectSlugToId.set(normalizeProjectUrlKey(existing.name) ?? existing.id, existing.id);
      }
      let labelWarningEmitted = false;

      for (const manifestIssue of plan.selectedIssues) {
        if (manifestIssue.recurring) {
          warnings.push({
            kind: "deprecated_field",
            message: `Issue "${manifestIssue.slug}" is marked recurring; recurring tasks are imported by the routines port (E.1.4) and were skipped here.`,
          });
          resultIssues.push({
            slug: manifestIssue.slug,
            id: null,
            action: "skipped",
            title: manifestIssue.title,
            reason: "Recurring task deferred to routines port.",
          });
          continue;
        }

        if (manifestIssue.labelNames && manifestIssue.labelNames.length > 0 && !labelWarningEmitted) {
          warnings.push({
            kind: "deprecated_field",
            message: "Issue labelNames are present in the bundle but label import is not yet supported; labels were not applied.",
          });
          labelWarningEmitted = true;
        }

        const projectId = manifestIssue.projectSlug
          ? (importedSlugToProjectId.get(manifestIssue.projectSlug)
            ?? existingProjectSlugToId.get(manifestIssue.projectSlug)
            ?? null)
          : null;

        let assigneeAgentId: string | null = null;
        if (manifestIssue.assigneeAgentSlug) {
          assigneeAgentId =
            importedSlugToAgentId.get(manifestIssue.assigneeAgentSlug)
            ?? existingSlugToAgentId.get(manifestIssue.assigneeAgentSlug)
            ?? null;
          if (!assigneeAgentId) {
            warnings.push({
              kind: "skipped_update",
              message: `Issue "${manifestIssue.slug}" references agent slug "${manifestIssue.assigneeAgentSlug}", but that agent was not found; leaving unassigned.`,
            });
          }
        }

        if (manifestIssue.assigneeUserEmail) {
          warnings.push({
            kind: "skipped_update",
            message: `Issue "${manifestIssue.slug}" references user email "${manifestIssue.assigneeUserEmail}", but user remapping by email is not yet supported; leaving unassigned.`,
          });
        }

        const status = manifestIssue.status && ISSUE_STATUSES.has(manifestIssue.status)
          ? manifestIssue.status
          : "backlog";
        const priority = manifestIssue.priority && ISSUE_PRIORITIES.has(manifestIssue.priority)
          ? manifestIssue.priority
          : "medium";
        const effectiveStatus = status === "in_progress" && !assigneeAgentId ? "todo" : status;
        if (effectiveStatus !== status) {
          warnings.push({
            kind: "skipped_update",
            message: `Issue "${manifestIssue.slug}" status downgraded from in_progress to todo because it has no assignee.`,
          });
        }

        const requestedPolicySource = manifestIssue.agentCompletionPolicySource ?? "legacy_backfill" as const;
        const portablePolicySource = requestedPolicySource === "routine" ||
          requestedPolicySource === "workflow_template" ||
          ((requestedPolicySource === "project" || requestedPolicySource === "department") && !projectId)
          ? "legacy_backfill" as const
          : requestedPolicySource;
        const importedPolicySourceId = portablePolicySource === "company"
          ? targetCompany.id
          : portablePolicySource === "project" || portablePolicySource === "department"
            ? projectId
            : null;
        const importedPolicyResolvedAt = manifestIssue.agentCompletionPolicyResolvedAt
          ? new Date(manifestIssue.agentCompletionPolicyResolvedAt)
          : null;
        const completionPolicySnapshot = manifestIssue.agentCompletionPolicy
          ? {
            policy: manifestIssue.agentCompletionPolicy,
            override: manifestIssue.agentCompletionPolicyOverride ?? null,
            source: portablePolicySource,
            sourceId: importedPolicySourceId,
            resolvedAt: importedPolicyResolvedAt && !Number.isNaN(importedPolicyResolvedAt.getTime())
              ? importedPolicyResolvedAt
              : null,
          }
          : {
            policy: "review_required" as const,
            override: null,
            source: "legacy_backfill" as const,
            sourceId: null,
            resolvedAt: null,
          };

        const created = await issues.create(targetCompany.id, {
          projectId,
          title: manifestIssue.title,
          description: manifestIssue.description ?? null,
          status: effectiveStatus,
          priority,
          assigneeAgentId,
          assigneeUserId: null,
          billingCode: manifestIssue.billingCode ?? null,
          assigneeAdapterOverrides: manifestIssue.assigneeAdapterOverrides ?? null,
          executionWorkspaceSettings: manifestIssue.executionWorkspaceSettings ?? null,
          acceptanceCriteria: manifestIssue.acceptanceCriteria ?? [],
          dueDate: manifestIssue.dueDate ? new Date(manifestIssue.dueDate) : null,
          ...(manifestIssue.agentCompletionPolicyOverride !== undefined
            ? { agentCompletionPolicyOverride: manifestIssue.agentCompletionPolicyOverride }
            : {}),
          ...(completionPolicySnapshot ? { completionPolicySnapshot } : {}),
        });

        resultIssues.push({
          slug: manifestIssue.slug,
          id: created.id,
          action: "created",
          title: created.title ?? manifestIssue.title,
          reason: null,
        });
      }
    }

    const resultSkills: CompanyPortabilityImportResult["skills"] = [];
    const skillKeyMap = new Map<string, string>();
    if (include.skills) {
      const skillsToUpsert: Array<{
        plan: CompanyPortabilityPreviewSkillPlan;
        manifestSkill: CompanyPortabilitySkillManifestEntry;
        markdown: string;
      }> = [];

      for (const planSkill of plan.preview.plan.skillPlans) {
        const manifestSkill = plan.selectedSkills.find((s) => s.key === planSkill.key);
        if (!manifestSkill) continue;
        if (planSkill.action === "skip") {
          resultSkills.push({
            key: planSkill.key,
            slug: planSkill.slug,
            id: planSkill.existingSkillId,
            action: "skipped",
            name: planSkill.plannedName,
            reason: planSkill.reason,
          });
          if (planSkill.existingSkillId) {
            skillKeyMap.set(planSkill.key, planSkill.plannedKey);
          }
          continue;
        }

        const rawMarkdown = plan.source.files[manifestSkill.path];
        let markdown = typeof rawMarkdown === "string" ? rawMarkdown : "";
        if (!markdown && typeof manifestSkill.markdown === "string") {
          markdown = manifestSkill.markdown;
        }
        if (typeof rawMarkdown !== "string") {
          warnings.push({
            kind: "missing_file",
            message: `Missing skill markdown for ${manifestSkill.slug} at ${manifestSkill.path}; imported with inline fallback.`,
          });
        }

        skillsToUpsert.push({ plan: planSkill, manifestSkill, markdown });
      }

      if (skillsToUpsert.length > 0) {
        const importEntries = skillsToUpsert.map((entry) => ({
          entry,
          imported: {
            slug: entry.manifestSkill.slug,
            key: entry.plan.plannedKey,
            name: entry.plan.plannedName,
            description: entry.manifestSkill.description ?? null,
            markdown: entry.markdown,
            sourceType: entry.manifestSkill.sourceType,
            sourceLocator: entry.manifestSkill.sourceLocator ?? null,
            sourceRef: entry.manifestSkill.sourceRef ?? null,
            trustLevel: (entry.manifestSkill.trustLevel ?? "markdown_only") as
              | "markdown_only"
              | "assets"
              | "scripts_executables",
            compatibility: (entry.manifestSkill.compatibility ?? "compatible") as
              | "compatible"
              | "unknown"
              | "invalid",
            fileInventory: Array.isArray(entry.manifestSkill.fileInventory)
              ? entry.manifestSkill.fileInventory.map((file) => ({
                  path: String(file.path),
                  kind: (file.kind ?? "other") as
                    | "skill"
                    | "markdown"
                    | "reference"
                    | "script"
                    | "asset"
                    | "other",
                }))
              : [],
            metadata: entry.manifestSkill.metadata ?? null,
          },
        }));
        const skillResultsBySourceKey = new Map<
          string,
          CompanyPortabilityImportResult["skills"][number]
        >();
        const groups = [
          {
            policy: "preserve_founder_edits" as const,
            entries: importEntries.filter(({ entry }) => !entry.plan.overwriteCustomized),
          },
          {
            policy: "caller_is_authoritative" as const,
            entries: importEntries.filter(({ entry }) => entry.plan.overwriteCustomized),
          },
        ];

        for (const group of groups) {
          if (group.entries.length === 0) continue;
          const outcome = await skills.upsertImportedSkills(
            targetCompany.id,
            group.entries.map(({ imported }) => imported),
            group.policy,
          );
          const writtenByKey = new Map(outcome.skills.map((skill) => [skill.key, skill]));
          const refusedByKey = new Map(outcome.refused.map((refused) => [refused.key, refused]));

          for (const { entry } of group.entries) {
            const written = writtenByKey.get(entry.plan.plannedKey);
            const refused = refusedByKey.get(entry.plan.plannedKey);
            if (written) {
              skillKeyMap.set(entry.manifestSkill.key, entry.plan.plannedKey);
              skillResultsBySourceKey.set(entry.manifestSkill.key, {
                key: entry.manifestSkill.key,
                slug: entry.manifestSkill.slug,
                id: written.id,
                action: entry.plan.action === "update" ? "updated" : "created",
                name: entry.plan.plannedName,
                reason: entry.plan.reason,
              });
              continue;
            }

            if (refused) {
              skillKeyMap.set(entry.manifestSkill.key, entry.plan.plannedKey);
            }
            const reason = refused
              ? "Existing skill gained founder edits during import; preserved."
              : "Skill changed concurrently and was not imported.";
            warnings.push({
              kind: "skipped_update",
              message: `${entry.manifestSkill.name}: ${reason}`,
            });
            skillResultsBySourceKey.set(entry.manifestSkill.key, {
              key: entry.manifestSkill.key,
              slug: entry.manifestSkill.slug,
              id: refused?.skillId ?? null,
              action: "skipped",
              name: entry.plan.plannedName,
              reason,
            });
          }
        }

        for (const entry of skillsToUpsert) {
          const result = skillResultsBySourceKey.get(entry.manifestSkill.key);
          if (result) resultSkills.push(result);
        }
      }
    }

    // Remap agent.skillKeys using the skillKeyMap built from skill imports.
    // We only remap imported agents (created/updated this run); existing agents
    // in the target are left alone.
    if (include.agents && skillKeyMap.size > 0) {
      for (const manifestAgent of plan.selectedAgents) {
        const agentId = importedSlugToAgentId.get(manifestAgent.slug);
        if (!agentId) continue;
        const sourceKeys = Array.isArray(manifestAgent.skillKeys) ? manifestAgent.skillKeys : [];
        if (sourceKeys.length === 0) continue;
        const mappedKeys = sourceKeys.map((key) => skillKeyMap.get(key) ?? key);
        try {
          await agents.update(agentId, { skillKeys: mappedKeys } as Record<string, unknown>);
        } catch {
          warnings.push({
            kind: "link_failed",
            message: `Could not set skillKeys for imported agent ${manifestAgent.slug}.`,
          });
        }
      }
    }

    const resultRoutines: CompanyPortabilityImportResult["routines"] = [];
    if (include.routines) {
      const routineProjectSlugToId = new Map<string, string>();
      const existingProjectRows = await projects.list(targetCompany.id);
      for (const existing of existingProjectRows) {
        routineProjectSlugToId.set(normalizeProjectUrlKey(existing.name) ?? existing.id, existing.id);
      }
      for (const [slug, id] of importedSlugToProjectId.entries()) {
        routineProjectSlugToId.set(slug, id);
      }

      const routineAgentSlugToId = new Map<string, string>();
      for (const [slug, id] of existingSlugToAgentId.entries()) routineAgentSlugToId.set(slug, id);
      for (const [slug, id] of importedSlugToAgentId.entries()) routineAgentSlugToId.set(slug, id);

      const actor = { userId: actorUserId ?? null };

      for (const planRoutine of plan.preview.plan.routinePlans) {
        const manifestRoutine = plan.selectedRoutines.find((r) => r.slug === planRoutine.slug);
        if (!manifestRoutine) continue;
        if (planRoutine.action === "skip") {
          resultRoutines.push({
            slug: planRoutine.slug,
            id: planRoutine.existingRoutineId,
            action: "skipped",
            title: planRoutine.plannedTitle,
            reason: planRoutine.reason,
          });
          continue;
        }

        const projectId = routineProjectSlugToId.get(manifestRoutine.projectSlug) ?? null;
        if (!projectId) {
          warnings.push({
            kind: "skipped_update",
            message: `Routine "${manifestRoutine.slug}" references project slug "${manifestRoutine.projectSlug}", but that project was not found; skipping.`,
          });
          resultRoutines.push({
            slug: planRoutine.slug,
            id: null,
            action: "skipped",
            title: planRoutine.plannedTitle,
            reason: "Missing project.",
          });
          continue;
        }

        const assigneeAgentId = routineAgentSlugToId.get(manifestRoutine.assigneeAgentSlug) ?? null;
        if (!assigneeAgentId) {
          warnings.push({
            kind: "skipped_update",
            message: `Routine "${manifestRoutine.slug}" references agent slug "${manifestRoutine.assigneeAgentSlug}", but that agent was not found; skipping.`,
          });
          resultRoutines.push({
            slug: planRoutine.slug,
            id: null,
            action: "skipped",
            title: planRoutine.plannedTitle,
            reason: "Missing assignee agent.",
          });
          continue;
        }

        const routinePatch = {
          projectId,
          title: planRoutine.plannedTitle,
          description: manifestRoutine.description ?? null,
          assigneeAgentId,
          priority: manifestRoutine.priority,
          status: manifestRoutine.status,
          concurrencyPolicy: manifestRoutine.concurrencyPolicy,
          catchUpPolicy: manifestRoutine.catchUpPolicy,
          ...(manifestRoutine.agentCompletionPolicyOverride !== undefined
            ? { agentCompletionPolicyOverride: manifestRoutine.agentCompletionPolicyOverride }
            : {}),
          variables: manifestRoutine.variables,
        };

        let routineId: string | null = null;
        let action: "created" | "updated" = "created";
        if (planRoutine.action === "update" && planRoutine.existingRoutineId) {
          const updated = await routines.update(
            planRoutine.existingRoutineId,
            routinePatch as Parameters<typeof routines.update>[1],
            actor,
          );
          if (updated) {
            routineId = updated.id;
            action = "updated";
          }
        } else {
          const created = await routines.create(
            targetCompany.id,
            routinePatch as Parameters<typeof routines.create>[1],
            actor,
          );
          routineId = created.id;
          action = "created";
        }

        if (!routineId) {
          warnings.push({
            kind: "skipped_update",
            message: `Skipped routine "${manifestRoutine.slug}" \u2014 update target not found.`,
          });
          resultRoutines.push({
            slug: planRoutine.slug,
            id: null,
            action: "skipped",
            title: planRoutine.plannedTitle,
            reason: "Existing target routine not found.",
          });
          continue;
        }

        for (const trigger of manifestRoutine.triggers) {
          try {
            if (trigger.kind === "schedule") {
              await routines.createTrigger(
                routineId,
                {
                  kind: "schedule",
                  label: trigger.label ?? null,
                  cronExpression: trigger.cronExpression ?? "",
                  timezone: trigger.timezone ?? "UTC",
                },
                actor,
              );
            } else if (trigger.kind === "webhook") {
              await routines.createTrigger(
                routineId,
                {
                  kind: "webhook",
                  label: trigger.label ?? null,
                  ...(trigger.signingMode ? { signingMode: trigger.signingMode } : {}),
                  ...(typeof trigger.replayWindowSec === "number"
                    ? { replayWindowSec: trigger.replayWindowSec }
                    : {}),
                },
                actor,
              );
            } else {
              await routines.createTrigger(
                routineId,
                {
                  kind: "api",
                  label: trigger.label ?? null,
                },
                actor,
              );
            }
          } catch (err) {
            warnings.push({
              kind: "link_failed",
              message: `Failed to create ${trigger.kind} trigger for routine "${manifestRoutine.slug}": ${(err as Error).message}`,
            });
          }
        }

        resultRoutines.push({
          slug: planRoutine.slug,
          id: routineId,
          action,
          title: planRoutine.plannedTitle,
          reason: planRoutine.reason,
        });
      }
    }

    if (include.internalAgentConfig && sourceManifest.internalAgentConfig) {
      const cfg = sourceManifest.internalAgentConfig;
      const existingRows = (await db
        .select()
        .from(internalAgentConfig)
        .where(eq(internalAgentConfig.companyId, targetCompany.id))) as Record<string, unknown>[];
      const values: Record<string, unknown> = {
        executionMode: cfg.executionMode,
        provider: cfg.provider ?? null,
        model: cfg.model ?? null,
        cliTool: cfg.cliTool ?? null,
        autonomyLevel: cfg.autonomyLevel,
        // D18 dial-split. PRE-SPLIT bundles carry no `crewAutonomyLevel`; falling
        // back to the shared `autonomyLevel` reproduces exactly the crew behaviour
        // the bundle was exported with. Post-split bundles carry both and neither
        // dial is inferred from the other.
        crewAutonomyLevel: cfg.crewAutonomyLevel ?? cfg.autonomyLevel,
        enabledCapabilities: cfg.enabledCapabilities ?? [],
        notificationPreference: cfg.notificationPreference,
        contextTokenBudget: cfg.contextTokenBudget,
        budgetMonthlyCents: cfg.budgetMonthlyCents ?? null,
        proactiveIntervalMinutes: cfg.proactiveIntervalMinutes,
        metadata: cfg.metadata ?? {},
      };
      if (existingRows.length > 0) {
        await db
          .update(internalAgentConfig)
          .set(values)
          .where(eq(internalAgentConfig.companyId, targetCompany.id));
      } else {
        await db.insert(internalAgentConfig).values({
          companyId: targetCompany.id,
          ...values,
        });
      }
    }

    if (include.budgetPolicies && Array.isArray(sourceManifest.budgetPolicies)) {
      const budgetCollisionStrategy = plan.collisionStrategy;
      for (const policy of sourceManifest.budgetPolicies) {
        let scopeId: string;
        if (policy.scopeType === "agent") {
          const slug = policy.scopeAgentSlug ?? null;
          const resolved = slug
            ? (importedSlugToAgentId.get(slug) ?? existingSlugToAgentId.get(slug) ?? null)
            : null;
          if (!resolved) {
            warnings.push({
              kind: "link_failed",
              message: `Skipped budget policy "${policy.slug}": agent slug "${slug ?? "<missing>"}" not found in target company.`,
            });
            continue;
          }
          scopeId = resolved;
        } else {
          scopeId = targetCompany.id;
        }

        const existingRows = (await db
          .select()
          .from(budgetPolicies)
          .where(eq(budgetPolicies.companyId, targetCompany.id))) as Record<string, unknown>[];
        const collision = existingRows.find(
          (row) =>
            row.scopeType === policy.scopeType
            && row.scopeId === scopeId
            && row.metric === policy.metric
            && row.windowKind === policy.windowKind,
        );

        if (collision) {
          if (budgetCollisionStrategy === "skip" || budgetCollisionStrategy === "rename") {
            // budget policies have no renameable identifier; rename behaves as skip
            continue;
          }
          if (budgetCollisionStrategy === "replace") {
            const existingId = typeof collision.id === "string" ? collision.id : null;
            if (existingId) {
              await db
                .update(budgetPolicies)
                .set({
                  scopeType: policy.scopeType,
                  scopeId,
                  metric: policy.metric,
                  windowKind: policy.windowKind,
                  amountCents: policy.amountCents,
                  warnPercent: policy.warnPercent,
                  hardStopEnabled: policy.hardStopEnabled,
                  notifyEnabled: policy.notifyEnabled,
                  isActive: policy.isActive,
                  updatedByUserId: actorUserId ?? null,
                })
                .where(eq(budgetPolicies.id, existingId));
            }
            continue;
          }
        }

        await db.insert(budgetPolicies).values({
          companyId: targetCompany.id,
          scopeType: policy.scopeType,
          scopeId,
          metric: policy.metric,
          windowKind: policy.windowKind,
          amountCents: policy.amountCents,
          warnPercent: policy.warnPercent,
          hardStopEnabled: policy.hardStopEnabled,
          notifyEnabled: policy.notifyEnabled,
          isActive: policy.isActive,
          createdByUserId: actorUserId ?? null,
          updatedByUserId: actorUserId ?? null,
        });
      }
    }

    // Cost events import must run BEFORE finance events — finance events may
    // reference cost events via costEventSlug, resolved through costEventSlugToNewId.
    const costEventSlugToNewId = new Map<string, string>();
    if (isCostEventsEnabled(include.costEvents) && Array.isArray(sourceManifest.costEvents)) {
      const manifestCostEvents = sourceManifest.costEvents;
      if (manifestCostEvents.length > COST_EVENT_VOLUME_THRESHOLD) {
        warnings.push({
          kind: "large_volume",
          section: "costEvents",
          count: manifestCostEvents.length,
          message: `Bundle contains ${manifestCostEvents.length} cost events (exceeds ${COST_EVENT_VOLUME_THRESHOLD} threshold); import may take longer than usual.`,
        });
      }

      const existingProjectSlugToIdForCostEvents = new Map<string, string>();
      const existingIssueSlugToId = new Map<string, string>();
      let needProjectLookup = manifestCostEvents.some((e) => e.projectSlug);
      let needIssueLookup = manifestCostEvents.some((e) => e.issueSlug);
      if (needProjectLookup) {
        const projectRows = await projects.list(targetCompany.id);
        for (const p of projectRows) {
          const slug = normalizeProjectUrlKey(p.name) ?? p.id;
          existingProjectSlugToIdForCostEvents.set(slug, p.id);
        }
        for (const [slug, id] of importedSlugToProjectId.entries()) {
          existingProjectSlugToIdForCostEvents.set(slug, id);
        }
      }
      if (needIssueLookup) {
        for (const r of resultIssues) {
          if (r.id) existingIssueSlugToId.set(r.slug, r.id);
        }
      }

      const pendingInserts: Record<string, unknown>[] = [];
      const pendingSlugs: string[] = [];
      let linkFailedAgentWarned = false;
      for (const event of manifestCostEvents) {
        const agentId = event.agentSlug
          ? (importedSlugToAgentId.get(event.agentSlug) ?? existingSlugToAgentId.get(event.agentSlug) ?? null)
          : null;
        if (!agentId) {
          if (!linkFailedAgentWarned) {
            warnings.push({
              kind: "link_failed",
              message: `Skipped cost event(s) with unresolvable agent slug "${event.agentSlug ?? "<null>"}" — agentId is required.`,
            });
            linkFailedAgentWarned = true;
          }
          continue;
        }
        const issueId = event.issueSlug ? (existingIssueSlugToId.get(event.issueSlug) ?? null) : null;
        const projectId = event.projectSlug
          ? (existingProjectSlugToIdForCostEvents.get(event.projectSlug) ?? null)
          : null;
        const occurredAt = new Date(event.occurredAt);
        pendingInserts.push({
          companyId: targetCompany.id,
          agentId,
          issueId,
          projectId,
          goalId: null,
          heartbeatRunId: null,
          billingCode: event.billingCode ?? null,
          provider: event.provider,
          biller: event.biller ?? "unknown",
          billingType: event.billingType ?? "unknown",
          model: event.model ?? "unknown",
          inputTokens: event.inputTokens,
          cachedInputTokens: event.cachedInputTokens ?? 0,
          outputTokens: event.outputTokens,
          costCents: event.costCents,
          occurredAt,
        });
        pendingSlugs.push(event.slug);
      }

      for (let i = 0; i < pendingInserts.length; i += COST_EVENT_INSERT_BATCH_SIZE) {
        const batch = pendingInserts.slice(i, i + COST_EVENT_INSERT_BATCH_SIZE);
        const batchSlugs = pendingSlugs.slice(i, i + COST_EVENT_INSERT_BATCH_SIZE);
        if (batch.length === 0) continue;
        const returned = await db.transaction(async (tx) => {
          const txDb = tx as unknown as Db;
          await lockBudgetAuthority(txDb, targetCompany.id);
          return (await txDb
            .insert(costEvents)
            .values(batch as never)
            .returning({ id: costEvents.id })) as { id: string }[];
        });
        for (let j = 0; j < returned.length && j < batchSlugs.length; j++) {
          const slug = batchSlugs[j];
          const newId = returned[j]?.id;
          if (typeof slug === "string" && typeof newId === "string") {
            costEventSlugToNewId.set(slug, newId);
          }
        }
      }
    }

    if (include.financeEvents === true && Array.isArray(sourceManifest.financeEvents)) {
      const manifestFinanceEvents = sourceManifest.financeEvents;

      const existingProjectSlugToIdForFinanceEvents = new Map<string, string>();
      const existingIssueSlugToIdForFinance = new Map<string, string>();
      const needProjectLookup = manifestFinanceEvents.some((e) => e.projectSlug);
      const needIssueLookup = manifestFinanceEvents.some((e) => e.issueSlug);
      if (needProjectLookup) {
        const projectRows = await projects.list(targetCompany.id);
        for (const p of projectRows) {
          const slug = normalizeProjectUrlKey(p.name) ?? p.id;
          existingProjectSlugToIdForFinanceEvents.set(slug, p.id);
        }
        for (const [slug, id] of importedSlugToProjectId.entries()) {
          existingProjectSlugToIdForFinanceEvents.set(slug, id);
        }
      }
      if (needIssueLookup) {
        for (const r of resultIssues) {
          if (r.id) existingIssueSlugToIdForFinance.set(r.slug, r.id);
        }
      }

      const pendingInserts: Record<string, unknown>[] = [];
      let linkFailedAgentWarned = false;
      let linkFailedIssueWarned = false;
      let linkFailedProjectWarned = false;
      let linkFailedCostEventWarned = false;
      for (const event of manifestFinanceEvents) {
        const agentId = event.agentSlug
          ? (importedSlugToAgentId.get(event.agentSlug) ?? existingSlugToAgentId.get(event.agentSlug) ?? null)
          : null;
        if (event.agentSlug && !agentId && !linkFailedAgentWarned) {
          warnings.push({
            kind: "link_failed",
            message: `Finance event(s) reference unresolvable agent slug "${event.agentSlug}" — agentId left null.`,
          });
          linkFailedAgentWarned = true;
        }
        const issueId = event.issueSlug
          ? (existingIssueSlugToIdForFinance.get(event.issueSlug) ?? null)
          : null;
        if (event.issueSlug && !issueId && !linkFailedIssueWarned) {
          warnings.push({
            kind: "link_failed",
            message: `Finance event(s) reference unresolvable issue slug "${event.issueSlug}" — issueId left null.`,
          });
          linkFailedIssueWarned = true;
        }
        const projectId = event.projectSlug
          ? (existingProjectSlugToIdForFinanceEvents.get(event.projectSlug) ?? null)
          : null;
        if (event.projectSlug && !projectId && !linkFailedProjectWarned) {
          warnings.push({
            kind: "link_failed",
            message: `Finance event(s) reference unresolvable project slug "${event.projectSlug}" — projectId left null.`,
          });
          linkFailedProjectWarned = true;
        }
        const costEventId = event.costEventSlug
          ? (costEventSlugToNewId.get(event.costEventSlug) ?? null)
          : null;
        if (event.costEventSlug && !costEventId && !linkFailedCostEventWarned) {
          warnings.push({
            kind: "link_failed",
            message: `Finance event(s) reference unresolvable cost event slug "${event.costEventSlug}" — costEventId left null.`,
          });
          linkFailedCostEventWarned = true;
        }
        const occurredAt = new Date(event.occurredAt);
        pendingInserts.push({
          companyId: targetCompany.id,
          agentId,
          issueId,
          projectId,
          goalId: null,
          heartbeatRunId: null,
          costEventId,
          billingCode: event.billingCode ?? null,
          description: event.description ?? null,
          eventKind: event.eventKind,
          direction: event.direction,
          biller: event.biller,
          provider: event.provider ?? null,
          executionAdapterType: event.executionAdapterType ?? null,
          pricingTier: event.pricingTier ?? null,
          region: event.region ?? null,
          model: event.model ?? null,
          quantity: event.quantity ?? null,
          unit: event.unit ?? null,
          amountCents: event.amountCents,
          currency: event.currency,
          estimated: event.estimated,
          externalInvoiceId: event.externalInvoiceId ?? null,
          metadataJson: event.metadata ?? null,
          occurredAt,
        });
      }

      for (let i = 0; i < pendingInserts.length; i += FINANCE_EVENT_INSERT_BATCH_SIZE) {
        const batch = pendingInserts.slice(i, i + FINANCE_EVENT_INSERT_BATCH_SIZE);
        if (batch.length === 0) continue;
        await db.insert(financeEvents).values(batch as never);
      }
    }

    if (include.quotaWindows === true && Array.isArray(sourceManifest.quotaWindows)) {
      const manifestQuotaWindows = sourceManifest.quotaWindows;
      let importedAny = false;
      for (const qw of manifestQuotaWindows) {
        const existing = (await db
          .select()
          .from(providerQuotaWindows)
          .where(
            and(
              eq(providerQuotaWindows.companyId, targetCompany.id),
              eq(providerQuotaWindows.provider, qw.provider),
              qw.model === null
                ? isNull(providerQuotaWindows.model)
                : eq(providerQuotaWindows.model, qw.model),
              eq(providerQuotaWindows.windowKind, qw.windowKind),
            ),
          )) as { id: string }[];
        const lastUpdatedAt = new Date(qw.lastUpdatedAt);
        const resetAt = qw.resetAt ? new Date(qw.resetAt) : null;
        if (existing.length > 0 && typeof existing[0]?.id === "string") {
          await db
            .update(providerQuotaWindows)
            .set({
              label: qw.label,
              limitValue: qw.limitValue,
              usedValue: qw.usedValue,
              usedPercent: qw.usedPercent,
              valueLabel: qw.valueLabel,
              resetAt,
              lastUpdatedAt,
            })
            .where(eq(providerQuotaWindows.id, existing[0]!.id));
        } else {
          await db.insert(providerQuotaWindows).values({
            companyId: targetCompany.id,
            provider: qw.provider,
            model: qw.model,
            windowKind: qw.windowKind,
            label: qw.label,
            limitValue: qw.limitValue,
            usedValue: qw.usedValue,
            usedPercent: qw.usedPercent,
            valueLabel: qw.valueLabel,
            resetAt,
            lastUpdatedAt,
          } as never);
        }
        importedAny = true;
      }
      if (importedAny) {
        warnings.push({
          kind: "deprecated_field",
          section: "quotaWindows",
          message: "Quota windows imported as point-in-time snapshots; refresh via adapter poll for current values.",
        });
      }
    }

    if (include.workflowTemplates === true && Array.isArray(sourceManifest.workflowTemplates)) {
      const manifestWorkflowTemplates = sourceManifest.workflowTemplates;
      const existingRows = (await db
        .select()
        .from(workflowTemplates)
        .where(eq(workflowTemplates.companyId, targetCompany.id))) as Record<string, unknown>[];
      const existingBySlug = new Map<string, Record<string, unknown>>();
      const usedSlugs = new Set<string>();
      for (const row of existingRows) {
        const name = typeof row.name === "string" ? row.name : "";
        const slug = synthesizeWorkflowTemplateSlug(name);
        existingBySlug.set(slug, row);
        usedSlugs.add(slug);
      }

      for (const tpl of manifestWorkflowTemplates) {
        const bundleSlug = getWorkflowTemplateManifestSlug(tpl);
        if (
          plan.collisionStrategy === "skip" &&
          !plan.mutableWorkflowTemplateSlugs.has(bundleSlug)
        ) {
          continue;
        }
        const collision = existingBySlug.get(bundleSlug);

        if (collision) {
          if (plan.collisionStrategy === "skip") {
            continue;
          }
          if (plan.collisionStrategy === "replace") {
            const existingId = typeof collision.id === "string" ? collision.id : null;
            const authorizedTemplateIds = plan.replaceWorkflowTemplateIdsBySlug.get(bundleSlug);
            if (!existingId || !authorizedTemplateIds?.has(existingId)) {
              warnings.push({
                kind: "skipped_update",
                section: "workflowTemplates",
                message: `Skipped workflow template "${tpl.name}" because the matching template changed after import authorization. Retry the import to replace it.`,
              });
              continue;
            }
            await db
              .update(workflowTemplates)
              .set({
                name: tpl.name,
                description: tpl.description ?? null,
                workspaceMode: tpl.workspaceMode,
                ...(tpl.agentCompletionPolicyOverride !== undefined
                  ? { agentCompletionPolicyOverride: tpl.agentCompletionPolicyOverride }
                  : {}),
                steps: tpl.steps as unknown,
                dependencies: tpl.dependencies as unknown,
                updatedAt: new Date(),
              })
              .where(and(
                eq(workflowTemplates.id, existingId),
                eq(workflowTemplates.companyId, targetCompany.id),
              ));
            continue;
          }
          // rename: derive a unique name + slug
          let renameIdx = 2;
          let candidateName = `${tpl.name} ${renameIdx}`;
          let candidateSlug = synthesizeWorkflowTemplateSlug(candidateName);
          while (usedSlugs.has(candidateSlug)) {
            renameIdx += 1;
            candidateName = `${tpl.name} ${renameIdx}`;
            candidateSlug = synthesizeWorkflowTemplateSlug(candidateName);
          }
          usedSlugs.add(candidateSlug);
          await db.insert(workflowTemplates).values({
            companyId: targetCompany.id,
            name: candidateName,
            description: tpl.description ?? null,
            workspaceMode: tpl.workspaceMode,
            agentCompletionPolicyOverride: tpl.agentCompletionPolicyOverride ?? null,
            steps: tpl.steps as unknown,
            dependencies: tpl.dependencies as unknown,
            instantiationCount: 0,
            lastInstantiatedAt: null,
            createdBy: actorUserId ?? "importer",
          } as never);
          continue;
        }

        usedSlugs.add(bundleSlug);
        await db.insert(workflowTemplates).values({
          companyId: targetCompany.id,
          name: tpl.name,
          description: tpl.description ?? null,
          workspaceMode: tpl.workspaceMode,
          agentCompletionPolicyOverride: tpl.agentCompletionPolicyOverride ?? null,
          steps: tpl.steps as unknown,
          dependencies: tpl.dependencies as unknown,
          instantiationCount: 0,
          lastInstantiatedAt: null,
          createdBy: actorUserId ?? "importer",
        } as never);
      }
    }

    const envSecretRequirements: CompanyPortabilityManifest["requiredSecrets"] = [];
    if (manifestEnvInputs.length > 0) {
      for (const envInput of manifestEnvInputs) {
        if (envInput.portability === "system_dependent") {
          warnings.push({
            kind: "deprecated_field",
            message: `Env input ${envInput.key}${envInput.agentSlug ? ` for agent ${envInput.agentSlug}` : ""} is system-dependent and may need manual adjustment after import.`,
          });
        }
        const slug = envInput.agentSlug;
        if (slug && !importedSlugToAgentId.has(slug) && !existingSlugToAgentId.has(slug)) {
          warnings.push({
            kind: "link_failed",
            message: `Env input ${envInput.key} references unresolved agent slug "${slug}" — skipped.`,
          });
          continue;
        }
        if (envInput.kind === "secret") {
          envSecretRequirements.push({
            key: envInput.key,
            description: envInput.description ?? `Provide ${envInput.key}${slug ? ` for agent ${slug}` : ""}`,
            agentSlug: slug,
            providerHint: null,
          });
        }
      }
    }

    const mergedRequiredSecrets = dedupeRequiredSecrets([
      ...(sourceManifest.requiredSecrets ?? []),
      ...envSecretRequirements,
    ]);

    // W6 human-at-top invariant (safety net): re-parent any org agent that still
    // landed rootless up to the founder. A founder is guaranteed here — either
    // seeded by the new_company branch (ensureRealOperator) or already present on
    // the existing company (route-gated founder/team_lead + getFounderUserId).
    if (include.agents) {
      await agents.backfillHumanAtTop(targetCompany.id);
    }

    if (
      input.target.mode === "existing_company" &&
      (deferredCompanyCompletionPolicyPatch || deferredProjectCompletionPolicyPatches.length > 0)
    ) {
      await db.transaction(async (tx) => {
        if (
          deferredCompanyCompletionPolicyPatch &&
          Object.keys(deferredCompanyCompletionPolicyPatch).length > 0
        ) {
          await tx
            .update(companiesTable)
            .set({ ...deferredCompanyCompletionPolicyPatch, updatedAt: new Date() })
            .where(eq(companiesTable.id, targetCompany!.id));
        }
        for (const patch of deferredProjectCompletionPolicyPatches) {
          await tx
            .update(projectsTable)
            .set({ agentCompletionPolicyDefault: patch.policy, updatedAt: new Date() })
            .where(and(eq(projectsTable.id, patch.id), eq(projectsTable.companyId, targetCompany!.id)));
        }
      });
    }

    return {
      company: {
        id: targetCompany.id,
        name: targetCompany.name,
        action: companyAction,
      },
      agents: resultAgents,
      projects: resultProjects,
      issues: resultIssues,
      skills: resultSkills,
      routines: resultRoutines,
      requiredSecrets: mergedRequiredSecrets,
      warnings,
    };
  }

  return {
    exportBundle,
    previewExport,
    previewImport,
    importBundle,
  };
}
