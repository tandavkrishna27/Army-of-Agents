import { and, eq, or } from "drizzle-orm";
import { heartbeatRuns, internalAgentRuns, issues, type Db } from "@armyofagents/db";
import { z } from "zod";
import type { HumanQuestionRuntimeCapabilities } from "@armyofagents/adapter-utils";
import type { WorkQuestionRunKind } from "@armyofagents/shared";
import {
  WorkQuestionCancelledError,
  workQuestionService,
} from "../../services/work-questions.js";
import { type ToolContext, type ToolHandler, type ToolResult, err, ok } from "./types.js";

const WORK_QUESTION_BLOCK_TIMEOUT_MS = 5 * 60 * 1000;
const TITLE_CAP = 120;

const askHumanSchema = z
  .object({
    question: z.string().trim().min(1).max(8000),
    options: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(240),
          value: z.string().trim().min(1).max(500),
          description: z.string().trim().min(1).max(1000).optional(),
          rationale: z.string().trim().min(1).max(1000).optional(),
        }).strict(),
      )
      .max(20)
      .refine((options) => new Set(options.map((option) => option.value)).size === options.length, {
        message: "option values must be unique",
      })
      .optional(),
    context: z.string().trim().max(8000).optional(),
  })
  .strict();

function capped(text: string): string {
  return text.length <= TITLE_CAP ? text : `${text.slice(0, TITLE_CAP - 3)}...`;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readUuid(value: unknown): string | null {
  const candidate = readString(value);
  return candidate && z.string().uuid().safeParse(candidate).success ? candidate : null;
}

interface WorkQuestionRunSource {
  issueId: string | null;
  executionWorkspaceId: string | null;
  sourceDiscussionId: string | null;
  sourceCommanderConversationId: string | null;
}

async function sourceForRun(
  db: Db,
  companyId: string,
  runId: string,
  runKind: WorkQuestionRunKind,
): Promise<WorkQuestionRunSource> {
  const heartbeatRun = runKind === "heartbeat"
    ? await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)))
      .then((rows) => rows[0] ?? null)
    : null;
  const crewRun = runKind === "internal_agent"
    ? await db
      .select({
        relatedEntityType: internalAgentRuns.relatedEntityType,
        relatedEntityId: internalAgentRuns.relatedEntityId,
      })
      .from(internalAgentRuns)
      .where(and(eq(internalAgentRuns.companyId, companyId), eq(internalAgentRuns.id, runId)))
      .then((rows) => rows[0] ?? null)
    : null;
  const snapshot = heartbeatRun?.contextSnapshot ?? {};
  const fromContext = readUuid(snapshot.issueId) ?? readUuid(snapshot.taskId);
  const crewIssueId = crewRun?.relatedEntityType === "task" ? crewRun.relatedEntityId : null;
  const issueId = fromContext ?? crewIssueId ?? await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      eq(issues.companyId, companyId),
      or(eq(issues.checkoutRunId, runId), eq(issues.executionRunId, runId)),
    ))
    .then((rows) => rows[0]?.id ?? null);
  const issue = issueId
    ? await db.select({
      executionWorkspaceId: issues.executionWorkspaceId,
      sourceDiscussionId: issues.sourceDiscussionId,
    }).from(issues).where(and(
      eq(issues.companyId, companyId),
      eq(issues.id, issueId),
    )).then((rows) => rows[0] ?? null)
    : null;
  return {
    issueId,
    executionWorkspaceId: readUuid(snapshot.executionWorkspaceId) ?? issue?.executionWorkspaceId ?? null,
    sourceDiscussionId:
      readUuid(snapshot.sourceDiscussionId) ?? readUuid(snapshot.discussionId) ?? issue?.sourceDiscussionId ?? null,
    sourceCommanderConversationId:
      readUuid(snapshot.sourceCommanderConversationId) ?? readUuid(snapshot.conversationId),
  };
}

export class ActiveRunTaskMissingError extends Error {
  constructor() {
    super("Active run is not attached to a task");
    this.name = "ActiveRunTaskMissingError";
  }
}

export async function askHumanForActiveRun(
  input: {
    db: Db;
    companyId: string;
    agentId: string;
    runId: string;
    originatingRunKind?: WorkQuestionRunKind;
    producerInvocationId?: string;
    humanQuestionCapabilities?: HumanQuestionRuntimeCapabilities;
  },
  args: Record<string, unknown>,
) {
  const parsed = askHumanSchema.parse(args);
  const originatingRunKind = input.originatingRunKind ?? "heartbeat";
  const source = await sourceForRun(input.db, input.companyId, input.runId, originatingRunKind);
  if (!source.issueId) throw new ActiveRunTaskMissingError();

  const questions = workQuestionService(input.db);
  const created = await questions.create(input.companyId, {
    issueId: source.issueId,
    askingAgentId: input.agentId,
    originatingRunKind,
    originatingRunId: input.runId,
    producerInvocationId: input.producerInvocationId,
    executionWorkspaceId: source.executionWorkspaceId,
    sourceDiscussionId: source.sourceDiscussionId,
    sourceCommanderConversationId: source.sourceCommanderConversationId,
    title: capped(parsed.question),
    question: parsed.question,
    context: parsed.context ? { summary: parsed.context } : null,
    options: parsed.options ?? null,
    blocking: true,
  });

  if (originatingRunKind === "heartbeat") {
    await input.db.update(heartbeatRuns).set({
      livenessState: "waiting_on_human",
      livenessReason: "work_question",
      nextAction: `work_question:${created.id}`,
      updatedAt: new Date(),
    }).where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.agentId, input.agentId),
      eq(heartbeatRuns.status, "running"),
    ));
  }

  if (input.humanQuestionCapabilities?.mode !== "live_relay") {
    return {
      answered: false as const,
      questionId: created.id,
      status: "parked" as const,
      note: "waiting for human",
    };
  }

  try {
    const answered = await questions.waitForAnswer({
      companyId: input.companyId,
      questionId: created.id,
      timeoutMs: WORK_QUESTION_BLOCK_TIMEOUT_MS,
    });
    try {
      await questions.markRelayed(input.companyId, created.id, answered.version);
    } catch {
      // The durable answer remains valid if a continuation worker won the race.
    }
    return { answered: true as const, questionId: created.id, answer: answered.answer };
  } catch (error) {
    if (error instanceof WorkQuestionCancelledError) {
      return { answered: false as const, questionId: created.id, status: "parked" as const, note: "question cancelled" };
    }
    if (error instanceof Error && /timed out/i.test(error.message)) {
      return { answered: false as const, questionId: created.id, status: "parked" as const, note: "waiting for human" };
    }
    throw error;
  }
}

/**
 * Provider-neutral Ask Human. `ask_founder` remains an alias while existing
 * agent prompts migrate, but recipient routing follows the task's durable
 * responsible-human/reviewer/founder chain.
 */
export async function handleAskHuman(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (ctx.actor.source !== "agent" || !ctx.actor.agentId || !ctx.actor.runId) {
    return err(403, -32003, "ask_human requires an active organization-agent run");
  }
  try {
    return ok(await askHumanForActiveRun({
      db: ctx.db,
      companyId: ctx.companyId,
      agentId: ctx.actor.agentId,
      runId: ctx.actor.runId,
    }, args));
  } catch (error) {
    if (error instanceof ActiveRunTaskMissingError) {
      return err(409, -32009, error.message);
    }
    throw error;
  }
}

export const handleAskFounder = handleAskHuman;

export const askFounderToolHandlers: Record<string, ToolHandler> = {
  ask_human: handleAskHuman,
  ask_founder: handleAskHuman,
};
