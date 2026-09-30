import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../services/internal-agent/types.js";

vi.mock("../services/threads.js", () => ({
  parseMentions: vi.fn((text: string) =>
    [...text.matchAll(/(?:^|\s)@(\w+)/g)].map((m) => ({ raw: `@${m[1]}`, name: m[1] })),
  ),
  processMentions: vi.fn().mockResolvedValue(undefined),
}));

const proposeThreadAction = vi.fn();

vi.mock("../services/thread-agent-actions.js", () => ({
  threadAgentActionService: vi.fn(() => ({
    proposeThreadAction,
  })),
}));

vi.mock("../services/crew-task-service.js", () => ({
  crewTaskService: vi.fn(() => ({
    proposeWork: vi.fn(),
  })),
}));

import { createPostEntryTool } from "../services/internal-agent/tools/post-entry-tool.js";
import { proposeCrewWorkTool } from "../services/internal-agent/tools/propose-crew-work.js";
import { proposeMemoryFromThreadTool } from "../services/internal-agent/tools/memory-propose.js";
import { agentDispatchTool } from "../services/internal-agent/tools/agent-dispatch.js";
import { createArtifactTool } from "../services/internal-agent/tools/create-artifact-tool.js";
import { createAdvancePhaseTool } from "../services/internal-agent/tools/advance-phase-tool.js";
import {
  buildPostReplyIdempotencyKey,
  buildArtifactCandidateIdempotencyKey,
  buildConveneAgentIdempotencyKey,
  buildScopeDraftIdempotencyKey,
  buildAddScopeItemIdempotencyKey,
  buildAdvancePhaseIdempotencyKey,
} from "../services/internal-agent/tools/thread-action-keys.js";
import { processMentions } from "../services/threads.js";
import { buildMcpBridgeSpec } from "../services/internal-agent/cli-mode.js";

const companyId = "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa";
const threadId = "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb";
const runId = "cccccccc-0000-4000-8000-cccccccccccc";
const agentId = "dddddddd-0000-4000-8000-dddddddddddd";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    companyId,
    userId: "aoa-subagent",
    userRole: "founder",
    enabledCapabilities: ["discussion_processing", "system_actions"],
    agentId,
    runId,
    discussionRunMode: "controller_action_gate",
    threadFreshness: { latestHumanSeq: 4, entrySeq: 6, latestScopeVersionId: null },
    db: {} as never,
    services: {
      discussions: {
        addEntry: vi.fn().mockResolvedValue({ id: "entry-direct" }),
      },
      artifacts: {
        create: vi.fn().mockResolvedValue({ id: "artifact-direct", versions: [{ id: "version-direct" }] }),
      },
      threads: {
        advancePhase: vi.fn().mockResolvedValue(undefined),
      },
    } as never,
    ...overrides,
  } as ToolContext;
}

describe("action-gated discussion tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    proposeThreadAction.mockResolvedValue({ id: "action-1" });
  });

  it("post_entry proposes a post_reply action in controller action-gate mode", async () => {
    const ctx = makeCtx();
    const result = await createPostEntryTool().execute(
      { threadId, content: "I can help with this.", parentEntryId: "entry-1" },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ actionId: "action-1", queued: true });
    expect(ctx.services.discussions.addEntry).not.toHaveBeenCalled();
    expect(processMentions).not.toHaveBeenCalled();
    expect(proposeThreadAction).toHaveBeenCalledWith({
      companyId,
      threadId,
      runId,
      agentId,
      actionType: "post_reply",
      payload: {
        rawContent: "I can help with this.",
        parentEntryId: "entry-1",
        sourceInfo: null,
      },
      // #197: run-independent + turn-anchored (latestHumanSeq=4 → "4"); the key is
      // derived by the shared builder, so assert via the builder for the same inputs.
      idempotencyKey: buildPostReplyIdempotencyKey({
        threadId,
        agentId,
        parentEntryId: "entry-1",
        content: "I can help with this.",
        turnAnchor: "4",
      }),
      freshness: { latestHumanSeq: 4, entrySeq: 6, latestScopeVersionId: null },
    });
  });

  it("propose_crew_work proposes a versioned scope draft action in controller action-gate mode", async () => {
    const ctx = makeCtx();
    const result = await proposeCrewWorkTool.execute(
      {
        threadId,
        summary: "Build a scoped onboarding flow.",
        proposedTasks: [{ title: "Draft the onboarding plan" }],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ actionId: "action-1", queued: true });
    expect(proposeThreadAction).toHaveBeenCalledWith({
      companyId,
      threadId,
      runId,
      agentId,
      actionType: "create_scope_draft",
      payload: {
        summary: "Build a scoped onboarding flow.",
        proposedTasks: [{ title: "Draft the onboarding plan" }],
      },
      // #198: run-independent + turn-anchored (latestHumanSeq=4 → "4"); derived by the shared builder.
      idempotencyKey: buildScopeDraftIdempotencyKey({
        threadId,
        agentId,
        summary: "Build a scoped onboarding flow.",
        proposedTasks: [{ title: "Draft the onboarding plan" }],
        turnAnchor: "4",
      }),
      freshness: { latestHumanSeq: 4, entrySeq: 6, latestScopeVersionId: null },
    });
  });

  it("builds bridge env for controller action-gate runs", () => {
    const spec = buildMcpBridgeSpec({
      companyId,
      userId: "aoa-subagent",
      userRole: "founder",
      enabledCapabilities: ["discussion_processing"],
      bridgeEntrypoint: "server/src/services/internal-agent/mcp-bridge.ts",
      agentKind: "aoa",
      toolAllowlist: ["post_entry"],
      agentId,
      runId,
      discussionRunMode: "controller_action_gate",
      effectiveAutonomy: 1,
      threadFreshness: { latestHumanSeq: 4, entrySeq: 6, latestScopeVersionId: null },
    });

    expect(spec.env.AOA_RUN_ID).toBe(runId);
    expect(spec.env.AOA_DISCUSSION_RUN_MODE).toBe("controller_action_gate");
    expect(JSON.parse(spec.env.AOA_THREAD_FRESHNESS ?? "{}")).toEqual({
      latestHumanSeq: 4,
      entrySeq: 6,
      latestScopeVersionId: null,
    });
  });

  it("propose_memory_from_thread queues a memory candidate scope item in controller action-gate mode", async () => {
    // Review fix (b): the gated branch now loads the thread's privacy gates
    // (allowMemoryExtraction + visibility) BEFORE queuing. Provide a thread row
    // that permits extraction so the candidate is queued.
    const limit = vi.fn().mockResolvedValue([
      { id: threadId, visibility: "company", allowMemoryExtraction: true },
    ]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const ctx = makeCtx({
      db: {
        select,
        insert: vi.fn(),
      } as never,
    });

    const result = await proposeMemoryFromThreadTool.execute(
      {
        sourceThreadId: threadId,
        content: "Use department-scoped onboarding docs as the source of truth.",
        layer: "active_context",
        type: "decision",
        title: "Onboarding source of truth",
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ actionId: "action-1", queued: true });
    // The privacy gate select runs, but no memory_items insert happens in gated
    // mode (the candidate is committed later via the action queue).
    expect(ctx.db.insert).not.toHaveBeenCalled();
    expect(proposeThreadAction).toHaveBeenCalledWith({
      companyId,
      threadId,
      runId,
      agentId,
      actionType: "add_scope_item",
      payload: {
        kind: "memory_candidate",
        title: "Onboarding source of truth",
        content: "Use department-scoped onboarding docs as the source of truth.",
        layer: "active_context",
        category: "decision",
      },
      // #198: run-independent + turn-anchored; derived by the shared builder.
      idempotencyKey: buildAddScopeItemIdempotencyKey({
        threadId,
        agentId,
        title: "Onboarding source of truth",
        content: "Use department-scoped onboarding docs as the source of truth.",
        layer: "active_context",
        category: "decision",
        turnAnchor: "4",
      }),
      freshness: { latestHumanSeq: 4, entrySeq: 6, latestScopeVersionId: null },
    });
  });

  it("agent.dispatch queues a convene_agent action in controller action-gate mode", async () => {
    const targetAgentId = "eeeeeeee-0000-4000-8000-eeeeeeeeeeee";
    const ctx = makeCtx({
      // agent.dispatch validates that a caller-supplied threadId resolves WITHIN
      // the caller's own company before it can enter the wakeup payload (the
      // cross-tenant guard in agent-dispatch.ts). That runs
      // `select().from(discussions).where(...).limit(1)`, so the db mock has to be
      // chainable — a bare `select: vi.fn()` returns undefined and blows up on
      // `.from`. Resolve one row so the thread reads as in-company and the
      // convene_agent queueing this test actually asserts can proceed.
      db: {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [{ id: threadId }]),
            })),
          })),
        })),
        insert: vi.fn(),
      } as never,
    });

    const result = await agentDispatchTool.execute(
      {
        agentId: targetAgentId,
        context: { threadId, mentionEntryId: "entry-2", hopCount: 1 },
        reason: "Need engineering review",
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ actionId: "action-1", queued: true, hopCount: 2 });
    // The cross-tenant guard reads the thread once to prove the caller-supplied
    // threadId belongs to this company before it can enter the queued action's
    // payload. (This assertion used to be `not.toHaveBeenCalled()`; that was
    // correct until agent.dispatch gained the ownership validation.)
    expect(ctx.db.select).toHaveBeenCalledTimes(1);
    // Still the load-bearing one: the action-gated path must NEVER write a wakeup
    // row directly — it queues a thread action for the controller instead.
    expect(ctx.db.insert).not.toHaveBeenCalled();
    expect(proposeThreadAction).toHaveBeenCalledWith({
      companyId,
      threadId,
      runId,
      agentId,
      actionType: "convene_agent",
      payload: {
        targetAgentId,
        reason: "Need engineering review",
        context: { threadId, mentionEntryId: "entry-2", hopCount: 2 },
      },
      // #198: run-independent + turn-anchored; derived by the shared builder.
      // hopCount is intentionally excluded from the key (folding it in would split
      // the key across re-proposes that increment the hop).
      idempotencyKey: buildConveneAgentIdempotencyKey({
        threadId,
        agentId,
        targetAgentId,
        reason: "Need engineering review",
        turnAnchor: "4",
      }),
      freshness: { latestHumanSeq: 4, entrySeq: 6, latestScopeVersionId: null },
    });
  });

  it("create_artifact queues an artifact candidate in controller action-gate mode", async () => {
    const ctx = makeCtx({
      db: {
        select: vi.fn(),
        update: vi.fn(),
      } as never,
    });

    const result = await createArtifactTool().execute(
      {
        title: "Onboarding plan",
        type: "document",
        content: "# Plan\nUse the versioned scope.",
        discussionId: threadId,
        attachToEntryId: "entry-3",
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ actionId: "action-1", queued: true });
    expect(ctx.services.artifacts.create).not.toHaveBeenCalled();
    expect(ctx.db.select).not.toHaveBeenCalled();
    expect(ctx.db.update).not.toHaveBeenCalled();
    expect(proposeThreadAction).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      threadId,
      runId,
      agentId,
      actionType: "create_artifact_candidate",
      payload: expect.objectContaining({
        title: "Onboarding plan",
        artifactType: "document",
        content: "# Plan\nUse the versioned scope.",
        fileRef: null,
        discussionId: threadId,
        attachToEntryId: "entry-3",
        storageKind: "inline",
      }),
      // #197: run-independent + turn-anchored; derived by the shared builder.
      idempotencyKey: buildArtifactCandidateIdempotencyKey({
        threadId,
        agentId,
        title: "Onboarding plan",
        content: "# Plan\nUse the versioned scope.",
        fileRef: null,
        turnAnchor: "4",
      }),
      freshness: { latestHumanSeq: 4, entrySeq: 6, latestScopeVersionId: null },
    }));
  });

  it("advance_phase queues a phase action in Drive controller action-gate mode", async () => {
    const ctx = makeCtx({ effectiveAutonomy: 2 });

    const result = await createAdvancePhaseTool().execute(
      { threadId, toPhase: "assign" },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ actionId: "action-1", queued: true });
    expect(ctx.services.threads.advancePhase).not.toHaveBeenCalled();
    expect(proposeThreadAction).toHaveBeenCalledWith({
      companyId,
      threadId,
      runId,
      agentId,
      actionType: "advance_phase",
      payload: {
        toPhase: "assign",
        effectiveAutonomy: 2,
      },
      // #198: run-independent + turn-anchored; derived by the shared builder.
      idempotencyKey: buildAdvancePhaseIdempotencyKey({
        threadId,
        agentId,
        toPhase: "assign",
        turnAnchor: "4",
      }),
      freshness: { latestHumanSeq: 4, entrySeq: 6, latestScopeVersionId: null },
    });
  });

  it("advance_phase does not queue when controller autonomy is below Drive", async () => {
    const ctx = makeCtx({ effectiveAutonomy: 1 });

    const result = await createAdvancePhaseTool().execute(
      { threadId, toPhase: "assign" },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("AUTONOMY_INSUFFICIENT");
    expect(proposeThreadAction).not.toHaveBeenCalled();
    expect(ctx.services.threads.advancePhase).not.toHaveBeenCalled();
  });
});
