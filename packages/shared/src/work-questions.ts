import { z } from "zod";

export const WORK_QUESTION_STATUSES = ["open", "answered", "cancelled"] as const;
export type WorkQuestionStatus = (typeof WORK_QUESTION_STATUSES)[number];

// Durable questions may originate from task-bound organization heartbeat runs
// or task-bound AoA Crew internal-agent runs.
export const WORK_QUESTION_RUN_KINDS = ["heartbeat", "internal_agent"] as const;
export type WorkQuestionRunKind = (typeof WORK_QUESTION_RUN_KINDS)[number];

export const WORK_QUESTION_CONTINUATION_STATUSES = [
  "not_needed",
  "pending",
  "dispatched",
  "completed",
  "failed",
] as const;
export type WorkQuestionContinuationStatus =
  (typeof WORK_QUESTION_CONTINUATION_STATUSES)[number];

export const WORK_QUESTION_CONTINUATION_REQUEST_STATUSES = [
  "pending",
  "claimed",
  "dispatched",
  "failed",
  "cancelled",
] as const;
export type WorkQuestionContinuationRequestStatus =
  (typeof WORK_QUESTION_CONTINUATION_REQUEST_STATUSES)[number];

export const workQuestionOptionSchema = z
  .object({
    label: z.string().trim().min(1).max(240),
    value: z.string().trim().min(1).max(500),
    description: z.string().trim().min(1).max(1000).optional(),
    rationale: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

export type WorkQuestionOption = z.infer<typeof workQuestionOptionSchema>;

export const workQuestionAnswerSchema = z
  .object({
    text: z.string().trim().min(1).max(8000).optional(),
    selectedValues: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.text || value.selectedValues?.length), {
    message: "An answer must include text or at least one selected value",
  });

export type WorkQuestionAnswer = z.infer<typeof workQuestionAnswerSchema>;

export const createWorkQuestionSchema = z
  .object({
    issueId: z.string().uuid(),
    askingAgentId: z.string().uuid(),
    originatingRunKind: z.enum(WORK_QUESTION_RUN_KINDS),
    originatingRunId: z.string().uuid(),
    producerInvocationId: z.string().trim().min(1).max(255).optional(),
    executionWorkspaceId: z.string().uuid().nullable().optional(),
    sourceDiscussionId: z.string().uuid().nullable().optional(),
    sourceDiscussionEntryId: z.string().uuid().nullable().optional(),
    sourceCommanderConversationId: z.string().uuid().nullable().optional(),
    primaryRecipientUserId: z.string().trim().min(1).max(255).optional(),
    title: z.string().trim().min(1).max(240),
    question: z.string().trim().min(1).max(8000),
    context: z.record(z.string(), z.unknown()).nullable().optional(),
    options: z.array(workQuestionOptionSchema).max(20).nullable().optional(),
    blocking: z.boolean().optional().default(true),
  })
  .strict()
  .refine(
    (value) => !value.options || new Set(value.options.map((option) => option.value)).size === value.options.length,
    { message: "Question option values must be unique", path: ["options"] },
  );

export type CreateWorkQuestionInput = z.infer<typeof createWorkQuestionSchema>;

export interface WorkQuestion {
  id: string;
  companyId: string;
  issueId: string | null;
  issueIdentifierSnapshot: string | null;
  issueTitleSnapshot: string | null;
  askingAgentId: string | null;
  askingAgentNameSnapshot: string | null;
  originatingRunKind: WorkQuestionRunKind | null;
  originatingRunId: string | null;
  producerInvocationId: string | null;
  producerPayloadFingerprint: string | null;
  executionWorkspaceId: string | null;
  sourceDiscussionId: string | null;
  sourceDiscussionEntryId: string | null;
  sourceCommanderConversationId: string | null;
  primaryRecipientUserId: string;
  currentRecipientUserId: string;
  title: string;
  question: string;
  context: Record<string, unknown> | null;
  options: WorkQuestionOption[] | null;
  blocking: boolean;
  slaDurationHours: number;
  slaSource: "company" | "project";
  slaSourceId: string | null;
  dueAt: Date;
  slaBreachedAt: Date | null;
  escalationRecipientUserId: string | null;
  status: WorkQuestionStatus;
  answer: WorkQuestionAnswer | null;
  answerIdempotencyKey: string | null;
  answeredByUserId: string | null;
  answeredAt: Date | null;
  continuationStatus: WorkQuestionContinuationStatus;
  continuationRunKind: WorkQuestionRunKind | null;
  continuationRunId: string | null;
  continuationError: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkQuestionContinuationRequest {
  id: string;
  companyId: string;
  questionId: string;
  answerVersion: number;
  targetRunKind: WorkQuestionRunKind;
  targetAgentId: string | null;
  targetConversationId: string | null;
  status: WorkQuestionContinuationRequestStatus;
  attempts: number;
  nextAttemptAt: Date;
  claimedAt: Date | null;
  claimToken: string | null;
  leaseExpiresAt: Date | null;
  dispatchedAt: Date | null;
  lastError: string | null;
  continuationEnvelope: WorkQuestionContinuationEnvelope | null;
  downstreamIdempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkQuestionContinuationEnvelope {
  version: 1;
  task: {
    id: string;
    identifier: string | null;
    title: string;
    description: string | null;
    statusAtAnswer: string;
    acceptanceCriteria: string[];
  };
  question: {
    id: string;
    title: string;
    text: string;
    context: Record<string, unknown> | null;
    options: WorkQuestionOption[] | null;
  };
  answer: {
    value: WorkQuestionAnswer;
    version: number;
    responderUserId: string;
    answeredAt: string;
  };
  provenance: {
    originatingRunKind: WorkQuestionRunKind;
    originatingRunId: string;
    priorProviderSessionId: string | null;
    executionWorkspaceId: string | null;
    sourceDiscussionId: string | null;
    sourceDiscussionEntryId: string | null;
    sourceCommanderConversationId: string | null;
  };
  remainingWorkInstructions: string;
}

export interface WorkQuestionCapabilities {
  create: boolean;
  read: boolean;
  answer: boolean;
  reassign: boolean;
  takeOver: boolean;
  retryContinuation: boolean;
  cancel: boolean;
}

export interface WorkQuestionDetail {
  question: WorkQuestion;
  capabilities: WorkQuestionCapabilities;
}

export function workQuestionContinuationIdempotencyKey(
  questionId: string,
  answerVersion: number,
): string {
  return `work-question:${questionId}:answer:${answerVersion}`;
}

export const answerWorkQuestionSchema = z
  .object({
    answer: workQuestionAnswerSchema,
    expectedVersion: z.number().int().nonnegative(),
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();

export type AnswerWorkQuestionInput = z.infer<typeof answerWorkQuestionSchema>;

export const reassignWorkQuestionSchema = z
  .object({
    userId: z.string().trim().min(1).max(255),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type ReassignWorkQuestionInput = z.infer<typeof reassignWorkQuestionSchema>;

export const mutateWorkQuestionVersionSchema = z
  .object({ expectedVersion: z.number().int().nonnegative() })
  .strict();

export type MutateWorkQuestionVersionInput = z.infer<typeof mutateWorkQuestionVersionSchema>;
