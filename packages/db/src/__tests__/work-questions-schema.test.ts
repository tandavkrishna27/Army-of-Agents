import { describe, expect, it } from "vitest";
import {
  companies,
  issues,
  projects,
  routines,
  workflowTemplates,
  workQuestions,
} from "../schema/index.js";

describe("completion policy and work-questions schema", () => {
  it("exposes completion defaults and task snapshots at every supported scope", () => {
    expect(companies).toHaveProperty("agentCompletionPolicyDefault");
    expect(companies).toHaveProperty("agentCompletionReviewGuardrail");
    expect(projects).toHaveProperty("agentCompletionPolicyDefault");
    expect(routines).toHaveProperty("agentCompletionPolicyOverride");
    expect(workflowTemplates).toHaveProperty("agentCompletionPolicyOverride");

    for (const column of [
      "acceptanceCriteria",
      "agentCompletionPolicy",
      "agentCompletionPolicyOverride",
      "agentCompletionPolicySource",
      "agentCompletionPolicySourceId",
      "agentCompletionPolicyResolvedAt",
      "reviewerSource",
    ]) {
      expect(issues, column).toHaveProperty(column);
    }
  });

  it("exports the durable question identity, answer, and continuation columns", () => {
    for (const column of [
      "companyId",
      "issueId",
      "askingAgentId",
      "originatingRunKind",
      "originatingRunId",
      "executionWorkspaceId",
      "sourceDiscussionId",
      "sourceDiscussionEntryId",
      "primaryRecipientUserId",
      "currentRecipientUserId",
      "question",
      "options",
      "blocking",
      "status",
      "answer",
      "answerIdempotencyKey",
      "answeredByUserId",
      "continuationStatus",
      "continuationRunKind",
      "continuationRunId",
      "version",
    ]) {
      expect(workQuestions, column).toHaveProperty(column);
    }
  });
});
