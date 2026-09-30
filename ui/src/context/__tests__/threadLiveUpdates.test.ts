import { describe, it, expect, vi } from "vitest";
import { handleLiveEvent, threadEventToInvalidations } from "../LiveUpdatesProvider";
import { queryKeys } from "../../lib/queryKeys";
import type { QueryClient } from "@tanstack/react-query";

// Plan 7 Task 4: a thread.* live event maps to the React Query keys to
// invalidate (refetch-on-poke). RBAC stays in REST — invalidation just refetches.
describe("threadEventToInvalidations", () => {
  it("maps a thread event to the right query keys", () => {
    const keys = threadEventToInvalidations(
      { type: "thread.scope.changed", threadId: "t1" },
      "co1",
    );
    expect(keys).toContainEqual(["thread", "co1", "t1"]);
    expect(keys).toContainEqual(["threads", "co1"]);
    expect(keys).toContainEqual(queryKeys.threads.list("co1"));
    // also invalidates the concrete detail key the ThreadDetail page uses
    expect(keys).toContainEqual(queryKeys.threads.detail("co1", "t1"));
    expect(keys).toContainEqual(queryKeys.discussions.list("co1"));
    expect(keys).toContainEqual(queryKeys.discussions.detail("co1", "t1"));
  });

  it("maps thread.entry.created the same way", () => {
    const keys = threadEventToInvalidations(
      { type: "thread.entry.created", threadId: "t9" },
      "coX",
    );
    expect(keys).toContainEqual(["thread", "coX", "t9"]);
    expect(keys).toContainEqual(["threads", "coX"]);
    expect(keys).toContainEqual(queryKeys.threads.list("coX"));
  });

  it("returns no keys when the event has no threadId", () => {
    const keys = threadEventToInvalidations(
      { type: "thread.presence" } as { type: string; threadId?: string },
      "co1",
    );
    expect(keys).toEqual([]);
  });
});

describe("handleLiveEvent hub invalidations", () => {
  function makeQueryClient() {
    return {
      invalidateQueries: vi.fn(),
      getQueryData: vi.fn(),
    } as unknown as QueryClient & { invalidateQueries: ReturnType<typeof vi.fn> };
  }

  it("invalidates hub list, counts, badges, and digest when a hub item event arrives", () => {
    vi.useFakeTimers();
    const queryClient = makeQueryClient();
    const notifyHubItemChanged = vi.fn();

    handleLiveEvent(
      queryClient,
      "co1",
      {
        id: 1,
        companyId: "co1",
        type: "hub.item.changed",
        createdAt: "2026-06-30T00:00:00.000Z",
        payload: {
          itemId: "hub-1",
          semanticType: "reminder",
          lane: "notifications",
          status: "open",
          version: 1,
          change: "created",
        },
      },
      vi.fn(),
      { cooldownHits: new Map(), suppressUntil: 0 },
      notifyHubItemChanged,
    );

    // Counts, badges, digest, and the viewer refresh fire immediately.
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.hubItems.counts("co1"),
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.sidebarBadges("co1"),
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.notifications.digest("co1"),
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.cockpit("co1"),
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.cockpitCounts("co1"),
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["cockpit-tasks", "co1"],
    });
    expect(notifyHubItemChanged).toHaveBeenCalledWith("hub-1");
    // The broad hub-items LIST invalidation is trailing-coalesced, not immediate.
    expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["hub-items", "co1"],
    });
    vi.advanceTimersByTime(200);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["hub-items", "co1"] });
    vi.useRealTimers();
  });

  it("invalidates hub lists when a personal-state counts event arrives", () => {
    vi.useFakeTimers();
    const queryClient = makeQueryClient();

    handleLiveEvent(
      queryClient,
      "co1",
      {
        id: 2,
        companyId: "co1",
        type: "hub.counts.changed",
        createdAt: "2026-06-30T00:00:00.000Z",
        payload: { reason: "personal_state_changed" },
      },
      vi.fn(),
      { cooldownHits: new Map(), suppressUntil: 0 },
    );

    // Counts + badges immediate; the LIST invalidation is trailing-coalesced.
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.hubItems.counts("co1"),
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.sidebarBadges("co1"),
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.cockpitCounts("co1"),
    });
    expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["hub-items", "co1"],
    });
    vi.advanceTimersByTime(200);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["hub-items", "co1"] });
    vi.useRealTimers();
  });

  it("invalidates notification digest when a digest event arrives", () => {
    const queryClient = makeQueryClient();

    handleLiveEvent(
      queryClient,
      "co1",
      {
        id: 2,
        companyId: "co1",
        type: "hub.digest.changed",
        createdAt: "2026-06-30T00:00:00.000Z",
        payload: { reason: "queued" },
      },
      vi.fn(),
      { cooldownHits: new Map(), suppressUntil: 0 },
    );

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.notifications.digest("co1"),
    });
  });
});
