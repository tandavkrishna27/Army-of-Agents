export interface WorkQuestionCapabilityContext {
  actorKind: "user" | "agent" | "system";
  sameCompany: boolean;
  companyAccess: boolean;
  instanceAdmin: boolean;
  founder: boolean;
  currentRecipient: boolean;
  taskReadable: boolean;
  taskResponsible: boolean;
  taskReviewer: boolean;
  scopedLeadForTask: boolean;
  reassignTargetInLeadScope: boolean;
  agentIsOrg: boolean;
  agentHasActiveRun: boolean;
  taskIsNonterminal: boolean;
  taskAssignedToActorAgent: boolean;
  checkoutOwnedByRun: boolean;
  producerOwnsQuestion: boolean;
  workIsActive: boolean;
}

export function resolveWorkQuestionCapabilities(
  context: WorkQuestionCapabilityContext,
): WorkQuestionCapabilities {
  const privilegedUser = context.actorKind === "user" && (context.instanceAdmin || context.founder);
  const authorizedCompanyUser = context.actorKind === "user"
    && (context.companyAccess || context.instanceAdmin);
  const read = context.sameCompany && authorizedCompanyUser && (
    context.instanceAdmin || context.taskReadable || context.currentRecipient
  );

  return {
    create: context.sameCompany
      && context.actorKind === "agent"
      && context.agentIsOrg
      && context.agentHasActiveRun
      && context.taskIsNonterminal
      && context.taskAssignedToActorAgent
      && context.checkoutOwnedByRun,
    read,
    answer: read && context.currentRecipient,
    reassign: read && (
      context.currentRecipient
      || privilegedUser
      || (context.scopedLeadForTask && context.reassignTargetInLeadScope)
    ),
    takeOver: read && (
      privilegedUser
      || context.taskResponsible
      || context.taskReviewer
      || context.scopedLeadForTask
    ),
    retryContinuation: read && (
      privilegedUser || context.taskResponsible || context.taskReviewer
    ),
    cancel: context.sameCompany && (
      privilegedUser
      || (context.actorKind === "system" && context.producerOwnsQuestion && context.workIsActive)
    ),
  };
}

export interface WorkQuestionSourceCompanies {
  issue?: string | null;
  askingAgent?: string | null;
  workspace?: string | null;
  discussion?: string | null;
  discussionEntry?: string | null;
  commanderConversation?: string | null;
  recipientMembership?: string | null;
}

export function workQuestionSourcesMatchCompany(
  companyId: string,
  sources: WorkQuestionSourceCompanies,
): boolean {
  return Object.values(sources).every((sourceCompanyId) => (
    sourceCompanyId == null || sourceCompanyId === companyId
  ));
}
import type { WorkQuestionCapabilities } from "@armyofagents/shared";
