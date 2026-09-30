import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRODUCTIVITY_REVIEW_LIMITS,
  buildProductivityReviewIssueInput,
  buildProductivityReviewWakePayload,
  isProductivityReviewSourceIssue,
  shouldCreateProductivityReview,
  shouldHoldProductivityReviewContinuation,
  shouldRefreshProductivityReview,
} from "../services/productivity-review.js";

describe("productivity review service helpers", () => {
  it("detects no-comment streaks, long-active work, and high churn", () => {
    const now = new Date(Date.UTC(2026, 4, 13, 12));

    expect(
      shouldCreateProductivityReview({
        noCommentRunStreak: DEFAULT_PRODUCTIVITY_REVIEW_LIMITS.noCommentStreakRuns,
        activeSince: new Date(now.getTime() - DEFAULT_PRODUCTIVITY_REVIEW_LIMITS.longActiveMs - 1),
        churnLastHour: 0,
        churnLastSixHours: 0,
        openReviewIssue: null,
        recentResolvedReviewAt: null,
        creationsInWindow: 0,
        now,
      }),
    ).toMatchObject({ create: true, trigger: "no_comment_streak" });

    expect(
      shouldCreateProductivityReview({
        noCommentRunStreak: 0,
        activeSince: new Date(now.getTime() - DEFAULT_PRODUCTIVITY_REVIEW_LIMITS.longActiveMs - 1),
        churnLastHour: 0,
        churnLastSixHours: 0,
        openReviewIssue: null,
        recentResolvedReviewAt: null,
        creationsInWindow: 0,
        now,
      }),
    ).toMatchObject({ create: true, trigger: "long_active" });

    expect(
      shouldCreateProductivityReview({
        noCommentRunStreak: 0,
        activeSince: null,
        churnLastHour: 0,
        churnLastSixHours: DEFAULT_PRODUCTIVITY_REVIEW_LIMITS.highChurnSixHours,
        openReviewIssue: null,
        recentResolvedReviewAt: null,
        creationsInWindow: 0,
        now,
      }),
    ).toMatchObject({ create: true, trigger: "high_churn" });
  });

  it("bounds creation by open reviews, snooze windows, and creation caps", () => {
    const now = new Date(Date.UTC(2026, 4, 13, 12));
    const signal = {
      noCommentRunStreak: DEFAULT_PRODUCTIVITY_REVIEW_LIMITS.noCommentStreakRuns,
      activeSince: null,
      churnLastHour: 0,
      churnLastSixHours: 0,
      now,
    };

    expect(
      shouldCreateProductivityReview({
        ...signal,
        openReviewIssue: { id: "review-1", lastRefreshedAt: now, refreshCount: 0 },
        recentResolvedReviewAt: null,
        creationsInWindow: 0,
      }),
    ).toMatchObject({ create: false, reason: "open_review_exists" });
    expect(
      shouldCreateProductivityReview({
        ...signal,
        openReviewIssue: null,
        recentResolvedReviewAt: new Date(now.getTime() - 1_000),
        creationsInWindow: 0,
      }),
    ).toMatchObject({ create: false, reason: "recently_resolved_snooze" });
    expect(
      shouldCreateProductivityReview({
        ...signal,
        openReviewIssue: null,
        recentResolvedReviewAt: null,
        creationsInWindow: DEFAULT_PRODUCTIVITY_REVIEW_LIMITS.maxCreationsPerWindow,
      }),
    ).toMatchObject({ create: false, reason: "creation_window_cap" });
  });

  it("creates bounded review issue input with cheap recovery wake payload", () => {
    const input = buildProductivityReviewIssueInput({
      sourceIssue: {
        id: "issue-1",
        companyId: "company-1",
        title: "Source task",
        assigneeAgentId: "agent-1",
        projectId: "project-1",
        goalId: "goal-1",
        requestDepth: 4,
      },
      trigger: "high_churn",
    });

    expect(input.issue).toMatchObject({
      title: "Review productivity for: Source task",
      status: "todo",
      assigneeAgentId: "agent-1",
      projectId: "project-1",
      goalId: "goal-1",
      originKind: "issue_productivity_review",
      originId: "issue-1",
      requestDepth: 5,
    });
    const wakePayload = buildProductivityReviewWakePayload({
      reviewIssueId: "review-1",
      sourceIssueId: "issue-1",
      trigger: "high_churn",
    });
    expect(wakePayload).toMatchObject({
      issueId: "review-1",
      taskId: "review-1",
      reviewIssueId: "review-1",
      sourceIssueId: "issue-1",
      wakeReason: "issue_productivity_review",
      trigger: "high_churn",
      modelProfileHint: "cheap",
      recoveryModelProfile: "cheap",
    });
  });

  it("holds continuations for soft-stop productivity review triggers", () => {
    expect(shouldHoldProductivityReviewContinuation({ openReviewIssueId: "review-1" })).toBe(true);
    expect(shouldHoldProductivityReviewContinuation({ openReviewIssueId: null })).toBe(false);
  });

  it("bounds open productivity review refresh comments", () => {
    const now = new Date(Date.UTC(2026, 4, 13, 12));
    expect(
      shouldRefreshProductivityReview({
        lastRefreshedAt: null,
        refreshCount: 0,
        now,
      }),
    ).toBe(true);
    expect(
      shouldRefreshProductivityReview({
        lastRefreshedAt: new Date(now.getTime() - DEFAULT_PRODUCTIVITY_REVIEW_LIMITS.refreshIntervalMs - 1),
        refreshCount: 2,
        now,
      }),
    ).toBe(true);
    expect(
      shouldRefreshProductivityReview({
        lastRefreshedAt: new Date(now.getTime() - 1_000),
        refreshCount: 2,
        now,
      }),
    ).toBe(false);
    expect(
      shouldRefreshProductivityReview({
        lastRefreshedAt: new Date(now.getTime() - DEFAULT_PRODUCTIVITY_REVIEW_LIMITS.refreshIntervalMs - 1),
        refreshCount: DEFAULT_PRODUCTIVITY_REVIEW_LIMITS.maxRefreshComments,
        now,
      }),
    ).toBe(false);
  });

  it("excludes productivity review tasks from review source scans", () => {
    expect(isProductivityReviewSourceIssue({ originKind: null })).toBe(true);
    expect(isProductivityReviewSourceIssue({ originKind: "agent_created" })).toBe(true);
    expect(isProductivityReviewSourceIssue({ originKind: "issue_productivity_review" })).toBe(false);
  });
});
