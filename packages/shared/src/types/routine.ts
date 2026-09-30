import type { AgentCompletionPolicy, RoutineStatus, RoutineConcurrencyPolicy, RoutineCatchUpPolicy, RoutineTriggerKind, RoutineTriggerSigningMode, RoutineRunStatus, RoutineRunSource, RoutineVariableType } from "../constants.js";

export type RoutineVariableDefaultValue = string | number | boolean | null;

export interface RoutineVariable {
  name: string;
  label: string | null;
  type: RoutineVariableType;
  defaultValue: RoutineVariableDefaultValue;
  required: boolean;
  options: string[];
}

export interface RoutineSnapshot {
  title: string;
  description: string | null;
  assigneeAgentId: string | null;
  priority: string;
  status: string;
  concurrencyPolicy: string;
  catchUpPolicy: string;
  variables: RoutineVariable[];
  projectId: string | null;
  goalId: string | null;
  parentIssueId: string | null;
  agentCompletionPolicyOverride?: AgentCompletionPolicy | null;
}

export interface Routine {
  id: string;
  companyId: string;
  projectId: string | null;
  goalId: string | null;
  parentIssueId: string | null;
  title: string;
  description: string | null;
  assigneeAgentId: string | null;
  priority: string;
  status: RoutineStatus;
  concurrencyPolicy: RoutineConcurrencyPolicy;
  catchUpPolicy: RoutineCatchUpPolicy;
  variables: RoutineVariable[];
  agentCompletionPolicyOverride?: AgentCompletionPolicy | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  lastTriggeredAt: string | null;
  lastEnqueuedAt: string | null;
  createdAt: string;
  updatedAt: string;
  latestRevisionId: string | null;
}

export interface RoutineTrigger {
  id: string;
  companyId: string;
  routineId: string;
  kind: RoutineTriggerKind;
  label: string | null;
  enabled: boolean;
  cronExpression: string | null;
  timezone: string | null;
  nextRunAt: string | null;
  lastFiredAt: string | null;
  publicId: string;
  secretId: string | null;
  signingMode: RoutineTriggerSigningMode | null;
  replayWindowSec: number | null;
  lastRotatedAt: string | null;
  lastResult: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoutineRun {
  id: string;
  companyId: string;
  routineId: string;
  triggerId: string | null;
  source: RoutineRunSource;
  status: RoutineRunStatus;
  triggeredAt: string;
  idempotencyKey: string | null;
  triggerPayload: unknown | null;
  linkedIssueId: string | null;
  coalescedIntoRunId: string | null;
  failureReason: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoutineTriggerSecretMaterial {
  webhookUrl: string;
  webhookSecret: string;
}

export interface RoutineDetail extends Routine {
  project: { id: string; name: string } | null;
  assignee: { id: string; name: string; urlKey: string; role: string } | null;
  parentIssue: { id: string; title: string; identifier: string } | null;
  triggers: RoutineTrigger[];
  recentRuns: RoutineRunSummary[];
  activeIssue: { id: string; title: string; identifier: string; status: string } | null;
}

export interface RoutineRunSummary extends RoutineRun {
  linkedIssue: { id: string; title: string; identifier: string; status: string } | null;
  trigger: { id: string; kind: RoutineTriggerKind; label: string | null } | null;
}

export interface RoutineRevision {
  id: string;
  companyId: string;
  routineId: string;
  snapshot: RoutineSnapshot;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: string;
}

export interface RoutineRevisionListItem extends RoutineRevision {
  author: { type: "agent"; name: string; urlKey: string } | { type: "user"; userId: string } | null;
}

export interface RoutineListItem extends Routine {
  triggers: Pick<RoutineTrigger, "id" | "kind" | "label" | "enabled" | "cronExpression" | "timezone" | "nextRunAt">[];
  lastRun: RoutineRun | null;
  activeIssue: { id: string; title: string; identifier: string; status: string } | null;
}
