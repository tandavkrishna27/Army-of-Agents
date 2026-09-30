/**
 * Unit tests for assertAgentStatusTransition — the service-level guard that
 * prevents crew agents (calling issueService.update directly via tools) from
 * self-completing without the autonomy dial, and enforces ownership.
 *
 * Dial semantics: in_review requires Assist (>=1), done requires Drive (>=2).
 *
 * LIVE-QA FIX (Scenario B): a crew agent moving its OWN task to `in_review` is
 * gated by ownership + dial ONLY. It does NOT require a separate review path
 * (human assignee or linked pending approval) — for a crew task the `in_review`
 * status IS the founder's review queue. As a result the crew guard is now a PURE
 * function that NEVER queries the DB; every test passes `explodingDb` (which
 * throws if `.select()` is called) to prove the guard touches no database.
 * The route-level assertAgentInReviewReviewPath (org-agent HTTP path) is tested
 * separately in agent-in-review-guard.test.ts.
 */
import { describe, it, expect } from "vitest";

import { assertAgentStatusTransition } from "../services/issue-agent-status-guard.js";
import { HttpError } from "../errors.js";

// A DB whose select would throw if called — proves the crew guard is pure and
// never touches the database (no approval lookup, no review-path query).
const explodingDb = {
  select: () => {
    throw new Error("DB should not be queried — crew status guard is pure");
  },
};

describe("assertAgentStatusTransition", () => {
  // ── done at Drive (dial 2), own task → resolves ──
  it("resolves when crew agent completes its own task at Drive (dial 2)", async () => {
    await expect(
      assertAgentStatusTransition(
        {
          existing: {
            id: "issue-1",
            status: "in_progress",
            assigneeAgentId: "agent-A",
            agentCompletionPolicy: "agent_can_complete",
            acceptanceCriteria: ["All checks pass"],
          },
          updateFields: { status: "done" },
          actor: { actorType: "agent", agentId: "agent-A", effectiveDial: 2 },
        },
        explodingDb as never,
      ),
    ).resolves.toBeUndefined();
  });

  // ── done at Assist (dial 1), own task → throws (Drive required) ──
  it("throws when agent marks own task done at Assist (dial 1 < 2)", async () => {
    await expect(
      assertAgentStatusTransition(
        {
          existing: {
            id: "issue-1",
            status: "in_progress",
            assigneeAgentId: "agent-A",
            agentCompletionPolicy: "agent_can_complete",
            acceptanceCriteria: ["All checks pass"],
          },
          updateFields: { status: "done" },
          actor: { actorType: "agent", agentId: "agent-A", effectiveDial: 1 },
        },
        explodingDb as never,
      ),
    ).rejects.toThrow(HttpError);
  });

  it("routes a review-required task to in_review instead of allowing agent completion", async () => {
    await expect(
      assertAgentStatusTransition(
        {
          existing: {
            id: "issue-1",
            status: "in_progress",
            assigneeAgentId: "agent-A",
            agentCompletionPolicy: "review_required",
            acceptanceCriteria: ["All checks pass"],
          },
          updateFields: { status: "done", acceptanceCriteria: ["Agent-authored criterion"] },
          actor: { actorType: "agent", agentId: "agent-A", effectiveDial: 2 },
        },
        explodingDb as never,
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "review_required", requiredStatus: "in_review" },
    });
  });

  it("requires acceptance criteria before an agent can complete directly", async () => {
    await expect(
      assertAgentStatusTransition(
        {
          existing: {
            id: "issue-1",
            status: "in_progress",
            assigneeAgentId: "agent-A",
            agentCompletionPolicy: "agent_can_complete",
            acceptanceCriteria: [],
          },
          updateFields: { status: "done", acceptanceCriteria: ["Agent-authored criterion"] },
          actor: { actorType: "agent", agentId: "agent-A", effectiveDial: 2 },
        },
        explodingDb as never,
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "acceptance_criteria_required" },
    });
  });

  // ── LIVE-QA FIX: in_review at Assist (dial 1), own task, NO review path → resolves ──
  // This is the exact scenario the live QA surfaced: a crew-only task (no human
  // assigneeUserId, no linked approval) MUST be allowed to reach in_review at Assist.
  // Uses explodingDb to prove the guard does NOT query the DB for a review path.
  it("resolves for in_review at Assist (dial 1) with NO review path (crew card IS the review queue)", async () => {
    await expect(
      assertAgentStatusTransition(
        {
          existing: { id: "issue-1", status: "in_progress", assigneeAgentId: "agent-A" },
          updateFields: { status: "in_review" }, // no assigneeUserId, no approval
          actor: { actorType: "agent", agentId: "agent-A", effectiveDial: 1 },
        },
        explodingDb as never,
      ),
    ).resolves.toBeUndefined();
  });

  // ── in_review at Assist (dial 1), own task, also sets human assignee → still resolves ──
  it("resolves for in_review at Assist (dial 1) when update also sets a human assignee", async () => {
    await expect(
      assertAgentStatusTransition(
        {
          existing: { id: "issue-1", status: "in_progress", assigneeAgentId: "agent-A" },
          updateFields: { status: "in_review", assigneeUserId: "user-1" },
          actor: { actorType: "agent", agentId: "agent-A", effectiveDial: 1 },
        },
        explodingDb as never,
      ),
    ).resolves.toBeUndefined();
  });

  // ── in_review at Manual (dial 0), own task → throws (Assist required) ──
  it("throws when agent moves own task to in_review at Manual (dial 0 < 1)", async () => {
    await expect(
      assertAgentStatusTransition(
        {
          existing: { id: "issue-1", status: "in_progress", assigneeAgentId: "agent-A" },
          updateFields: { status: "in_review" },
          actor: { actorType: "agent", agentId: "agent-A", effectiveDial: 0 },
        },
        explodingDb as never,
      ),
    ).rejects.toThrow(HttpError);
  });

  // ── NOT own task → throws (ownership) ──
  it("throws when agent tries to complete a task assigned to a different agent", async () => {
    await expect(
      assertAgentStatusTransition(
        {
          existing: { id: "issue-1", status: "in_progress", assigneeAgentId: "agent-OTHER" },
          updateFields: { status: "done" },
          actor: { actorType: "agent", agentId: "agent-A", effectiveDial: 2 },
        },
        explodingDb as never,
      ),
    ).rejects.toThrow(HttpError);
  });

  // ── agent with no agentId → throws (ownership: cannot prove it owns the task) ──
  it("throws when actor is agent but no agentId is provided", async () => {
    await expect(
      assertAgentStatusTransition(
        {
          existing: { id: "issue-1", status: "in_progress", assigneeAgentId: "agent-A" },
          updateFields: { status: "done" },
          actor: { actorType: "agent", agentId: null, effectiveDial: 2 },
        },
        explodingDb as never,
      ),
    ).rejects.toThrow(HttpError);
  });

  // ── actorType 'system' → resolves (Commander/system bypass) ──
  it("resolves for system actor (Commander/system bypass)", async () => {
    await expect(
      assertAgentStatusTransition(
        {
          existing: { id: "issue-1", status: "in_progress", assigneeAgentId: null },
          updateFields: { status: "done" },
          actor: { actorType: "system" },
        },
        explodingDb as never,
      ),
    ).resolves.toBeUndefined();
  });

  // ── actorType 'board' → resolves ──
  it("resolves for board actor", async () => {
    await expect(
      assertAgentStatusTransition(
        {
          existing: { id: "issue-1", status: "in_progress", assigneeAgentId: "agent-A" },
          updateFields: { status: "done" },
          actor: { actorType: "board" },
        },
        explodingDb as never,
      ),
    ).resolves.toBeUndefined();
  });

  // ── actorType 'user' → resolves ──
  it("resolves for user actor", async () => {
    await expect(
      assertAgentStatusTransition(
        {
          existing: { id: "issue-1", status: "in_progress", assigneeAgentId: "agent-A" },
          updateFields: { status: "done" },
          actor: { actorType: "user" },
        },
        explodingDb as never,
      ),
    ).resolves.toBeUndefined();
  });

  // ── non-completion transition (e.g. in_progress) by agent → resolves (not gated) ──
  it("resolves for agent transition to a non-completion status (in_progress)", async () => {
    await expect(
      assertAgentStatusTransition(
        {
          existing: { id: "issue-1", status: "todo", assigneeAgentId: "agent-A" },
          updateFields: { status: "in_progress" },
          actor: { actorType: "agent", agentId: "agent-A", effectiveDial: 0 },
        },
        explodingDb as never,
      ),
    ).resolves.toBeUndefined();
  });

  // ── review #2: ownership now applies to NON-completion transitions too ──
  it("throws when agent cancels/reverts a task assigned to a DIFFERENT agent (non-completion status)", async () => {
    await expect(
      assertAgentStatusTransition(
        {
          existing: { id: "issue-1", status: "in_progress", assigneeAgentId: "agent-OTHER" },
          updateFields: { status: "cancelled" },
          actor: { actorType: "agent", agentId: "agent-A", effectiveDial: 0 },
        },
        explodingDb as never,
      ),
    ).rejects.toThrow(HttpError);
  });

  // ── own task, non-completion status (backlog) at Manual → resolves (dial only gates completion) ──
  it("resolves when agent moves its OWN task to a non-completion status (backlog) at Manual", async () => {
    await expect(
      assertAgentStatusTransition(
        {
          existing: { id: "issue-1", status: "in_progress", assigneeAgentId: "agent-A" },
          updateFields: { status: "backlog" },
          actor: { actorType: "agent", agentId: "agent-A", effectiveDial: 0 },
        },
        explodingDb as never,
      ),
    ).resolves.toBeUndefined();
  });
});
