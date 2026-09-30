/**
 * Task 0.6 (Inbound Dirty-Data Routing) — MCP debrief-push dual-write tests.
 *
 * Verifies that handleDebriefPush (via writeToolHandlers["debrief-push"]):
 *   (a) still creates the legacy debrief row (existing behaviour preserved)
 *   (b) calls enqueueInboxItem with originMedium:'mcp' + correct content + actor
 *   (c) a thrown enqueueInboxItem does NOT break the debrief (best-effort)
 *
 * Mock pattern mirrors inbox-producer.test.ts / inbox-attach.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks (hoisted by Vitest) ─────────────────────────────────────────

vi.mock("@armyofagents/shared", () => ({
  mcpDebriefSchema: {
    parse: (args: any) => ({
      title: args.title ?? null,
      content: args.content ?? "test content",
      departmentId: args.departmentId ?? null,
      projectId: args.projectId ?? null,
      source: args.source ?? null,
    }),
  },
  mcpArtifactVersionSchema: { parse: (a: any) => a },
  ISSUE_STATUSES: ["todo", "in_progress", "done"],
  MEMORY_ITEM_LAYERS: ["identity", "domain", "active_context", "working"],
}));

// threads.ts/issues.ts (pulled in transitively via the MCP write-tools chain)
// now import hub-items.ts (W1a Task 10); mock it so the real module + its
// @armyofagents/shared imports never load.
vi.mock("../services/hub-items.js", () => ({
  hubItemsService: vi.fn(() => ({ emit: vi.fn(async () => ({ id: "hub-1" })) })),
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: any[]) => args,
  eq: (a: any, b: any) => ({ eq: [a, b] }),
  inArray: (a: any, b: any) => ({ inArray: [a, b] }),
  isNull: (a: any) => ({ isNull: a }),
  ilike: (a: any, b: any) => ({ ilike: [a, b] }),
  desc: (a: any) => ({ desc: a }),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) =>
    new Proxy({} as any, { get: (_t, p) => (typeof p === "string" ? p : undefined) });
  // Enumerate every table the write-tools → memory-write → memory/embeddings chain imports.
  return {
    agents: makeTable("agents"),
    internalAgentRuns: makeTable("internal_agent_runs"),
    discussionEntries: makeTable("discussion_entries"),
    discussions: makeTable("discussions"),
    discussionExtractedItems: makeTable("discussion_extracted_items"),
    debriefs: makeTable("debriefs"),
    briefs: makeTable("briefs"),
    briefItems: makeTable("brief_items"),
    issues: makeTable("issues"),
    memoryItems: makeTable("memory_items"),
    embeddingQueue: makeTable("embedding_queue"),
    memoryItemVersions: makeTable("memory_item_versions"),
    memoryRetrievals: makeTable("memory_retrievals"),
    suggestions: makeTable("suggestions"),
    artifacts: makeTable("artifacts"),
    artifactVersions: makeTable("artifact_versions"),
    goals: makeTable("goals"),
    projects: makeTable("projects"),
  };
});

// The key mock: capture calls to enqueueInboxItem so we can assert them.
vi.mock("../services/inbox-producer.js", () => ({
  enqueueInboxItem: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../mcp/tools/scope.js", () => ({
  assertScopedProjectAccess: vi.fn(),
  assertScopedGoalAccess: vi.fn().mockResolvedValue(undefined),
  artifactProjectMap: vi.fn().mockResolvedValue(new Map()),
  canAccessProjectScopedEntity: vi.fn().mockReturnValue(true),
  filterArtifactsForScope: vi.fn((list: any[]) => list),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { writeToolHandlers } from "../mcp/tools/write-tools.js";
import * as inboxProducer from "../services/inbox-producer.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDebriefSvc(debriefId = "debrief-99") {
  return {
    create: vi.fn().mockResolvedValue({ id: debriefId, title: "test" }),
  };
}

function makeExtractionSvc() {
  return {
    extractFromDebrief: vi.fn().mockReturnValue({
      catch: vi.fn().mockReturnValue(undefined),
    }),
  };
}

/**
 * Synthesise the minimal ToolContext that handleDebriefPush needs.
 * handleDebriefPush reads:
 *   ctx.companyId, ctx.actorInfo.actorId, ctx.actorInfo.actorType,
 *   ctx.actorInfo.agentId, ctx.actorInfo.runId,
 *   ctx.services.debriefsSvc.create(...)
 *   ctx.services.extractionSvc.extractFromDebrief(...)
 *   ctx.db (passed to logActivity)
 *   ctx.scope (passed to assertScopedProjectAccess — mocked)
 */
function makeCtx(opts: {
  companyId?: string;
  actorId?: string;
  debriefSvc?: ReturnType<typeof makeDebriefSvc>;
  extractionSvc?: ReturnType<typeof makeExtractionSvc>;
} = {}) {
  const debriefsSvc = opts.debriefSvc ?? makeDebriefSvc();
  const extractionSvc = opts.extractionSvc ?? makeExtractionSvc();

  return {
    db: {} as any,
    companyId: opts.companyId ?? "co-test-1",
    actor: {
      type: "mcp",
      userId: opts.actorId ?? "mcp-actor-42",
      companyId: opts.companyId ?? "co-test-1",
    } as any,
    actorInfo: {
      actorType: "user" as const,
      actorId: opts.actorId ?? "mcp-actor-42",
      agentId: null,
      runId: null,
    },
    scope: {} as any,
    resolveRole: vi.fn().mockResolvedValue("founder"),
    resolveScopedAgentIds: vi.fn().mockResolvedValue([]),
    services: {
      debriefsSvc,
      extractionSvc,
      issuesSvc: { getById: vi.fn() },
      permissionsSvc: { canAccessMemory: vi.fn().mockResolvedValue(true) },
    } as any,
  };
}

const handler = writeToolHandlers["debrief-push"];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("handleDebriefPush — dual-write (Task 0.6, Decision #14)", () => {
  beforeEach(() => {
    vi.mocked(inboxProducer.enqueueInboxItem).mockReset();
    vi.mocked(inboxProducer.enqueueInboxItem).mockResolvedValue({
      inboxItemId: "inbox-default",
      deduped: false,
    });
  });

  // (a) Legacy debrief path is preserved
  it("still creates the legacy debrief row", async () => {
    const debriefSvc = makeDebriefSvc("debrief-legacy-1");
    const ctx = makeCtx({ debriefSvc });

    await handler(ctx, { content: "hello world" });

    expect(debriefSvc.create).toHaveBeenCalledOnce();
  });

  it("returns ok with debriefId in the result payload", async () => {
    const debriefSvc = makeDebriefSvc("debrief-result-id");
    const ctx = makeCtx({ debriefSvc });

    const result = await handler(ctx, { content: "result test" });

    // ok() wraps into { ok: true, data: { debriefId, status } }
    expect(result).toMatchObject({ data: { debriefId: "debrief-result-id" } });
  });

  // (b) Dual-write to inbox
  it("calls enqueueInboxItem with originMedium:'mcp'", async () => {
    const ctx = makeCtx({ companyId: "co-dual-1", actorId: "actor-mcp-7" });

    await handler(ctx, { content: "the pushed content" });

    expect(inboxProducer.enqueueInboxItem).toHaveBeenCalledOnce();
    const [_db, args] = vi.mocked(inboxProducer.enqueueInboxItem).mock.calls[0];
    expect(args.originMedium).toBe("mcp");
  });

  it("passes the MCP actor id as originSource", async () => {
    const ctx = makeCtx({ actorId: "mcp-actor-77" });

    await handler(ctx, { content: "actor id test" });

    const [_db, args] = vi.mocked(inboxProducer.enqueueInboxItem).mock.calls[0];
    expect(args.originSource).toBe("mcp-actor-77");
  });

  it("passes the pushed content as rawContent", async () => {
    const ctx = makeCtx({ companyId: "co-content-test" });

    await handler(ctx, { content: "specific pushed content" });

    const [_db, args] = vi.mocked(inboxProducer.enqueueInboxItem).mock.calls[0];
    expect(args.rawContent).toBe("specific pushed content");
  });

  it("passes companyId correctly to enqueueInboxItem", async () => {
    const ctx = makeCtx({ companyId: "co-specific-99" });

    await handler(ctx, { content: "company id test" });

    const [_db, args] = vi.mocked(inboxProducer.enqueueInboxItem).mock.calls[0];
    expect(args.companyId).toBe("co-specific-99");
  });

  // (c) Best-effort: enqueue failure must not break the debrief
  it("is best-effort: a thrown enqueueInboxItem does NOT propagate", async () => {
    vi.mocked(inboxProducer.enqueueInboxItem).mockRejectedValue(
      new Error("DB connection lost"),
    );

    const debriefSvc = makeDebriefSvc("debrief-safe-1");
    const ctx = makeCtx({ debriefSvc });

    // Must not throw — the debrief was committed; only the inbox write failed.
    await expect(handler(ctx, { content: "safe content" })).resolves.not.toThrow();
  });

  it("best-effort: debrief is still created when enqueue throws", async () => {
    vi.mocked(inboxProducer.enqueueInboxItem).mockRejectedValue(
      new Error("timeout"),
    );

    const debriefSvc = makeDebriefSvc("debrief-still-created");
    const ctx = makeCtx({ debriefSvc });

    await handler(ctx, { content: "still creates debrief" });

    expect(debriefSvc.create).toHaveBeenCalledOnce();
  });
});
