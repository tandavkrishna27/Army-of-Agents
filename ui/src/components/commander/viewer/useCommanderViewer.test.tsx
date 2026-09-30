import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { CommanderInputRef, CommanderOutputRef } from "@armyofagents/shared";
import { useCommanderViewer } from "./useCommanderViewer";

const ref = (id: string): CommanderOutputRef => ({
  v: 1,
  kind: "artifact",
  id,
  action: "created",
});

describe("useCommanderViewer input refs", () => {
  it("opens input refs as viewer tabs", () => {
    const { result } = renderHook(() => useCommanderViewer("conv-1"));
    const discussionRef: CommanderInputRef = {
      v: 1,
      kind: "discussion",
      id: "disc-1",
      label: "Sprint planning",
    };

    act(() => {
      result.current.openInputRef(discussionRef);
    });

    expect(result.current.state.tabs).toHaveLength(1);
    expect(result.current.state.tabs[0]).toMatchObject({
      id: "discussion:disc-1",
      kind: "discussion",
      refId: "disc-1",
      title: "Sprint planning",
    });
    expect(result.current.state.expanded).toBe(true);
  });
});

describe("useCommanderViewer — stale-closure safety", () => {
  // The SSE stream calls viewer.onLiveRef from inside a memoized sendText
  // closure (InternalAgentPanel), so the api object it holds can be renders
  // old. The hook must read live state at call time — successive calls on the
  // SAME captured api object must accumulate tabs, not clobber each other.
  // New contract (Task 4): onLiveRef opens the SINGLE ref it is handed and
  // threads the effective viewerControl level through to shouldAutoOpen.
  // One-tab-per-turn arbitration now lives in InternalAgentPanel (covered by
  // the pure pickAutoOpenRef test), NOT here — the hook no longer decides which
  // of a batch to open.
  it("opens the single ref passed to it, honoring the level arg, from a stale api object", () => {
    const { result } = renderHook(() => useCommanderViewer("conv-1"));
    const staleApi = result.current; // captured once, like the memoized sendText closure

    act(() => {
      staleApi.onLiveRef(ref("a1"), false, "own_output");
    });

    expect(result.current.state.tabs.map((t) => t.refId)).toEqual(["a1"]);
    expect(result.current.state.activeId).toBe("artifact:a1:latest");
    expect(result.current.state.expanded).toBe(true);
  });

  it("does not drop user-opened tabs when a stale closure delivers a live ref", () => {
    const { result } = renderHook(() => useCommanderViewer("conv-1"));
    const staleApi = result.current;

    // User opens a tab via chips (fresh closure path) after staleApi was captured.
    act(() => {
      result.current.openRef(ref("manual"));
    });
    // Live ref arrives through the old captured object.
    act(() => {
      staleApi.onLiveRef(ref("live"), false);
    });

    expect(result.current.state.tabs.map((t) => t.refId)).toEqual(["manual", "live"]);
  });

  it("badges without expanding on mobile, reading live state", () => {
    const { result } = renderHook(() => useCommanderViewer("conv-1"));
    const staleApi = result.current;

    act(() => {
      staleApi.onLiveRef(ref("m1"), true);
    });
    act(() => {
      staleApi.onLiveRef(ref("m2"), true);
    });

    expect(result.current.state.tabs.map((t) => t.refId)).toEqual(["m1", "m2"]);
    expect(result.current.state.expanded).toBe(false);
    expect(result.current.state.activeId).toBe("home");
    expect(result.current.pendingBadge).toBe(2);
  });
});
