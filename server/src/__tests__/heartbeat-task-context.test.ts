import { describe, expect, it } from "vitest";
import {
  buildCurrentTaskMarkdown,
  buildWakeCommentMarkdown,
  buildWorkQuestionContinuationMarkdown,
} from "../services/heartbeat-task-context.js";

describe("heartbeat provider task context", () => {
  it("includes the canonical task ID, human identifier, and Ask Human binding", () => {
    const markdown = buildCurrentTaskMarkdown({
      id: "2c2d6235-6baf-41cc-b44b-edced9197129",
      identifier: "REA-1",
      title: "Choose the first interview cohort",
      description: "Ask the responsible human before continuing.",
      status: "todo",
      priority: "high",
    });

    expect(markdown).toContain("Task ID: 2c2d6235-6baf-41cc-b44b-edced9197129");
    expect(markdown).toContain("Identifier: REA-1");
    expect(markdown).toContain("`ask_human` automatically binds to this active task");
    expect(markdown).toContain("`mcp__aoa__ask_human`");
    expect(markdown).toContain("Never use a provider-local `request_user_input`");
    expect(markdown).toContain("### Description\nAsk the responsible human before continuing.");
  });

  it("uses the UUID as the identifier fallback without an empty description section", () => {
    const markdown = buildCurrentTaskMarkdown({
      id: "task-id",
      identifier: null,
      title: "Task",
      description: null,
      status: "in_progress",
      priority: "medium",
    });

    expect(markdown).toContain("Identifier: task-id");
    expect(markdown).not.toContain("### Description");
  });

  it("renders the immutable human answer with a readable option label", () => {
    const markdown = buildWorkQuestionContinuationMarkdown({
      version: 1,
      question: {
        title: "Choose a cohort",
        text: "Which cohort should we prioritize?",
        options: [
          { label: "Founder-led SaaS teams", value: "founder_led_saas" },
          { label: "Small product consultancies", value: "small_product_consultancies" },
        ],
      },
      answer: {
        value: { selectedValues: ["founder_led_saas"] },
        version: 1,
      },
      remainingWorkInstructions: "Resume only the remaining work.",
    });

    expect(markdown).toContain("## Human Answer Received");
    expect(markdown).toContain("Question: Which cohort should we prioritize?");
    expect(markdown).toContain("Answer: Founder-led SaaS teams (founder_led_saas)");
    expect(markdown).toContain("Resume only the remaining work.");
  });

  it("does not render malformed or unanswered continuation state", () => {
    expect(buildWorkQuestionContinuationMarkdown(null)).toBeNull();
    expect(buildWorkQuestionContinuationMarkdown({ question: { text: "Question" }, answer: { value: {} } })).toBeNull();
  });
});

describe("buildWakeCommentMarkdown (review F11)", () => {
  it("inlines the triggering comment with author + reason-aware heading", () => {
    const md = buildWakeCommentMarkdown({
      body: "@Quality Auditor please verify CONTEXT-MARKER-77419 before merge.",
      authorLabel: "the board",
      reason: "issue_comment_mentioned",
    });
    expect(md).toContain("## You Were Mentioned in a Comment");
    expect(md).toContain("- From: the board");
    expect(md).toContain("CONTEXT-MARKER-77419");
  });

  it("uses the plain-message heading for non-mention wakes (Send & wake)", () => {
    const md = buildWakeCommentMarkdown({
      body: "Please prioritize the login bug first.",
      authorLabel: "a teammate",
      reason: "issue_comment_added",
    });
    expect(md).toContain("## New Message on This Task");
    expect(md).toContain("Please prioritize the login bug first.");
  });

  it("renders nothing for a missing or empty comment", () => {
    expect(buildWakeCommentMarkdown(null)).toBeNull();
    expect(buildWakeCommentMarkdown({ body: "   ", authorLabel: "the board", reason: null })).toBeNull();
  });
});
