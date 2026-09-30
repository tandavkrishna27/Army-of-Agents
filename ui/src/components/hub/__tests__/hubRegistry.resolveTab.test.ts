import { describe, expect, it } from "vitest";
import type { HubItemListRow } from "@/api/hub-items";
import { HUB_REGISTRY, hubTabForItem } from "../hubRegistry";

/** Minimal row factory — only the fields resolveTabId/hubTabForItem read. */
function row(overrides: Partial<HubItemListRow>): HubItemListRow {
  return {
    id: "hub-1",
    companyId: "co-1",
    semanticType: "legacy_other",
    lane: null,
    status: "open",
    priority: "normal",
    title: "Item",
    summary: null,
    sourceType: null,
    sourceId: null,
    relatedEntityId: null,
    relatedEntityType: null,
    ownerUserId: null,
    ownerPool: null,
    claimedByUserId: null,
    claimedAt: null,
    version: 1,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    readAt: null,
    snoozedUntil: null,
    dismissedAt: null,
    groupKey: null,
    groupLabel: null,
    groupCount: null,
    scopeKey: null,
    slaAt: null,
    ...overrides,
  } as HubItemListRow;
}

describe("resolveTabId", () => {
  it("always prefers relatedEntityId over the composite sourceId", () => {
    // relatedEntityId wins even when sourceId is a composite that leads with it.
    const item = row({
      semanticType: "mention",
      relatedEntityId: "ent",
      sourceId: "ent:user:type:evt",
    });
    expect(HUB_REGISTRY.mention.resolveTabId(item)).toBe("ent");
  });

  it("prefers relatedEntityId even when it differs from the composite", () => {
    const item = row({
      semanticType: "extraction_failed",
      relatedEntityId: "discussion-9",
      sourceId: "OTHER:user:type:evt",
    });
    expect(HUB_REGISTRY.extraction_failed.resolveTabId(item)).toBe("discussion-9");
  });

  it("marketplace_op fallback returns the OPERATION id (2nd segment), not the first", () => {
    // marketplace-notifications.ts:53 — `<eventType>:<operationId>:<ownerUserId>`.
    const item = row({
      semanticType: "marketplace_op",
      relatedEntityId: null,
      sourceId: "install_completed:op-123:user-7",
    });
    expect(HUB_REGISTRY.marketplace_op.resolveTabId(item)).toBe("op-123");
  });

  it("scan-materialized run_failed uses the raw sourceId as the run id", () => {
    // hub-source-producers.ts:192-194 — sourceId IS run.id, no composite.
    const item = row({
      semanticType: "run_failed",
      relatedEntityId: null,
      sourceId: "run-42",
    });
    expect(HUB_REGISTRY.run_failed.resolveTabId(item)).toBe("run-42");
  });

  it("mention on a task falls back to the FIRST segment (taskId:userId)", () => {
    const item = row({
      semanticType: "mention",
      relatedEntityId: null,
      sourceType: "issue",
      sourceId: "task-5:user-7",
    });
    expect(HUB_REGISTRY.mention.resolveTabId(item)).toBe("task-5");
  });

  it("mention on a thread falls back to the FIRST segment (threadId:entryId:userId)", () => {
    const item = row({
      semanticType: "mention",
      relatedEntityId: null,
      sourceType: "discussion",
      sourceId: "thread-3:entry-2:user-7",
    });
    expect(HUB_REGISTRY.mention.resolveTabId(item)).toBe("thread-3");
  });
});

describe("agent_error", () => {
  it("no longer resolves fullLink to /agents/all — deep-links to the thread", () => {
    const item = row({
      semanticType: "agent_error",
      relatedEntityType: "discussion",
      relatedEntityId: "discussion-77",
    });
    const link = HUB_REGISTRY.agent_error.fullLink(item);
    expect(link).not.toBe("/agents/all");
    expect(link).toBe("/discussions/discussion-77");
  });

  it("agent_error tabKind is thread", () => {
    expect(HUB_REGISTRY.agent_error.tabKind).toBe("thread");
  });
});

describe("hubTabForItem", () => {
  it("opens an approval tab keyed on the resolved id", () => {
    const tab = hubTabForItem(
      row({ semanticType: "approval_request", sourceId: "approval-1" }),
    );
    expect(tab.kind).toBe("approval");
    expect(tab.key).toBe("approval:approval-1");
  });

  it("opens a thread tab for discussion_pending", () => {
    const tab = hubTabForItem(
      row({ semanticType: "discussion_pending", sourceId: "disc-1" }),
    );
    expect(tab.kind).toBe("thread");
    expect(tab.key).toBe("thread:disc-1");
  });

  it("opens a runtime_decision tab keyed on the HUB ITEM id", () => {
    const tab = hubTabForItem(
      row({
        id: "hub-xyz",
        semanticType: "agent_runtime_decision",
        sourceId: "decision-1",
        relatedEntityId: "run-1",
      }),
    );
    expect(tab.kind).toBe("runtime_decision");
    expect(tab.key).toBe("runtime_decision:hub-xyz");
  });

  it("opens a task tab for stale_work", () => {
    const tab = hubTabForItem(row({ semanticType: "stale_work", sourceId: "issue-9" }));
    expect(tab.kind).toBe("task");
    expect(tab.key).toBe("task:issue-9");
  });

  it("opens a task tab for a mention on a task (sourceType issue)", () => {
    const tab = hubTabForItem(
      row({ semanticType: "mention", sourceType: "issue", sourceId: "task-5:user-7" }),
    );
    expect(tab.kind).toBe("task");
    expect(tab.key).toBe("task:task-5");
  });

  it("opens a thread tab for a mention in a thread (sourceType discussion)", () => {
    const tab = hubTabForItem(
      row({
        semanticType: "mention",
        sourceType: "discussion",
        sourceId: "thread-3:entry-2:user-7",
      }),
    );
    expect(tab.kind).toBe("thread");
    expect(tab.key).toBe("thread:thread-3");
  });

  it("falls back to a notification tab for legacy_other / proactive", () => {
    expect(hubTabForItem(row({ id: "h1", semanticType: "legacy_other" })).kind).toBe(
      "notification",
    );
    const proactive = hubTabForItem(row({ id: "h2", semanticType: "proactive" }));
    expect(proactive.kind).toBe("notification");
    expect(proactive.key).toBe("notification:h2");
  });

  it("degrades a run item to notification when no agentId is available on the row", () => {
    // run_failed carries no agent id on the UI row → honest fallback.
    const tab = hubTabForItem(row({ id: "h3", semanticType: "run_failed", sourceId: "run-42" }));
    expect(tab.kind).toBe("notification");
  });

  it("opens a run tab keyed on the RUN id (sourceId), with the agentId from relatedEntity", () => {
    // hub-source-producers sets sourceId = run.id AND relatedEntityId = run.agentId.
    // The run tab MUST be runTab(runId=run.id, agentId), NOT runTab(agentId, agentId):
    // the tab key is `run:<runId>` and the payload carries both ids distinctly.
    const tab = hubTabForItem(
      row({
        semanticType: "run_failed",
        sourceId: "run-42",
        relatedEntityId: "agent-7",
        relatedEntityType: "agent",
      }),
    );
    expect(tab.kind).toBe("run");
    // Keyed on the RUN id — never the agent id.
    expect(tab.key).toBe("run:run-42");
    expect(tab.payload).toEqual({ runId: "run-42", agentId: "agent-7", hubItemId: "hub-1" });
  });

  it("opens a run tab for run_complete with the same run/agent id split", () => {
    const tab = hubTabForItem(
      row({
        semanticType: "run_complete",
        sourceId: "run-99",
        relatedEntityId: "agent-3",
        relatedEntityType: "agent",
      }),
    );
    expect(tab.kind).toBe("run");
    expect(tab.key).toBe("run:run-99");
    expect(tab.payload).toEqual({ runId: "run-99", agentId: "agent-3", hubItemId: "hub-1" });
  });

  it("opens a marketplace_op tab keyed on the operation id", () => {
    const tab = hubTabForItem(
      row({ semanticType: "marketplace_op", sourceId: "install_completed:op-123:user-7" }),
    );
    expect(tab.kind).toBe("marketplace_op");
    expect(tab.key).toBe("marketplace_op:op-123");
  });

  it("preserves the originating hub item id when two rows share one tab key", () => {
    const first = hubTabForItem(
      row({
        id: "hub-market-1",
        semanticType: "marketplace_op",
        sourceId: "install_completed:op-123:user-7",
      }),
    );
    const second = hubTabForItem(
      row({
        id: "hub-market-2",
        semanticType: "marketplace_op",
        sourceId: "install_completed:op-123:user-9",
      }),
    );

    expect(first.key).toBe(second.key);
    expect(first.payload).toMatchObject({ hubItemId: "hub-market-1" });
    expect(second.payload).toMatchObject({ hubItemId: "hub-market-2" });
  });
});
