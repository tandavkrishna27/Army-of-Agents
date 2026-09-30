import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  discussionEntries,
  discussions,
  executionWorkspaces,
  heartbeatRuns,
  internalAgentConversations,
  internalAgentRuns,
  issues,
  projects,
  userRoles,
  workQuestionContinuationRequests,
  workQuestions,
  type Db,
} from "@armyofagents/db";
import {
  workQuestionContinuationIdempotencyKey,
  type AnswerWorkQuestionInput,
  type CreateWorkQuestionInput,
  type WorkQuestionCapabilities,
  type WorkQuestionContinuationEnvelope,
  type WorkQuestionStatus,
} from "@armyofagents/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { hubItemsService } from "./hub-items.js";
import {
  resolveWorkQuestionCapabilities,
  workQuestionSourcesMatchCompany,
} from "./work-question-capabilities.js";

const TERMINAL_TASK_STATUSES = ["done", "cancelled"] as const;
const LIVE_RELAY_GRACE_MS = 15_000;

export class WorkQuestionCancelledError extends Error {
  constructor() {
    super("Work question was cancelled");
    this.name = "WorkQuestionCancelledError";
  }
}

export interface WorkQuestionUserActor {
  userId: string;
  instanceAdmin?: boolean;
}

export interface WorkQuestionListFilters {
  status?: WorkQuestionStatus;
  issueId?: string;
  sourceDiscussionId?: string;
  executionWorkspaceId?: string;
  sourceCommanderConversationId?: string;
  currentRecipientUserId?: string;
  limit?: number;
}

type QuestionRow = typeof workQuestions.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function workQuestionPayloadFingerprint(input: CreateWorkQuestionInput): string {
  const semanticPayload = {
    issueId: input.issueId,
    askingAgentId: input.askingAgentId,
    originatingRunKind: input.originatingRunKind,
    originatingRunId: input.originatingRunId,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    sourceDiscussionId: input.sourceDiscussionId ?? null,
    sourceDiscussionEntryId: input.sourceDiscussionEntryId ?? null,
    sourceCommanderConversationId: input.sourceCommanderConversationId ?? null,
    primaryRecipientUserId: input.primaryRecipientUserId ?? null,
    title: input.title,
    question: input.question,
    context: input.context ?? null,
    options: input.options ?? null,
    blocking: input.blocking,
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(semanticPayload))).digest("hex");
}

function continuationNeeded(question: Pick<QuestionRow, "originatingRunKind" | "originatingRunId" | "askingAgentId">) {
  return Boolean(question.originatingRunKind && question.originatingRunId && question.askingAgentId);
}

export function workQuestionService(db: Db) {
  async function activeMemberships(companyId: string, userId: string, executor: Db = db) {
    return executor
      .select({ id: companyMemberships.id, parentType: companyMemberships.parentType, parentId: companyMemberships.parentId })
      .from(companyMemberships)
      .where(and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
        eq(companyMemberships.status, "active"),
      ));
  }

  async function activeMembership(companyId: string, userId: string, executor: Db = db) {
    return activeMemberships(companyId, userId, executor).then((rows) => rows[0] ?? null);
  }

  async function founderUserId(companyId: string, executor: Db = db): Promise<string | null> {
    const rows = await executor
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .innerJoin(companyMemberships, and(
        eq(companyMemberships.companyId, userRoles.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userRoles.userId),
        eq(companyMemberships.status, "active"),
      ))
      .where(and(eq(userRoles.companyId, companyId), eq(userRoles.role, "founder")));
    return [...new Set(rows.map((row) => row.userId))][0] ?? null;
  }

  async function resolveSlaPolicy(companyId: string, projectId: string | null, executor: Db = db) {
    const [company, project] = await Promise.all([
      executor.select({ hours: companies.humanQuestionSlaHours })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null),
      projectId
        ? executor.select({ id: projects.id, companyId: projects.companyId, hours: projects.humanQuestionSlaHours })
          .from(projects)
          .where(eq(projects.id, projectId))
          .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
    ]);
    if (!company) throw notFound("Company not found");
    if (project && project.companyId !== companyId) {
      throw unprocessable("Question project must belong to the same company");
    }
    if (project?.hours) {
      return { hours: project.hours, source: "project" as const, sourceId: project.id };
    }
    return { hours: company.hours, source: "company" as const, sourceId: companyId };
  }

  async function escalationRecipientUserId(
    companyId: string,
    projectId: string | null,
    currentRecipientUserId: string,
    executor: Db = db,
  ): Promise<string | null> {
    const scopedLeadConditions = [
      eq(userRoles.companyId, companyId),
      eq(userRoles.role, "team_lead"),
    ];
    const leadRows = await executor
      .select({ userId: userRoles.userId, projectId: userRoles.projectId })
      .from(userRoles)
      .innerJoin(companyMemberships, and(
        eq(companyMemberships.companyId, userRoles.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userRoles.userId),
        eq(companyMemberships.status, "active"),
      ))
      .where(and(...scopedLeadConditions));
    const scopedLead = leadRows.find((row) => row.projectId === projectId && row.userId !== currentRecipientUserId)
      ?? leadRows.find((row) => row.projectId == null && row.userId !== currentRecipientUserId);
    if (scopedLead) return scopedLead.userId;
    const founder = await founderUserId(companyId, executor);
    return founder === currentRecipientUserId ? null : founder;
  }

  async function getQuestionAndIssue(companyId: string, questionId: string) {
    const question = await db
      .select()
      .from(workQuestions)
      .where(and(eq(workQuestions.companyId, companyId), eq(workQuestions.id, questionId)))
      .then((rows) => rows[0] ?? null);
    if (!question) throw notFound("Work question not found");
    const issue = question.issueId
      ? await db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.id, question.issueId)))
        .then((rows) => rows[0] ?? null)
      : null;
    return { question, issue };
  }

  async function capabilitiesForUser(input: {
    companyId: string;
    actor: WorkQuestionUserActor;
    question: QuestionRow;
    issue: IssueRow | null;
    reassignTargetUserId?: string;
  }): Promise<WorkQuestionCapabilities> {
    const [memberships, roles, targetMemberships] = await Promise.all([
      activeMemberships(input.companyId, input.actor.userId),
      db.select().from(userRoles).where(and(
        eq(userRoles.companyId, input.companyId),
        eq(userRoles.userId, input.actor.userId),
      )),
      input.reassignTargetUserId ? activeMemberships(input.companyId, input.reassignTargetUserId) : Promise.resolve([]),
    ]);
    const founder = roles.some((role) => role.role === "founder");
    const companyWideLead = roles.some((role) => role.role === "team_lead" && role.projectId == null);
    const scopedLeadForTask = roles.some((role) => role.role === "team_lead" && (
      role.projectId == null || role.projectId === input.issue?.projectId
    ));
    const targetInTaskScope = companyWideLead || targetMemberships.some((membership) => (
      input.issue?.projectId == null
      || membership.parentId == null
      || membership.parentId === input.issue.projectId
    ));
    return resolveWorkQuestionCapabilities({
      actorKind: "user",
      sameCompany: input.question.companyId === input.companyId,
      companyAccess: memberships.length > 0,
      instanceAdmin: input.actor.instanceAdmin === true,
      founder,
      currentRecipient: input.question.currentRecipientUserId === input.actor.userId,
      taskReadable: Boolean(input.issue),
      taskResponsible: input.issue?.responsibleUserId === input.actor.userId,
      taskReviewer: input.issue?.reviewerUserId === input.actor.userId,
      scopedLeadForTask,
      reassignTargetInLeadScope: scopedLeadForTask && targetInTaskScope,
      agentIsOrg: false,
      agentHasActiveRun: false,
      taskIsNonterminal: false,
      taskAssignedToActorAgent: false,
      checkoutOwnedByRun: false,
      producerOwnsQuestion: false,
      workIsActive: false,
    });
  }

  async function assertCapability(
    capability: keyof WorkQuestionCapabilities,
    companyId: string,
    actor: WorkQuestionUserActor,
    question: QuestionRow,
    issue: IssueRow | null,
    reassignTargetUserId?: string,
  ) {
    const capabilities = await capabilitiesForUser({
      companyId,
      actor,
      question,
      issue,
      reassignTargetUserId,
    });
    if (!capabilities[capability]) throw forbidden(`Not authorized to ${capability} this work question`);
  }

  async function listVisibleForUser(
    companyId: string,
    actor: WorkQuestionUserActor,
    filters: WorkQuestionListFilters,
  ) {
    const [memberships, roles] = await Promise.all([
      activeMemberships(companyId, actor.userId),
      db.select().from(userRoles).where(and(
        eq(userRoles.companyId, companyId),
        eq(userRoles.userId, actor.userId),
      )),
    ]);
    if (memberships.length === 0 && !actor.instanceAdmin) throw forbidden("Company access required");

    const conditions = [eq(workQuestions.companyId, companyId)];
    if (filters.status) conditions.push(eq(workQuestions.status, filters.status));
    if (filters.issueId) conditions.push(eq(workQuestions.issueId, filters.issueId));
    if (filters.sourceDiscussionId) conditions.push(eq(workQuestions.sourceDiscussionId, filters.sourceDiscussionId));
    if (filters.executionWorkspaceId) conditions.push(eq(workQuestions.executionWorkspaceId, filters.executionWorkspaceId));
    if (filters.sourceCommanderConversationId) conditions.push(eq(workQuestions.sourceCommanderConversationId, filters.sourceCommanderConversationId));
    if (filters.currentRecipientUserId) conditions.push(eq(workQuestions.currentRecipientUserId, filters.currentRecipientUserId));

    const rows = await db
      .select({ question: workQuestions, issue: issues })
      .from(workQuestions)
      .leftJoin(issues, and(
        eq(issues.companyId, workQuestions.companyId),
        eq(issues.id, workQuestions.issueId),
      ))
      .where(and(...conditions))
      .orderBy(desc(workQuestions.createdAt))
      .limit(Math.min(filters.limit ?? 100, 200));

    const founder = roles.some((role) => role.role === "founder");
    const companyWideLead = roles.some((role) => role.role === "team_lead" && role.projectId == null);
    return rows.flatMap(({ question, issue }) => {
      const scopedLeadForTask = roles.some((role) => role.role === "team_lead" && (
        role.projectId == null || role.projectId === issue?.projectId
      ));
      const capabilities = resolveWorkQuestionCapabilities({
        actorKind: "user",
        sameCompany: question.companyId === companyId,
        companyAccess: memberships.length > 0,
        instanceAdmin: actor.instanceAdmin === true,
        founder,
        currentRecipient: question.currentRecipientUserId === actor.userId,
        taskReadable: Boolean(issue),
        taskResponsible: issue?.responsibleUserId === actor.userId,
        taskReviewer: issue?.reviewerUserId === actor.userId,
        scopedLeadForTask,
        reassignTargetInLeadScope: companyWideLead,
        agentIsOrg: false,
        agentHasActiveRun: false,
        taskIsNonterminal: false,
        taskAssignedToActorAgent: false,
        checkoutOwnedByRun: false,
        producerOwnsQuestion: false,
        workIsActive: false,
      });
      return capabilities.read ? [{ question, capabilities }] : [];
    });
  }

  async function validateCreateSources(executor: Db, companyId: string, input: CreateWorkQuestionInput, lock = false) {
    if (lock) {
      // Serialize question creation with task checkout/completion and run
      // termination. A second validation without these locks still leaves a
      // window where cancellation can commit before the question insert.
      await executor.execute(sql`select id from issues where id = ${input.issueId} and company_id = ${companyId} for update`);
      if (input.originatingRunKind === "heartbeat") {
        await executor.execute(sql`select id from heartbeat_runs where id = ${input.originatingRunId} and company_id = ${companyId} for update`);
      } else {
        await executor.execute(sql`select id from internal_agent_runs where id = ${input.originatingRunId} and company_id = ${companyId} for update`);
      }
    }

    const [issue, agent, heartbeatRun, internalAgentRun, workspace, discussion, discussionEntry, conversation] = await Promise.all([
      executor.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, companyId))).then((rows) => rows[0] ?? null),
      executor.select().from(agents).where(and(eq(agents.id, input.askingAgentId), eq(agents.companyId, companyId))).then((rows) => rows[0] ?? null),
      input.originatingRunKind === "heartbeat"
        ? executor.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.originatingRunId), eq(heartbeatRuns.companyId, companyId))).then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      input.originatingRunKind === "internal_agent"
        ? executor.select().from(internalAgentRuns).where(and(eq(internalAgentRuns.id, input.originatingRunId), eq(internalAgentRuns.companyId, companyId))).then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      input.executionWorkspaceId
        ? executor.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, input.executionWorkspaceId)).then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      input.sourceDiscussionId
        ? executor.select().from(discussions).where(eq(discussions.id, input.sourceDiscussionId)).then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      input.sourceDiscussionEntryId
        ? executor.select({ id: discussionEntries.id, discussionId: discussionEntries.discussionId, companyId: discussions.companyId })
          .from(discussionEntries)
          .innerJoin(discussions, eq(discussions.id, discussionEntries.discussionId))
          .where(eq(discussionEntries.id, input.sourceDiscussionEntryId))
          .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      input.sourceCommanderConversationId
        ? executor.select().from(internalAgentConversations).where(eq(internalAgentConversations.id, input.sourceCommanderConversationId)).then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
    ]);

    if (!issue || !agent) throw notFound("Task or asking agent not found");
    const run = input.originatingRunKind === "heartbeat" ? heartbeatRun : internalAgentRun;
    if (!run) throw notFound("Originating run not found");
    const sourcesMatch = workQuestionSourcesMatchCompany(companyId, {
      issue: issue.companyId,
      askingAgent: agent.companyId,
      workspace: workspace?.companyId,
      discussion: discussion?.companyId,
      discussionEntry: discussionEntry?.companyId,
      commanderConversation: conversation?.companyId,
    });
    if (!sourcesMatch || run.companyId !== companyId) throw unprocessable("Work question sources must belong to the same company");
    if (run.status !== "running" || run.agentId !== agent.id) throw conflict("Work question requires the asking agent's active run");
    if (input.originatingRunKind === "heartbeat") {
      if (agent.kind !== "org") throw forbidden("Heartbeat work questions require an organization agent");
    } else {
      if (agent.kind !== "aoa") throw forbidden("Internal-agent work questions require an AoA Crew agent");
      if (internalAgentRun?.relatedEntityType !== "task" || internalAgentRun.relatedEntityId !== issue.id) {
        throw conflict("Internal-agent work questions require a task-bound Crew run");
      }
    }
    if (TERMINAL_TASK_STATUSES.includes(issue.status as (typeof TERMINAL_TASK_STATUSES)[number])) {
      throw conflict("Cannot ask a work question for a terminal task");
    }
    if (issue.assigneeAgentId !== agent.id) throw forbidden("Asking agent must be assigned to the task");
    if (issue.checkoutRunId !== run.id && issue.executionRunId !== run.id) {
      throw conflict("Originating run does not own the task checkout");
    }
    if (workspace) {
      const belongsToTask = workspace.sourceIssueId === issue.id;
      const belongsToSourceDiscussion = Boolean(
        workspace.threadId
        && issue.sourceDiscussionId
        && workspace.threadId === issue.sourceDiscussionId,
      );
      if (!belongsToTask && !belongsToSourceDiscussion) {
        throw unprocessable("Workspace must belong to the task");
      }
    }
    if (discussionEntry && input.sourceDiscussionId && discussionEntry.discussionId !== input.sourceDiscussionId) {
      throw unprocessable("Discussion entry must belong to the source Discussion");
    }
    return { issue, agent };
  }

  async function enqueueContinuation(
    tx: Db,
    question: QuestionRow,
    answerVersion: number,
    continuationEnvelope: WorkQuestionContinuationEnvelope,
  ) {
    if (!continuationNeeded(question)) return;
    await tx.insert(workQuestionContinuationRequests).values({
      companyId: question.companyId,
      questionId: question.id,
      answerVersion,
      targetRunKind: question.originatingRunKind!,
      targetAgentId: question.askingAgentId,
      targetConversationId: question.originatingRunKind === "internal_agent"
        ? question.sourceCommanderConversationId
        : null,
      nextAttemptAt: new Date(Date.now() + LIVE_RELAY_GRACE_MS),
      continuationEnvelope,
      downstreamIdempotencyKey: workQuestionContinuationIdempotencyKey(question.id, answerVersion),
    }).onConflictDoNothing();
  }

  async function emitMirror(question: QuestionRow, issue: IssueRow | null, executor: Db = db) {
    return hubItemsService(executor).emit({
      companyId: question.companyId,
      semanticType: "work_question",
      sourceType: "work_question",
      sourceId: question.id,
      title: question.title,
      summary: question.question,
      relatedEntityType: "issue",
      relatedEntityId: question.issueId,
      scopeKey: issue?.projectId ?? null,
      priority: question.blocking ? "high" : "normal",
      ownerUserId: question.currentRecipientUserId,
      sourceActorType: "agent",
      sourceActorId: question.askingAgentId,
      sourcePermissionRevision: `${question.version}:${new Date(question.updatedAt).toISOString()}`,
      slaAt: question.dueAt,
      executor,
    });
  }

  return {
    async create(companyId: string, input: CreateWorkQuestionInput) {
      await validateCreateSources(db, companyId, input);
      const producerPayloadFingerprint = workQuestionPayloadFingerprint(input);
      const producerInvocationId = input.producerInvocationId
        ?? `semantic:${producerPayloadFingerprint}`;
      const createdAt = new Date();
      return db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        const { issue, agent } = await validateCreateSources(tx, companyId, input, true);
        const recipientUserId = input.primaryRecipientUserId
          ?? issue.responsibleUserId
          ?? issue.reviewerUserId
          ?? await founderUserId(companyId, tx);
        if (!recipientUserId || !(await activeMembership(companyId, recipientUserId, tx))) {
          throw unprocessable("Work question requires an active human recipient");
        }
        const [sla, escalationRecipient] = await Promise.all([
          resolveSlaPolicy(companyId, issue.projectId, tx),
          escalationRecipientUserId(companyId, issue.projectId, recipientUserId, tx),
        ]);
        const created = await tx.insert(workQuestions).values({
          companyId,
          issueId: issue.id,
          issueIdentifierSnapshot: issue.identifier,
          issueTitleSnapshot: issue.title,
          askingAgentId: agent.id,
          askingAgentNameSnapshot: agent.name,
          originatingRunKind: input.originatingRunKind,
          originatingRunId: input.originatingRunId,
          producerInvocationId,
          producerPayloadFingerprint,
          executionWorkspaceId: input.executionWorkspaceId ?? issue.executionWorkspaceId,
          sourceDiscussionId: input.sourceDiscussionId ?? issue.sourceDiscussionId,
          sourceDiscussionEntryId: input.sourceDiscussionEntryId,
          sourceCommanderConversationId: input.sourceCommanderConversationId,
          primaryRecipientUserId: recipientUserId,
          currentRecipientUserId: recipientUserId,
          title: input.title,
          question: input.question,
          context: input.context,
          options: input.options,
          blocking: input.blocking,
          slaDurationHours: sla.hours,
          slaSource: sla.source,
          slaSourceId: sla.sourceId,
          dueAt: new Date(createdAt.getTime() + sla.hours * 60 * 60 * 1000),
          escalationRecipientUserId: escalationRecipient,
          continuationStatus: "not_needed",
        }).onConflictDoNothing().returning().then((rows) => rows[0] ?? null);
        if (!created) {
          const invocationMatch = await tx.select().from(workQuestions).where(and(
            eq(workQuestions.companyId, companyId),
            eq(workQuestions.originatingRunKind, input.originatingRunKind),
            eq(workQuestions.originatingRunId, input.originatingRunId),
            eq(workQuestions.producerInvocationId, producerInvocationId),
          )).then((rows) => rows[0] ?? null);
          if (invocationMatch) {
            if (invocationMatch.producerPayloadFingerprint !== producerPayloadFingerprint) {
              throw conflict("Producer invocation was reused with different question content");
            }
            return invocationMatch;
          }
          const semanticMatch = await tx.select().from(workQuestions).where(and(
            eq(workQuestions.companyId, companyId),
            eq(workQuestions.originatingRunKind, input.originatingRunKind),
            eq(workQuestions.originatingRunId, input.originatingRunId),
            eq(workQuestions.producerPayloadFingerprint, producerPayloadFingerprint),
            eq(workQuestions.status, "open"),
          )).then((rows) => rows[0] ?? null);
          if (semanticMatch) return semanticMatch;
          throw conflict("Question creation lost its idempotency race");
        }
        await emitMirror(created, issue, tx);
        await tx.insert(activityLog).values({
          companyId,
          actorType: "agent",
          actorId: agent.id,
          agentId: agent.id,
          runId: input.originatingRunKind === "heartbeat" ? input.originatingRunId : null,
          action: "work_question.created",
          entityType: "work_question",
          entityId: created.id,
          details: {
            issueId: issue.id,
            recipientUserId,
            blocking: input.blocking,
            originatingRunKind: input.originatingRunKind,
            originatingRunId: input.originatingRunId,
          },
        });
        return created;
      });
    },

    async listForUser(companyId: string, actor: WorkQuestionUserActor, filters: WorkQuestionListFilters = {}) {
      return (await listVisibleForUser(companyId, actor, filters)).map((item) => item.question);
    },

    async listDetailsForUser(companyId: string, actor: WorkQuestionUserActor, filters: WorkQuestionListFilters = {}) {
      return listVisibleForUser(companyId, actor, filters);
    },

    async getForUser(companyId: string, questionId: string, actor: WorkQuestionUserActor) {
      const { question, issue } = await getQuestionAndIssue(companyId, questionId);
      await assertCapability("read", companyId, actor, question, issue);
      return question;
    },

    async getDetailForUser(companyId: string, questionId: string, actor: WorkQuestionUserActor) {
      const { question, issue } = await getQuestionAndIssue(companyId, questionId);
      const capabilities = await capabilitiesForUser({ companyId, actor, question, issue });
      if (!capabilities.read) throw forbidden("Not authorized to read this work question");
      return { question, capabilities };
    },

    async waitForAnswer(input: { companyId: string; questionId: string; timeoutMs: number }) {
      const deadline = Date.now() + input.timeoutMs;
      while (Date.now() < deadline) {
        const question = await db.select().from(workQuestions).where(and(
          eq(workQuestions.companyId, input.companyId),
          eq(workQuestions.id, input.questionId),
        )).then((rows) => rows[0] ?? null);
        if (!question) throw notFound("Work question not found");
        if (question.status === "answered") return question;
        if (question.status === "cancelled") throw new WorkQuestionCancelledError();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("Timed out waiting for work question answer");
    },

    async markRelayed(companyId: string, questionId: string, answerVersion: number) {
      return db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        const [updated] = await tx.update(workQuestions).set({
          continuationStatus: "dispatched",
          continuationRunKind: sql`${workQuestions.originatingRunKind}`,
          continuationRunId: sql`${workQuestions.originatingRunId}`,
          version: answerVersion + 1,
          updatedAt: new Date(),
        }).where(and(
          eq(workQuestions.companyId, companyId),
          eq(workQuestions.id, questionId),
          eq(workQuestions.status, "answered"),
          eq(workQuestions.continuationStatus, "pending"),
          eq(workQuestions.version, answerVersion),
        )).returning();
        if (!updated) {
          const existing = await tx.select().from(workQuestions).where(and(
            eq(workQuestions.companyId, companyId),
            eq(workQuestions.id, questionId),
          )).then((rows) => rows[0] ?? null);
          if (existing?.continuationStatus === "dispatched") return existing;
          throw conflict("Work question answer is no longer available for live relay");
        }
        await tx.update(workQuestionContinuationRequests).set({
          status: "cancelled",
          updatedAt: new Date(),
        }).where(and(
          eq(workQuestionContinuationRequests.companyId, companyId),
          eq(workQuestionContinuationRequests.questionId, questionId),
          eq(workQuestionContinuationRequests.answerVersion, answerVersion),
          inArray(workQuestionContinuationRequests.status, ["pending", "claimed"]),
        ));
        await tx.insert(activityLog).values({
          companyId,
          actorType: "system",
          actorId: "work-question-live-relay",
          action: "work_question.relayed",
          entityType: "work_question",
          entityId: questionId,
          details: {
            answerVersion,
            continuationRunKind: updated.continuationRunKind,
            continuationRunId: updated.continuationRunId,
          },
        });
        return updated;
      });
    },

    async answer(companyId: string, questionId: string, actor: WorkQuestionUserActor, input: AnswerWorkQuestionInput) {
      const { question, issue } = await getQuestionAndIssue(companyId, questionId);
      if (question.status === "answered" && question.answerIdempotencyKey === input.idempotencyKey) return question;
      await assertCapability("answer", companyId, actor, question, issue);
      const answered = await db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        const liveIssue = question.issueId
          ? await tx.select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            description: issues.description,
            status: issues.status,
            acceptanceCriteria: issues.acceptanceCriteria,
          }).from(issues).where(and(
            eq(issues.companyId, companyId),
            eq(issues.id, question.issueId),
          )).for("update").then((rows) => rows[0] ?? null)
          : null;
        if (!liveIssue || TERMINAL_TASK_STATUSES.includes(liveIssue.status as (typeof TERMINAL_TASK_STATUSES)[number])) {
          throw conflict("The linked task is no longer active");
        }
        const nextVersion = input.expectedVersion + 1;
        const [updated] = await tx.update(workQuestions).set({
          status: "answered",
          answer: input.answer,
          answerIdempotencyKey: input.idempotencyKey,
          answeredByUserId: actor.userId,
          answeredAt: new Date(),
          continuationStatus: continuationNeeded(question) ? "pending" : "not_needed",
          version: nextVersion,
          updatedAt: new Date(),
        }).where(and(
          eq(workQuestions.companyId, companyId),
          eq(workQuestions.id, questionId),
          eq(workQuestions.status, "open"),
          eq(workQuestions.currentRecipientUserId, actor.userId),
          eq(workQuestions.version, input.expectedVersion),
        )).returning();
        if (!updated) {
          const existing = await tx.select().from(workQuestions).where(and(
            eq(workQuestions.companyId, companyId),
            eq(workQuestions.id, questionId),
          )).then((rows) => rows[0] ?? null);
          if (existing?.status === "answered" && existing.answerIdempotencyKey === input.idempotencyKey) return existing;
          throw conflict("Work question changed or was already answered");
        }
        const originatingRun = updated.originatingRunKind === "heartbeat" && updated.originatingRunId
          ? await tx.select({
            sessionIdBefore: heartbeatRuns.sessionIdBefore,
            sessionIdAfter: heartbeatRuns.sessionIdAfter,
          }).from(heartbeatRuns).where(and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.id, updated.originatingRunId),
          )).then((rows) => rows[0] ?? null)
          : null;
        if (
          continuationNeeded(updated)
          && updated.originatingRunKind
          && updated.originatingRunId
          && updated.answer
          && updated.answeredAt
        ) {
          const continuationEnvelope: WorkQuestionContinuationEnvelope = {
            version: 1,
            task: {
              id: liveIssue.id,
              identifier: liveIssue.identifier,
              title: liveIssue.title,
              description: liveIssue.description,
              statusAtAnswer: liveIssue.status,
              acceptanceCriteria: liveIssue.acceptanceCriteria,
            },
            question: {
              id: updated.id,
              title: updated.title,
              text: updated.question,
              context: updated.context,
              options: updated.options,
            },
            answer: {
              value: updated.answer,
              version: nextVersion,
              responderUserId: actor.userId,
              answeredAt: updated.answeredAt.toISOString(),
            },
            provenance: {
              originatingRunKind: updated.originatingRunKind as WorkQuestionContinuationEnvelope["provenance"]["originatingRunKind"],
              originatingRunId: updated.originatingRunId,
              priorProviderSessionId: originatingRun?.sessionIdAfter ?? originatingRun?.sessionIdBefore ?? null,
              executionWorkspaceId: updated.executionWorkspaceId,
              sourceDiscussionId: updated.sourceDiscussionId,
              sourceDiscussionEntryId: updated.sourceDiscussionEntryId,
              sourceCommanderConversationId: updated.sourceCommanderConversationId,
            },
            remainingWorkInstructions:
              "Apply this answer to the current task, resume only the remaining work, and do not repeat completed steps.",
          };
          await enqueueContinuation(tx, updated, nextVersion, continuationEnvelope);
        }
        await hubItemsService(tx).reconcile(companyId, {
          sourceType: "work_question",
          sourceId: questionId,
        });
        await tx.insert(activityLog).values({
          companyId,
          actorType: "user",
          actorId: actor.userId,
          action: "work_question.answered",
          entityType: "work_question",
          entityId: questionId,
          details: {
            version: updated.version,
            continuationStatus: updated.continuationStatus,
          },
        });
        return updated;
      });
      return answered;
    },

    async reassign(companyId: string, questionId: string, actor: WorkQuestionUserActor, userId: string, expectedVersion: number) {
      const { question, issue } = await getQuestionAndIssue(companyId, questionId);
      if (question.status !== "open") throw conflict("Only open work questions can be reassigned");
      await assertCapability("reassign", companyId, actor, question, issue, userId);
      if (!(await activeMembership(companyId, userId))) throw notFound("Recipient not found");
      return db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        const [updated] = await tx.update(workQuestions).set({
          currentRecipientUserId: userId,
          version: expectedVersion + 1,
          updatedAt: new Date(),
        }).where(and(
          eq(workQuestions.companyId, companyId),
          eq(workQuestions.id, questionId),
          eq(workQuestions.status, "open"),
          eq(workQuestions.version, expectedVersion),
        )).returning();
        if (!updated) throw conflict("Work question changed before reassignment");
        await emitMirror(updated, issue, tx);
        await tx.insert(activityLog).values({
          companyId,
          actorType: "user",
          actorId: actor.userId,
          action: "work_question.reassigned",
          entityType: "work_question",
          entityId: questionId,
          details: {
            recipientUserId: updated.currentRecipientUserId,
            version: updated.version,
          },
        });
        return updated;
      });
    },

    async takeOver(companyId: string, questionId: string, actor: WorkQuestionUserActor, expectedVersion: number) {
      const { question, issue } = await getQuestionAndIssue(companyId, questionId);
      if (question.status !== "open") throw conflict("Only open work questions can be taken over");
      await assertCapability("takeOver", companyId, actor, question, issue);
      return db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        const [updated] = await tx.update(workQuestions).set({
          currentRecipientUserId: actor.userId,
          version: expectedVersion + 1,
          updatedAt: new Date(),
        }).where(and(
          eq(workQuestions.companyId, companyId),
          eq(workQuestions.id, questionId),
          eq(workQuestions.status, "open"),
          eq(workQuestions.version, expectedVersion),
        )).returning();
        if (!updated) throw conflict("Work question changed before takeover");
        await emitMirror(updated, issue, tx);
        await tx.insert(activityLog).values({
          companyId,
          actorType: "user",
          actorId: actor.userId,
          action: "work_question.taken_over",
          entityType: "work_question",
          entityId: questionId,
          details: { version: updated.version },
        });
        return updated;
      });
    },

    async retryContinuation(companyId: string, questionId: string, actor: WorkQuestionUserActor, expectedVersion: number) {
      const { question, issue } = await getQuestionAndIssue(companyId, questionId);
      await assertCapability("retryContinuation", companyId, actor, question, issue);
      if (question.status !== "answered" || question.continuationStatus !== "failed" || !continuationNeeded(question)) {
        throw conflict("Work question has no failed continuation to retry");
      }
      return db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        const failedRequest = await tx.select().from(workQuestionContinuationRequests).where(and(
          eq(workQuestionContinuationRequests.companyId, companyId),
          eq(workQuestionContinuationRequests.questionId, questionId),
          eq(workQuestionContinuationRequests.status, "failed"),
        )).orderBy(desc(workQuestionContinuationRequests.answerVersion)).limit(1)
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!failedRequest?.continuationEnvelope) {
          throw conflict("Failed continuation is missing its immutable envelope");
        }
        const nextVersion = expectedVersion + 1;
        const [updated] = await tx.update(workQuestions).set({
          continuationStatus: "pending",
          continuationRunKind: null,
          continuationRunId: null,
          continuationError: null,
          version: nextVersion,
          updatedAt: new Date(),
        }).where(and(
          eq(workQuestions.companyId, companyId),
          eq(workQuestions.id, questionId),
          eq(workQuestions.status, "answered"),
          eq(workQuestions.continuationStatus, "failed"),
          eq(workQuestions.version, expectedVersion),
        )).returning();
        if (!updated) throw conflict("Work question changed before continuation retry");
        await tx.update(workQuestionContinuationRequests).set({
          status: "pending",
          attempts: 0,
          nextAttemptAt: new Date(),
          claimedAt: null,
          claimToken: null,
          leaseExpiresAt: null,
          lastError: null,
          downstreamIdempotencyKey: `${workQuestionContinuationIdempotencyKey(questionId, failedRequest.answerVersion)}:retry:${nextVersion}`,
          updatedAt: new Date(),
        }).where(and(
          eq(workQuestionContinuationRequests.id, failedRequest.id),
          eq(workQuestionContinuationRequests.status, "failed"),
        ));
        await tx.insert(activityLog).values({
          companyId,
          actorType: "user",
          actorId: actor.userId,
          action: "work_question.continuation_retried",
          entityType: "work_question",
          entityId: questionId,
          details: { version: updated.version },
        });
        return updated;
      });
    },

    async cancelByUser(companyId: string, questionId: string, actor: WorkQuestionUserActor, expectedVersion: number) {
      const { question, issue } = await getQuestionAndIssue(companyId, questionId);
      await assertCapability("cancel", companyId, actor, question, issue);
      return db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        const [updated] = await tx.update(workQuestions).set({
          status: "cancelled",
          continuationStatus: "not_needed",
          version: expectedVersion + 1,
          updatedAt: new Date(),
        }).where(and(
          eq(workQuestions.companyId, companyId),
          eq(workQuestions.id, questionId),
          eq(workQuestions.status, "open"),
          eq(workQuestions.version, expectedVersion),
        )).returning();
        if (!updated) throw conflict("Work question changed before cancellation");
        await hubItemsService(tx).reconcile(companyId, {
          sourceType: "work_question",
          sourceId: questionId,
        });
        await tx.insert(activityLog).values({
          companyId,
          actorType: "user",
          actorId: actor.userId,
          action: "work_question.cancelled",
          entityType: "work_question",
          entityId: questionId,
          details: { version: updated.version },
        });
        return updated;
      });
    },

    async listPendingContinuations(limit = 50) {
      return db.select().from(workQuestionContinuationRequests).where(and(
        eq(workQuestionContinuationRequests.status, "pending"),
      )).orderBy(asc(workQuestionContinuationRequests.nextAttemptAt)).limit(Math.min(limit, 200));
    },
  };
}
