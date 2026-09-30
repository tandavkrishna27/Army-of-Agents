import { describe, expect, it } from "vitest";
import {
  AGENT_COMPLETION_POLICIES,
  AGENT_COMPLETION_POLICY_SOURCES,
  ISSUE_REVIEWER_SOURCES,
} from "../constants.js";
import {
  WORK_QUESTION_CONTINUATION_STATUSES,
  WORK_QUESTION_CONTINUATION_REQUEST_STATUSES,
  WORK_QUESTION_RUN_KINDS,
  WORK_QUESTION_STATUSES,
  answerWorkQuestionSchema,
  createWorkQuestionSchema,
  workQuestionAnswerSchema,
  workQuestionContinuationIdempotencyKey,
} from "../work-questions.js";
import { createIssueSchema, updateIssueSchema } from "../validators/issue.js";
import { updateCompanySchema } from "../validators/company.js";
import { updateProjectSchema } from "../validators/project.js";
import { updateRoutineSchema } from "../validators/routine.js";
import { updateWorkflowTemplateSchema } from "../validators/workflow-template.js";

describe("completion policy and work-question contracts", () => {
  it("exports the locked completion-policy values and provenance", () => {
    expect(AGENT_COMPLETION_POLICIES).toEqual(["review_required", "agent_can_complete"]);
    expect(AGENT_COMPLETION_POLICY_SOURCES).toEqual([
      "company",
      "department",
      "project",
      "routine",
      "workflow_template",
      "task",
      "legacy_backfill",
    ]);
    expect(ISSUE_REVIEWER_SOURCES).toEqual([
      "explicit",
      "responsible",
      "scope_lead",
      "founder",
    ]);
  });

  it("accepts structured task criteria and a completion-policy override", () => {
    const parsed = createIssueSchema.parse({
      title: "Prepare launch memo",
      acceptanceCriteria: ["Memo includes go/no-go recommendation"],
      agentCompletionPolicyOverride: "agent_can_complete",
    });

    expect(parsed.acceptanceCriteria).toEqual(["Memo includes go/no-go recommendation"]);
    expect(parsed.agentCompletionPolicyOverride).toBe("agent_can_complete");
  });

  it("does not inject acceptance criteria into unrelated task updates", () => {
    const parsed = updateIssueSchema.parse({ title: "Updated title" });
    expect(parsed).not.toHaveProperty("acceptanceCriteria");
  });

  it("accepts completion-policy configuration at every supported parent scope", () => {
    expect(
      updateCompanySchema.parse({
        agentCompletionPolicyDefault: "agent_can_complete",
        agentCompletionReviewGuardrail: true,
      }),
    ).toMatchObject({
      agentCompletionPolicyDefault: "agent_can_complete",
      agentCompletionReviewGuardrail: true,
    });
    expect(
      updateProjectSchema.parse({ agentCompletionPolicyDefault: "review_required" }),
    ).toMatchObject({ agentCompletionPolicyDefault: "review_required" });
    expect(
      updateRoutineSchema.parse({ agentCompletionPolicyOverride: "agent_can_complete" }),
    ).toMatchObject({ agentCompletionPolicyOverride: "agent_can_complete" });
    expect(
      updateWorkflowTemplateSchema.parse({
        agentCompletionPolicyOverride: "review_required",
      }),
    ).toMatchObject({ agentCompletionPolicyOverride: "review_required" });
  });

  it("requires a meaningful answer and optimistic concurrency metadata", () => {
    expect(() => workQuestionAnswerSchema.parse({})).toThrow();
    expect(
      answerWorkQuestionSchema.parse({
        answer: { selectedValues: ["ship"] },
        expectedVersion: 2,
        idempotencyKey: "question-1-answer-2",
      }),
    ).toMatchObject({
      expectedVersion: 2,
      answer: { selectedValues: ["ship"] },
    });
  });

  it("exports the durable question lifecycle values", () => {
    expect(WORK_QUESTION_STATUSES).toEqual(["open", "answered", "cancelled"]);
    expect(WORK_QUESTION_RUN_KINDS).toEqual(["heartbeat", "internal_agent"]);
    expect(WORK_QUESTION_CONTINUATION_STATUSES).toEqual([
      "not_needed",
      "pending",
      "dispatched",
      "completed",
      "failed",
    ]);
    expect(WORK_QUESTION_CONTINUATION_REQUEST_STATUSES).toEqual([
      "pending",
      "claimed",
      "dispatched",
      "failed",
      "cancelled",
    ]);
    expect(workQuestionContinuationIdempotencyKey("question-1", 3)).toBe(
      "work-question:question-1:answer:3",
    );
  });

  it("validates provider-neutral durable question creation", () => {
    const parsed = createWorkQuestionSchema.parse({
      issueId: "11111111-1111-4111-8111-111111111111",
      askingAgentId: "22222222-2222-4222-8222-222222222222",
      originatingRunKind: "heartbeat",
      originatingRunId: "33333333-3333-4333-8333-333333333333",
      title: "Choose a sample",
      question: "Five deep or twelve short?",
      options: [{
        label: "Five deep",
        value: "five",
        description: "More depth",
        rationale: "Fits the schedule",
      }],
    });
    expect(parsed.blocking).toBe(true);
    expect(parsed.options?.[0].rationale).toBe("Fits the schedule");
    expect(() => createWorkQuestionSchema.parse({
      ...parsed,
      options: [{ label: "A", value: "same" }, { label: "B", value: "same" }],
    })).toThrow(/unique/i);
  });
});
