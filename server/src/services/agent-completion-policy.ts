import { and, eq } from "drizzle-orm";
import { companies, projects, type Db } from "@armyofagents/db";
import {
  AGENT_COMPLETION_POLICIES,
  type AgentCompletionPolicy,
  type AgentCompletionPolicySource,
} from "@armyofagents/shared";
import { notFound, unprocessable } from "../errors.js";

export type CompletionPolicyCreatorSource = "routine" | "workflow_template";

export interface CompletionPolicySettings {
  companyId: string;
  companyDefault: AgentCompletionPolicy;
  reviewGuardrail: boolean;
  project?: {
    id: string;
    type: string;
    policyDefault: AgentCompletionPolicy | null;
  } | null;
  taskOverride?: AgentCompletionPolicy | null;
  creatorOverride?: AgentCompletionPolicy | null;
  creatorSource?: CompletionPolicyCreatorSource | null;
  creatorSourceId?: string | null;
}

export interface ResolvedAgentCompletionPolicy {
  policy: AgentCompletionPolicy;
  source: AgentCompletionPolicySource;
  sourceId: string | null;
  guardrailApplied: boolean;
  resolvedAt: Date;
}

function assertPolicy(value: string | null | undefined, subject: string): asserts value is AgentCompletionPolicy | null | undefined {
  if (value != null && !AGENT_COMPLETION_POLICIES.includes(value as AgentCompletionPolicy)) {
    throw unprocessable(`Invalid ${subject}`);
  }
}

export function resolveAgentCompletionPolicyFromSettings(
  settings: CompletionPolicySettings,
  resolvedAt = new Date(),
): ResolvedAgentCompletionPolicy {
  assertPolicy(settings.companyDefault, "company completion policy");
  assertPolicy(settings.project?.policyDefault, "project completion policy");
  assertPolicy(settings.creatorOverride, "creator completion policy override");
  assertPolicy(settings.taskOverride, "task completion policy override");

  let policy: AgentCompletionPolicy = settings.companyDefault;
  let source: AgentCompletionPolicySource = "company";
  let sourceId: string | null = settings.companyId;

  if (settings.project?.policyDefault) {
    policy = settings.project.policyDefault;
    source = settings.project.type === "project" ? "project" : "department";
    sourceId = settings.project.id;
  }
  if (settings.creatorOverride) {
    if (!settings.creatorSource || !settings.creatorSourceId) {
      throw unprocessable("Creator completion policy override requires source provenance");
    }
    policy = settings.creatorOverride;
    source = settings.creatorSource;
    sourceId = settings.creatorSourceId;
  }
  if (settings.taskOverride) {
    policy = settings.taskOverride;
    source = "task";
    sourceId = null;
  }

  const guardrailApplied = settings.reviewGuardrail && policy === "agent_can_complete";
  if (guardrailApplied) {
    policy = "review_required";
    source = "company";
    sourceId = settings.companyId;
  }

  return { policy, source, sourceId, guardrailApplied, resolvedAt };
}

export async function resolveAgentCompletionPolicy(
  db: Db,
  input: {
    companyId: string;
    projectId?: string | null;
    taskOverride?: AgentCompletionPolicy | null;
    creatorOverride?: AgentCompletionPolicy | null;
    creatorSource?: CompletionPolicyCreatorSource | null;
    creatorSourceId?: string | null;
    lockSources?: boolean;
  },
): Promise<ResolvedAgentCompletionPolicy> {
  const companyQuery = db
    .select({
      policyDefault: companies.agentCompletionPolicyDefault,
      reviewGuardrail: companies.agentCompletionReviewGuardrail,
    })
    .from(companies)
    .where(eq(companies.id, input.companyId));
  const company = await (input.lockSources ? companyQuery.for("no key update") : companyQuery)
    .then((rows) => rows[0] ?? null);
  if (!company) throw notFound("Company not found");

  const project = input.projectId
    ? await (() => {
      const projectQuery = db
        .select({
          id: projects.id,
          type: projects.type,
          policyDefault: projects.agentCompletionPolicyDefault,
        })
        .from(projects)
        .where(and(eq(projects.id, input.projectId!), eq(projects.companyId, input.companyId)));
      return input.lockSources ? projectQuery.for("share") : projectQuery;
    })().then((rows) => rows[0] ?? null)
    : null;
  if (input.projectId && !project) throw notFound("Project not found");

  return resolveAgentCompletionPolicyFromSettings({
    companyId: input.companyId,
    companyDefault: company.policyDefault as AgentCompletionPolicy,
    reviewGuardrail: company.reviewGuardrail,
    project: project
      ? {
        id: project.id,
        type: project.type,
        policyDefault: project.policyDefault as AgentCompletionPolicy | null,
      }
      : null,
    taskOverride: input.taskOverride,
    creatorOverride: input.creatorOverride,
    creatorSource: input.creatorSource,
    creatorSourceId: input.creatorSourceId,
  });
}
