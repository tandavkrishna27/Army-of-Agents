import { describe, expect, it } from "vitest";
import {
  buildPostReplyIdempotencyKey,
  buildArtifactCandidateIdempotencyKey,
  buildConveneAgentIdempotencyKey,
  buildConveneWakeupDedupKey,
  buildScopeDraftIdempotencyKey,
  buildAddScopeItemIdempotencyKey,
  buildAdvancePhaseIdempotencyKey,
} from "../services/internal-agent/tools/thread-action-keys.js";

describe("thread action idempotency keys", () => {
  it("post_reply key is run-INDEPENDENT (same inputs across runs → same key)", () => {
    const base = { threadId: "t1", agentId: "a1", parentEntryId: "p1", content: "Done.", turnAnchor: "h5" };
    expect(buildPostReplyIdempotencyKey(base)).toBe(buildPostReplyIdempotencyKey(base));
    expect(buildPostReplyIdempotencyKey(base)).not.toMatch(/run/);
  });

  it("post_reply key is content/parent/agent-sensitive (distinct → distinct keys)", () => {
    const base = { threadId: "t1", agentId: "a1", parentEntryId: "p1", content: "Done.", turnAnchor: "h5" };
    expect(buildPostReplyIdempotencyKey(base)).not.toBe(buildPostReplyIdempotencyKey({ ...base, content: "Other." }));
    expect(buildPostReplyIdempotencyKey(base)).not.toBe(buildPostReplyIdempotencyKey({ ...base, parentEntryId: "p2" }));
    expect(buildPostReplyIdempotencyKey(base)).not.toBe(buildPostReplyIdempotencyKey({ ...base, agentId: "a2" }));
  });

  it("post_reply IDENTICAL content in the SAME turn dedups, across DISTINCT turns does NOT (must-fix #4)", () => {
    const turn1 = { threadId: "t1", agentId: "a1", parentEntryId: null, content: "Done.", turnAnchor: "h5" };
    const turn1Retry = { ...turn1 }; // same turn anchor → same key (retry dedups)
    const turn2 = { ...turn1, turnAnchor: "h8" }; // new human entry → new turn → distinct key
    expect(buildPostReplyIdempotencyKey(turn1)).toBe(buildPostReplyIdempotencyKey(turn1Retry));
    expect(buildPostReplyIdempotencyKey(turn1)).not.toBe(buildPostReplyIdempotencyKey(turn2));
  });

  it("post_reply key tolerates null agent/parent/anchor without colliding distinct content", () => {
    const a = buildPostReplyIdempotencyKey({ threadId: "t1", agentId: null, parentEntryId: null, content: "Hi", turnAnchor: null });
    const b = buildPostReplyIdempotencyKey({ threadId: "t1", agentId: null, parentEntryId: null, content: "Bye", turnAnchor: null });
    expect(a).not.toBe(b);
  });

  it("artifact candidate key is run-INDEPENDENT, turn-anchored, content/title-sensitive", () => {
    const base = { threadId: "t1", agentId: "a1", title: "Spec", content: "body", fileRef: null, turnAnchor: "h5" };
    expect(buildArtifactCandidateIdempotencyKey(base)).toBe(buildArtifactCandidateIdempotencyKey(base));
    expect(buildArtifactCandidateIdempotencyKey(base)).not.toBe(buildArtifactCandidateIdempotencyKey({ ...base, content: "x" }));
    expect(buildArtifactCandidateIdempotencyKey(base)).not.toBe(buildArtifactCandidateIdempotencyKey({ ...base, title: "Other" }));
    expect(buildArtifactCandidateIdempotencyKey(base)).not.toBe(buildArtifactCandidateIdempotencyKey({ ...base, turnAnchor: "h8" }));
  });

  it("artifact key is fileRef-sensitive even when content is present (M2)", () => {
    const base = { threadId: "t1", agentId: "a1", title: "Spec", content: "body", turnAnchor: "h5" };
    expect(buildArtifactCandidateIdempotencyKey({ ...base, fileRef: "f1" })).not.toBe(
      buildArtifactCandidateIdempotencyKey({ ...base, fileRef: "f2" }),
    );
  });

  it("artifact key is unambiguous across title/content boundary (M2)", () => {
    // "A B"/"C" must NOT collide with "A"/"B C" (space-join ambiguity).
    expect(
      buildArtifactCandidateIdempotencyKey({ threadId: "t1", agentId: "a1", title: "A B", content: "C", fileRef: null, turnAnchor: "h5" }),
    ).not.toBe(
      buildArtifactCandidateIdempotencyKey({ threadId: "t1", agentId: "a1", title: "A", content: "B C", fileRef: null, turnAnchor: "h5" }),
    );
  });
});

describe("deferred-type idempotency keys (#198 PR-A)", () => {
  it("convene_agent key is run-independent, turn-anchored, target/reason/source-agent-sensitive (#198 PR-A; wakeup-dedup alignment deferred to PR-B)", () => {
    const base = { threadId: "t1", agentId: "a1", targetAgentId: "tg1", reason: "review", turnAnchor: "5" };
    expect(buildConveneAgentIdempotencyKey(base)).toBe(buildConveneAgentIdempotencyKey(base));
    expect(buildConveneAgentIdempotencyKey(base)).not.toMatch(/run/);
    expect(buildConveneAgentIdempotencyKey(base)).not.toBe(buildConveneAgentIdempotencyKey({ ...base, targetAgentId: "tg2" }));
    // Discriminated key keeps genuinely-distinct dispatches distinct. The mismatch with
    // the wakeup dedup scope (Codex #202 P2) is a known benign edge deferred to PR-B.
    expect(buildConveneAgentIdempotencyKey(base)).not.toBe(buildConveneAgentIdempotencyKey({ ...base, reason: "other" }));
    expect(buildConveneAgentIdempotencyKey(base)).not.toBe(buildConveneAgentIdempotencyKey({ ...base, agentId: "a2" }));
    expect(buildConveneAgentIdempotencyKey(base)).not.toBe(buildConveneAgentIdempotencyKey({ ...base, turnAnchor: "6" }));
  });
  it("convene wakeup dedupKey discriminates by sourceActionId (distinct actions enqueue separately; same action collapses)", () => {
    const k1 = buildConveneWakeupDedupKey({ targetAgentId: "t", threadId: "th", sourceActionId: "act-1" });
    const k2 = buildConveneWakeupDedupKey({ targetAgentId: "t", threadId: "th", sourceActionId: "act-2" });
    expect(k1).not.toBe(k2);
    expect(k1.endsWith(":queued")).toBe(true);
    expect(buildConveneWakeupDedupKey({ targetAgentId: "t", threadId: "th", sourceActionId: "act-1" })).toBe(k1);
  });
  it("create_scope_draft key hashes summary + tasks (no raw interpolation), turn-anchored", () => {
    const base = { threadId: "t1", agentId: "a1", summary: "Scope it", proposedTasks: [{ title: "X" }], turnAnchor: "5" };
    expect(buildScopeDraftIdempotencyKey(base)).toBe(buildScopeDraftIdempotencyKey(base));
    expect(buildScopeDraftIdempotencyKey(base)).not.toBe(buildScopeDraftIdempotencyKey({ ...base, summary: "Other" }));
    // task-content sensitivity: the proposedTasks hashing path must matter
    expect(buildScopeDraftIdempotencyKey(base)).not.toBe(buildScopeDraftIdempotencyKey({ ...base, proposedTasks: [{ title: "Y" }] }));
    expect(buildScopeDraftIdempotencyKey(base)).not.toBe(buildScopeDraftIdempotencyKey({ ...base, proposedTasks: [{ title: "X", assigneeRole: "eng" }] }));
    expect(buildScopeDraftIdempotencyKey(base)).not.toBe(buildScopeDraftIdempotencyKey({ ...base, turnAnchor: "6" }));
  });
  it("add_scope_item key hashes title/content/layer/category, turn-anchored", () => {
    const base = { threadId: "t1", agentId: "a1", title: "Decision", content: "c", layer: "active_context", category: "decision", turnAnchor: "5" };
    expect(buildAddScopeItemIdempotencyKey(base)).toBe(buildAddScopeItemIdempotencyKey(base));
    expect(buildAddScopeItemIdempotencyKey(base)).not.toBe(buildAddScopeItemIdempotencyKey({ ...base, content: "d" }));
    expect(buildAddScopeItemIdempotencyKey(base)).not.toBe(buildAddScopeItemIdempotencyKey({ ...base, layer: "domain" }));
    expect(buildAddScopeItemIdempotencyKey(base)).not.toBe(buildAddScopeItemIdempotencyKey({ ...base, category: "insight" }));
    expect(buildAddScopeItemIdempotencyKey(base)).not.toBe(buildAddScopeItemIdempotencyKey({ ...base, turnAnchor: "6" }));
  });
  it("add_scope_item key is unambiguous across the title/content boundary", () => {
    // "A B"/"C" must NOT collide with "A"/"B C" (raw-join ambiguity the JSON.stringify tuple prevents).
    const a = buildAddScopeItemIdempotencyKey({ threadId: "t1", agentId: "a1", title: "A B", content: "C", layer: "domain", category: "decision", turnAnchor: "5" });
    const b = buildAddScopeItemIdempotencyKey({ threadId: "t1", agentId: "a1", title: "A", content: "B C", layer: "domain", category: "decision", turnAnchor: "5" });
    expect(a).not.toBe(b);
  });
  it("advance_phase key is run-independent + phase-keyed", () => {
    const base = { threadId: "t1", agentId: "a1", toPhase: "assign", turnAnchor: "5" };
    expect(buildAdvancePhaseIdempotencyKey(base)).toBe(buildAdvancePhaseIdempotencyKey(base));
    expect(buildAdvancePhaseIdempotencyKey(base)).not.toMatch(/run/);
    expect(buildAdvancePhaseIdempotencyKey(base)).not.toBe(buildAdvancePhaseIdempotencyKey({ ...base, toPhase: "done" }));
  });
  it("all four builders tolerate null agent/anchor without colliding distinct content", () => {
    // exercises the `?? "agent"` / `?? "noanchor"` fallbacks on agent-only threads
    expect(buildConveneAgentIdempotencyKey({ threadId: "t1", agentId: null, targetAgentId: "tg1", reason: null, turnAnchor: null }))
      .not.toBe(buildConveneAgentIdempotencyKey({ threadId: "t1", agentId: null, targetAgentId: "tg2", reason: null, turnAnchor: null }));
    expect(buildScopeDraftIdempotencyKey({ threadId: "t1", agentId: null, summary: "a", proposedTasks: [], turnAnchor: null }))
      .not.toBe(buildScopeDraftIdempotencyKey({ threadId: "t1", agentId: null, summary: "b", proposedTasks: [], turnAnchor: null }));
    expect(buildAddScopeItemIdempotencyKey({ threadId: "t1", agentId: null, title: "a", content: null, layer: null, category: null, turnAnchor: null }))
      .not.toBe(buildAddScopeItemIdempotencyKey({ threadId: "t1", agentId: null, title: "b", content: null, layer: null, category: null, turnAnchor: null }));
    expect(buildAdvancePhaseIdempotencyKey({ threadId: "t1", agentId: null, toPhase: "assign", turnAnchor: null }))
      .not.toBe(buildAdvancePhaseIdempotencyKey({ threadId: "t1", agentId: null, toPhase: "done", turnAnchor: null }));
  });
});
