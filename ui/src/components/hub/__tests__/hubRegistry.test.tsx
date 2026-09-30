import { describe, expect, it } from "vitest";
import {
  HUB_SEMANTIC_TO_LANE,
  HUB_SEMANTIC_TYPES,
} from "@armyofagents/shared";
import { HUB_REGISTRY, hubTabForItem, resolveHubEntry } from "../hubRegistry";

describe("HUB_REGISTRY", () => {
  it("is total over HUB_SEMANTIC_TYPES", () => {
    for (const semanticType of HUB_SEMANTIC_TYPES) {
      expect(HUB_REGISTRY[semanticType], semanticType).toBeTruthy();
      expect(HUB_REGISTRY[semanticType].lane).toBe(
        HUB_SEMANTIC_TO_LANE[semanticType],
      );
    }
  });

  it("rejects unknown semantic strings", () => {
    expect(resolveHubEntry("not_real")).toBeNull();
  });

  it("routes approval requests to the approval full page", () => {
    const entry = HUB_REGISTRY.approval_request;

    expect(entry.fullLink({ sourceId: "approval-1" } as never)).toBe(
      "/approvals/approval-1",
    );
  });

  it("does not expose broken deep links for source ids without canonical routes", () => {
    expect(HUB_REGISTRY.join_request.fullLink({ sourceId: "join-1" } as never)).toBeNull();
    expect(
      HUB_REGISTRY.mention.fullLink({
        sourceType: "mention",
        sourceId: "thread-1:entry-1:user-1",
      } as never),
    ).toBeNull();
    expect(
      HUB_REGISTRY.marketplace_op.fullLink({ sourceId: "marketplace-1" } as never),
    ).toBeNull();
  });

  it("routes stale work and suggestions to reachable pages", () => {
    expect(HUB_REGISTRY.stale_work.fullLink({ sourceId: "issue-1" } as never)).toBe(
      "/issues/issue-1",
    );
    expect(HUB_REGISTRY.suggestion.fullLink({ sourceId: "suggestion-1" } as never)).toBe(
      "/home",
    );
  });

  it("routes memory_review to the Memory Explorer pending-review folder", () => {
    const entry = HUB_REGISTRY.memory_review;

    expect(entry.lane).toBe("waiting_on_you");
    expect(entry.fullLink({ sourceId: "memory-1" } as never)).toBe(
      "/memory/explore?folder=__pending",
    );
  });

  it("keeps runtime-decision agent errors out of discussion routes", () => {
    const item = {
      id: "hub-1",
      semanticType: "agent_error",
      sourceType: "runtime_decision",
      sourceId: "decision-1",
      relatedEntityType: "heartbeat_run",
      relatedEntityId: "run-1",
      title: "Permission request timed out",
    } as never;

    expect(HUB_REGISTRY.agent_error.fullLink(item)).toBeNull();
    expect(hubTabForItem(item)).toMatchObject({
      kind: "notification",
      payload: { hubItemId: "hub-1" },
    });
  });
});
