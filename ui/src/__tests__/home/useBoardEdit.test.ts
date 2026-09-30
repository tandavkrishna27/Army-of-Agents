import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { StrictMode, createElement } from "react";
import type { ReactNode } from "react";
import type { HomeBoardLayoutItem } from "@armyofagents/shared";

// Stable mock fns (never reassigned — only reconfigured via
// mockResolvedValue/mockRejectedValueOnce/etc). useBoardEdit's callbacks
// close over whatever `useHomeBoardLayout` returns; reassigning the fn
// reference itself would go stale inside an already-memoized useCallback
// until the next render, so tests reconfigure behavior on the SAME fn
// instance instead of swapping references.
const mocks = vi.hoisted(() => ({
  layout: null as HomeBoardLayoutItem[] | null,
  isSaving: false,
  isResetting: false,
  saveAsync: vi.fn(),
  reset: vi.fn(),
  resetError: null as unknown,
}));

vi.mock("../../hooks/useHomeBoardLayout", () => ({
  useHomeBoardLayout: () => ({
    layout: mocks.layout,
    schemaVersion: null,
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
    save: vi.fn(),
    saveAsync: mocks.saveAsync,
    isSaving: mocks.isSaving,
    saveError: null,
    reset: mocks.reset,
    resetAsync: vi.fn(),
    isResetting: mocks.isResetting,
    resetError: mocks.resetError,
  }),
}));

// P2 (StrictMode purity, moveWidget/cycleWidgetSize): wraps the real
// gridLayout implementation with call-counting spies for moveTileKeyboard/
// cycleTileSize — the two functions that used to run INSIDE a
// setDraft(prev => ...) functional updater alongside setAnnouncement. React
// Strict Mode double-invokes updater functions to catch impurities, so
// before the fix these ran twice per real keyboard move/resize under
// StrictMode; after the fix they run in the plain callback body (setDraft
// receives a plain value, not a function), so StrictMode has no updater to
// double-invoke and they run exactly once. `importOriginal` preserves every
// other export (buildDefaultLg etc., used directly by tests below) untouched.
const gridLayoutSpies = vi.hoisted(() => ({
  moveTileKeyboard: vi.fn(),
  cycleTileSize: vi.fn(),
}));
vi.mock("../../components/home/gridLayout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/home/gridLayout")>();
  gridLayoutSpies.moveTileKeyboard.mockImplementation(actual.moveTileKeyboard);
  gridLayoutSpies.cycleTileSize.mockImplementation(actual.cycleTileSize);
  return {
    ...actual,
    moveTileKeyboard: gridLayoutSpies.moveTileKeyboard,
    cycleTileSize: gridLayoutSpies.cycleTileSize,
  };
});

import { useBoardEdit, layoutsEqual } from "../../components/home/useBoardEdit";
import { buildDefaultLg } from "../../components/home/gridLayout";

/** Wraps renderHook's tree in a real React.StrictMode, for tests that need to
 * observe StrictMode's double-invoke of setState updater functions. */
const strictModeWrapper = ({ children }: { children?: ReactNode }) =>
  createElement(StrictMode, null, children);

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const COMPANY_B = "22222222-2222-2222-2222-222222222222";

describe("layoutsEqual", () => {
  it("is true for identical arrays", () => {
    const a: HomeBoardLayoutItem[] = [{ i: "budget", x: 0, y: 0, w: 1, h: 1 }];
    expect(layoutsEqual(a, [...a])).toBe(true);
  });

  it("is true regardless of item order", () => {
    const a: HomeBoardLayoutItem[] = [
      { i: "budget", x: 0, y: 0, w: 1, h: 1 },
      { i: "agents-now", x: 1, y: 0, w: 1, h: 1 },
    ];
    expect(layoutsEqual(a, [a[1]!, a[0]!])).toBe(true);
  });

  it("is false when a position differs", () => {
    const a: HomeBoardLayoutItem[] = [{ i: "budget", x: 0, y: 0, w: 1, h: 1 }];
    const b: HomeBoardLayoutItem[] = [{ i: "budget", x: 1, y: 0, w: 1, h: 1 }];
    expect(layoutsEqual(a, b)).toBe(false);
  });

  it("is false when a size differs", () => {
    const a: HomeBoardLayoutItem[] = [{ i: "budget", x: 0, y: 0, w: 1, h: 1 }];
    const b: HomeBoardLayoutItem[] = [{ i: "budget", x: 0, y: 0, w: 2, h: 1 }];
    expect(layoutsEqual(a, b)).toBe(false);
  });

  it("is false when the item sets differ in length", () => {
    const a: HomeBoardLayoutItem[] = [{ i: "budget", x: 0, y: 0, w: 1, h: 1 }];
    const b: HomeBoardLayoutItem[] = [...a, { i: "agents-now", x: 1, y: 0, w: 1, h: 1 }];
    expect(layoutsEqual(a, b)).toBe(false);
  });
});

describe("useBoardEdit", () => {
  beforeEach(() => {
    mocks.layout = null;
    mocks.isSaving = false;
    mocks.isResetting = false;
    mocks.saveAsync.mockReset().mockResolvedValue({ layout: [], schemaVersion: 1 });
    mocks.reset.mockReset();
    mocks.resetError = null;
    gridLayoutSpies.moveTileKeyboard.mockClear();
    gridLayoutSpies.cycleTileSize.mockClear();
  });

  it("is not editing by default and renders the computed (role-default) lg", () => {
    const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
    expect(result.current.editing).toBe(false);
    expect(result.current.dirty).toBe(false);
    expect(result.current.lg).toEqual(buildDefaultLg("founder"));
  });

  it("startEdit snapshots the current lg as both draft and baseline (not dirty immediately)", () => {
    const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
    act(() => result.current.startEdit());
    expect(result.current.editing).toBe(true);
    expect(result.current.dirty).toBe(false);
    expect(result.current.lg).toEqual(buildDefaultLg("founder"));
  });

  describe("onLayoutChange gating", () => {
    it("is ignored entirely before editing starts", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      const before = result.current.lg;
      act(() => {
        result.current.onLayoutChange([], { lg: [{ i: "budget", x: 3, y: 3, w: 1, h: 1 }] });
      });
      expect(result.current.lg).toEqual(before);
      expect(result.current.dirty).toBe(false);
    });

    it("ignores the first call after startEdit (RGL's mount/sync echo) even if it looks different from baseline", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());
      const baseline = result.current.lg;
      const spuriousDifferent = [{ i: "budget", x: 3, y: 3, w: 1, h: 1 }];

      act(() => {
        result.current.onLayoutChange([], { lg: spuriousDifferent });
      });

      expect(result.current.lg).toEqual(baseline);
      expect(result.current.dirty).toBe(false);
    });

    it("a later call equal to baseline (spurious echo) does not dirty the draft", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());
      const baseline = result.current.lg;

      act(() => {
        result.current.onLayoutChange([], { lg: baseline }); // 1st call -> consumed as init echo
      });
      act(() => {
        result.current.onLayoutChange([], { lg: baseline }); // 2nd call -> equals baseline
      });

      expect(result.current.dirty).toBe(false);
    });

    it("a real change (differs from baseline) after the init echo dirties the draft", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());
      const baseline = result.current.lg;

      act(() => {
        result.current.onLayoutChange([], { lg: baseline }); // consume init echo
      });
      const moved = baseline.map((item, idx) => (idx === 0 ? { ...item, x: item.x + 1 } : item));
      act(() => {
        result.current.onLayoutChange([], { lg: moved });
      });

      expect(result.current.dirty).toBe(true);
      expect(result.current.lg).toEqual(moved);
    });

    it("is ignored while the active breakpoint is not lg", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());
      const baseline = result.current.lg;
      act(() => {
        result.current.onLayoutChange([], { lg: baseline }); // consume init echo
        result.current.onBreakpointChange("md", 2);
      });

      const moved = [{ i: baseline[0]!.i, x: 9, y: 9, w: 1, h: 1 }];
      act(() => {
        result.current.onLayoutChange([], { lg: moved });
      });

      expect(result.current.dirty).toBe(false);
      expect(result.current.lg).toEqual(baseline);
    });
  });

  describe("activeBreakpoint (Task D1 — edit is lg-only)", () => {
    it("defaults to lg", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      expect(result.current.activeBreakpoint).toBe("lg");
    });

    it("tracks onBreakpointChange", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.onBreakpointChange("sm", 1));
      expect(result.current.activeBreakpoint).toBe("sm");

      act(() => result.current.onBreakpointChange("lg", 4));
      expect(result.current.activeBreakpoint).toBe("lg");
    });
  });

  describe("onResizeStop", () => {
    it("snaps the resized item to the nearest allowed size before committing to the draft", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());

      // agents-now only allows [{w:1,h:1},{w:2,h:1}] — a raw resize to
      // {w:2,h:2} must snap to the nearest, {w:2,h:1}.
      const rawResized = result.current.lg.map((item) =>
        item.i === "agents-now" ? { ...item, w: 2, h: 2 } : item,
      );
      const newItem = rawResized.find((item) => item.i === "agents-now")!;

      act(() => {
        result.current.onResizeStop(rawResized, null, newItem, null, new Event("mouseup"), null);
      });

      const resized = result.current.lg.find((item) => item.i === "agents-now")!;
      expect({ w: resized.w, h: resized.h }).toEqual({ w: 2, h: 1 });
      expect(result.current.dirty).toBe(true);
    });

    it("is ignored before editing starts", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      const before = result.current.lg;
      const newItem = { i: "agents-now", x: 0, y: 0, w: 2, h: 2 };
      act(() => {
        result.current.onResizeStop([newItem, ...before.filter((i) => i.i !== "agents-now")], null, newItem, null, new Event("mouseup"), null);
      });
      expect(result.current.lg).toEqual(before);
    });
  });

  // [P1] Resize snap is clobbered by RGL's post-resize onLayoutChange: RGL
  // fires onLayoutChange synchronously right after onResizeStop, with its
  // OWN internal layout state — which still reflects the raw, un-snapped
  // resize target, not the snap onResizeStop already computed. Before the
  // fix, onLayoutChange's setDraft(rawLg) unconditionally overwrote the
  // snap, leaving the draft holding a disallowed {w,h} the server validator
  // rejects (400 on save, and Retry just re-sends the same bad draft
  // forever). The fix clamps every item to nearestAllowedSize in
  // onLayoutChange BEFORE the baseline-diff/setDraft, and again
  // (defense-in-depth) in attemptSave before saveAsync.
  describe("onLayoutChange clamps disallowed sizes (P1 — RGL raw-emit clobber)", () => {
    it("keeps the onResizeStop snap when RGL's own onLayoutChange fires next with the RAW un-snapped layout", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());
      const baseline = result.current.lg;
      act(() => {
        result.current.onLayoutChange([], { lg: baseline }); // consume the init echo
      });

      // Real RGL order: onResizeStop fires first with the resize (agents-now
      // dragged to a disallowed {w:2,h:2}; allowedSizes are only
      // [{w:1,h:1},{w:2,h:1}]) and snaps it...
      const rawResized = baseline.map((item) =>
        item.i === "agents-now" ? { ...item, w: 2, h: 2 } : item,
      );
      const newItem = rawResized.find((item) => item.i === "agents-now")!;
      act(() => {
        result.current.onResizeStop(rawResized, null, newItem, null, new Event("mouseup"), null);
      });
      expect(result.current.lg.find((i) => i.i === "agents-now")).toMatchObject({ w: 2, h: 1 });

      // ...then RGL synchronously fires onLayoutChange with ITS OWN raw
      // internal layout (still {w:2,h:2} for agents-now) — this must NOT
      // clobber the snap.
      act(() => {
        result.current.onLayoutChange(rawResized, { lg: rawResized });
      });

      const afterLayoutChange = result.current.lg.find((i) => i.i === "agents-now")!;
      expect({ w: afterLayoutChange.w, h: afterLayoutChange.h }).toEqual({ w: 2, h: 1 });
      expect(result.current.dirty).toBe(true);
    });

    it("clamps a raw disallowed size from onLayoutChange even with no prior onResizeStop call", () => {
      // Guards against relying SOLELY on onResizeStop's own snap — the fix
      // must hold regardless of which RGL callback produced the disallowed
      // size.
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());
      const baseline = result.current.lg;
      act(() => {
        result.current.onLayoutChange([], { lg: baseline }); // consume the init echo
      });

      const rawLg = baseline.map((item) =>
        item.i === "agents-now" ? { ...item, w: 2, h: 2 } : item,
      );
      act(() => {
        result.current.onLayoutChange(rawLg, { lg: rawLg });
      });

      const agentsNow = result.current.lg.find((i) => i.i === "agents-now")!;
      expect({ w: agentsNow.w, h: agentsNow.h }).toEqual({ w: 2, h: 1 });
    });

    it("attemptSave (exitEdit) sends only allowed sizes — defense-in-depth even for an item onResizeStop's own snap doesn't touch", async () => {
      // onResizeStop's `next` mapping only snaps the item actually being
      // resized (newItem.i); every OTHER item in the same `layout` array
      // passes through unchanged. Simulate a bogus size landing on an
      // unrelated widget (budget) via that path, with no follow-up
      // onLayoutChange to clean it up, and prove attemptSave clamps it
      // anyway before the payload reaches saveAsync.
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());
      const baseline = result.current.lg;

      const bogusLayout = baseline.map((item) => {
        if (item.i === "agents-now") return { ...item, w: 2, h: 2 }; // being resized
        if (item.i === "budget") return { ...item, w: 3, h: 3 }; // bogus — not an allowed budget size
        return item;
      });
      const newItem = bogusLayout.find((item) => item.i === "agents-now")!;
      act(() => {
        result.current.onResizeStop(bogusLayout, null, newItem, null, new Event("mouseup"), null);
      });
      // Sanity: budget's bogus size DID make it into the draft — proves this
      // test actually exercises the gap (onResizeStop alone doesn't clamp
      // items other than the one being resized).
      expect(result.current.lg.find((i) => i.i === "budget")).toMatchObject({ w: 3, h: 3 });

      await act(async () => {
        result.current.exitEdit();
      });

      expect(mocks.saveAsync).toHaveBeenCalledTimes(1);
      const [savedLayout] = mocks.saveAsync.mock.calls[0]! as [HomeBoardLayoutItem[]];
      const savedBudget = savedLayout.find((i) => i.i === "budget")!;
      // budget's allowedSizes are [{w:1,h:1},{w:2,h:1}]; nearest to {w:3,h:3}
      // is {w:2,h:1} (squared distance 1+4=5 vs {w:1,h:1}'s 4+4=8).
      expect({ w: savedBudget.w, h: savedBudget.h }).toEqual({ w: 2, h: 1 });
      const savedAgentsNow = savedLayout.find((i) => i.i === "agents-now")!;
      expect({ w: savedAgentsNow.w, h: savedAgentsNow.h }).toEqual({ w: 2, h: 1 });
    });

    it("a drag (x/y only, size unchanged) through onLayoutChange is unaffected by the clamp", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());
      const baseline = result.current.lg;
      act(() => {
        result.current.onLayoutChange([], { lg: baseline }); // consume the init echo
      });

      const dragged = baseline.map((item, idx) => (idx === 0 ? { ...item, x: item.x + 1 } : item));
      act(() => {
        result.current.onLayoutChange(dragged, { lg: dragged });
      });

      expect(result.current.lg).toEqual(dragged);
      expect(result.current.dirty).toBe(true);
    });
  });

  describe("removeWidget / addWidget", () => {
    it("removeWidget drops the item from the draft and dirties it", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());
      const before = result.current.lg.length;

      act(() => result.current.removeWidget("budget"));

      expect(result.current.lg).toHaveLength(before - 1);
      expect(result.current.lg.some((item) => item.i === "budget")).toBe(false);
      expect(result.current.dirty).toBe(true);
    });

    it("addWidget appends a widget missing from the draft at its registry defaultSize", () => {
      mocks.layout = [{ i: "budget", x: 0, y: 0, w: 1, h: 1 }];
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());

      act(() => result.current.addWidget("agents-now"));

      const added = result.current.lg.find((item) => item.i === "agents-now");
      expect(added).toBeDefined();
      expect({ w: added!.w, h: added!.h }).toEqual({ w: 1, h: 1 }); // agents-now defaultSize
      expect(result.current.lg).toHaveLength(2);
      expect(result.current.dirty).toBe(true);
    });

    it("addWidget is a no-op for a widget already on the board", () => {
      mocks.layout = [{ i: "budget", x: 0, y: 0, w: 1, h: 1 }];
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());

      act(() => result.current.addWidget("budget"));

      expect(result.current.lg).toHaveLength(1);
    });

    it("removeWidget/addWidget are no-ops before editing starts", () => {
      mocks.layout = [{ i: "budget", x: 0, y: 0, w: 1, h: 1 }];
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));

      act(() => {
        result.current.removeWidget("budget");
        result.current.addWidget("agents-now");
      });

      expect(result.current.lg).toEqual([{ i: "budget", x: 0, y: 0, w: 1, h: 1 }]);
    });
  });

  // Plan 7 Task 3: the view-mode "Add widget" entry point (the customize
  // dropdown's submenu, reachable before Rearrange has ever been clicked).
  describe("addWidgetAndEdit (Task 3 — view-mode add-widget entry point)", () => {
    it("enters edit mode, appends the widget at its registry defaultSize, and is dirty — callable while NOT already editing", () => {
      mocks.layout = [{ i: "budget", x: 0, y: 0, w: 1, h: 1 }];
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      expect(result.current.editing).toBe(false);

      act(() => result.current.addWidgetAndEdit("agents-now"));

      expect(result.current.editing).toBe(true);
      const added = result.current.lg.find((item) => item.i === "agents-now");
      expect(added).toBeDefined();
      expect({ w: added!.w, h: added!.h }).toEqual({ w: 1, h: 1 }); // agents-now defaultSize
      expect(result.current.lg).toHaveLength(2);
      expect(result.current.dirty).toBe(true);
    });

    it("is a no-op while a save is in flight (mirrors startEdit's own isSaving guard)", () => {
      const { result, rerender } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      mocks.isSaving = true;
      rerender();

      act(() => result.current.addWidgetAndEdit("agents-now"));

      expect(result.current.editing).toBe(false);
    });

    it("is a no-op while a reset is in flight (Codex P2 — isResetting guard stops a stale draft undoing the reset)", () => {
      mocks.layout = [{ i: "budget", x: 0, y: 0, w: 1, h: 1 }];
      const { result, rerender } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      const before = result.current.lg;
      mocks.isResetting = true;
      rerender();

      act(() => result.current.addWidgetAndEdit("agents-now"));

      expect(result.current.editing).toBe(false);
      expect(result.current.lg).toEqual(before);
    });

    it("is a no-op for an unrecognized widget key (defensive, mirrors addWidget's own guard)", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      const before = result.current.lg;

      act(() => result.current.addWidgetAndEdit("not-a-real-widget" as never));

      expect(result.current.editing).toBe(false);
      expect(result.current.lg).toEqual(before);
    });

    it("a subsequent exitEdit saves the appended widget — baseline is sourceLg (pre-add), not next, so the add is dirty", async () => {
      mocks.layout = [{ i: "budget", x: 0, y: 0, w: 1, h: 1 }];
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));

      act(() => result.current.addWidgetAndEdit("agents-now"));
      expect(result.current.dirty).toBe(true);

      await act(async () => {
        result.current.exitEdit();
      });

      expect(mocks.saveAsync).toHaveBeenCalledTimes(1);
      const [savedLayout] = mocks.saveAsync.mock.calls[0]! as [HomeBoardLayoutItem[]];
      expect(savedLayout.some((item) => item.i === "agents-now")).toBe(true);
      expect(result.current.editing).toBe(false);
      expect(result.current.dirty).toBe(false);
    });
  });

  describe("exitEdit / save-on-exit", () => {
    it("does not call save when the draft is not dirty", async () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());

      await act(async () => {
        result.current.exitEdit();
      });

      expect(mocks.saveAsync).not.toHaveBeenCalled();
      expect(result.current.editing).toBe(false);
    });

    it("calls save with the draft when dirty, and clears editing + dirty on success", async () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());
      act(() => result.current.removeWidget("budget"));
      expect(result.current.dirty).toBe(true);

      await act(async () => {
        result.current.exitEdit();
      });

      expect(mocks.saveAsync).toHaveBeenCalledTimes(1);
      const [savedLayout] = mocks.saveAsync.mock.calls[0]!;
      expect((savedLayout as HomeBoardLayoutItem[]).some((item) => item.i === "budget")).toBe(false);
      expect(result.current.editing).toBe(false);
      expect(result.current.dirty).toBe(false);
    });

    it("a failed save keeps editing + dirty and exposes saveError; retry re-attempts and can succeed", async () => {
      mocks.saveAsync.mockRejectedValueOnce(new Error("network down"));
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());
      act(() => result.current.removeWidget("budget"));

      await act(async () => {
        result.current.exitEdit();
      });

      expect(result.current.editing).toBe(true);
      expect(result.current.dirty).toBe(true);
      expect(result.current.saveError).toBeTruthy();

      // Retry re-attempts the same draft; the mock now resolves (queued
      // rejection was consumed above), so it should succeed this time.
      await act(async () => {
        result.current.retrySave();
      });

      expect(mocks.saveAsync).toHaveBeenCalledTimes(2);
      expect(result.current.editing).toBe(false);
      expect(result.current.dirty).toBe(false);
      expect(result.current.saveError).toBeFalsy();
    });
  });

  // Plan 4 Task 5: the ONE genuine gap found in this file — startEdit/
  // exitEdit(attemptSave)/resetBoard are all individually guarded by
  // `isSaving` in the source (see useBoardEdit.ts rules 1/7 and resetBoard's
  // own `if (isSaving || isResetting) return;`), but nothing exercised that
  // guard while a save is ACTUALLY in flight (as opposed to before it starts
  // or after it settles). The other three cases this task asked for —
  // "failed save keeps dirty+editing+retrySave", "retry succeeds", and
  // "refetch-while-editing doesn't clobber a dirty draft" — are already
  // covered above (see "a failed save keeps editing..." in this describe,
  // and the "background refetch vs a dirty draft" describe below) and are
  // intentionally NOT duplicated here.
  describe("save-in-flight guards (isSaving)", () => {
    it("exitEdit/startEdit/resetBoard all no-op while a save is genuinely in flight — no second save, no re-entry", () => {
      const { result, rerender } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());
      act(() => result.current.removeWidget("budget"));
      expect(result.current.dirty).toBe(true);
      const draftWhileSaving = result.current.lg;

      // Simulate the underlying mutation now being in flight — this is the
      // window between saveAsync's call and its resolution that a single
      // exitEdit()-then-await-resolve test never observes.
      mocks.isSaving = true;
      rerender();

      act(() => result.current.exitEdit()); // attemptSave's `if (isSaving) return;` guard
      expect(mocks.saveAsync).not.toHaveBeenCalled();
      expect(result.current.editing).toBe(true); // exit was swallowed, not applied
      expect(result.current.lg).toEqual(draftWhileSaving); // draft untouched

      act(() => result.current.startEdit()); // startEdit's own `if (isSaving) return;` guard
      expect(result.current.editing).toBe(true);
      expect(result.current.dirty).toBe(true); // re-entry did not reset the draft/baseline
      expect(result.current.lg).toEqual(draftWhileSaving);

      act(() => result.current.resetBoard()); // resetBoard's `if (isSaving || isResetting) return;` guard
      expect(mocks.reset).not.toHaveBeenCalled();
      expect(result.current.lg).toEqual(draftWhileSaving);

      // retrySave is the exact same guarded attemptSave as exitEdit.
      act(() => result.current.retrySave());
      expect(mocks.saveAsync).not.toHaveBeenCalled();
    });

    it("resetBoard also no-ops while a reset is already in flight (isResetting)", () => {
      const { result, rerender } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());

      mocks.isResetting = true;
      rerender();

      act(() => result.current.resetBoard());
      expect(mocks.reset).not.toHaveBeenCalled();
      expect(result.current.editing).toBe(true); // still editing — reset was a no-op, not a crash
    });

    // [P2] Reset-vs-save race: attemptSave used to guard only `isSaving`, not
    // `isResetting` — a Reset (DELETE) in flight followed by an edit + Done
    // would fire a concurrent PATCH against the same layout row, racing the
    // delete non-deterministically. This is the OTHER half of that guard
    // (resetBoard's own isSaving/isResetting guard is already covered above
    // and in "resetBoard also no-ops...").
    it("attemptSave (exitEdit/retrySave) also no-ops while a reset is in flight (isResetting) — no concurrent PATCH during a DELETE", async () => {
      const { result, rerender } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());
      act(() => result.current.removeWidget("budget"));
      expect(result.current.dirty).toBe(true);
      const draftWhileResetting = result.current.lg;

      // Simulate a reset now in flight (e.g. triggered moments earlier from
      // the Add-widget tray) while this edit session is still dirty.
      mocks.isResetting = true;
      rerender();

      await act(async () => {
        result.current.exitEdit();
      });
      expect(mocks.saveAsync).not.toHaveBeenCalled();
      expect(result.current.editing).toBe(true); // exit was swallowed, not applied
      expect(result.current.dirty).toBe(true);
      expect(result.current.lg).toEqual(draftWhileResetting); // draft untouched

      // retrySave is the exact same guarded attemptSave.
      await act(async () => {
        result.current.retrySave();
      });
      expect(mocks.saveAsync).not.toHaveBeenCalled();
    });
  });

  describe("resetBoard", () => {
    it("calls the reset mutation, falls back to the role default, and marks the draft clean", () => {
      mocks.layout = [{ i: "budget", x: 0, y: 0, w: 1, h: 1 }];
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());
      act(() => result.current.removeWidget("budget"));
      expect(result.current.dirty).toBe(true);

      act(() => result.current.resetBoard());

      expect(mocks.reset).toHaveBeenCalledTimes(1);
      expect(result.current.lg).toEqual(buildDefaultLg("founder"));
      expect(result.current.dirty).toBe(false);
    });

    it("a subsequent exitEdit does not re-save (no delete-then-upsert race)", async () => {
      mocks.layout = [{ i: "budget", x: 0, y: 0, w: 1, h: 1 }];
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());

      act(() => result.current.resetBoard());
      expect(result.current.dirty).toBe(false);

      await act(async () => {
        result.current.exitEdit();
      });

      expect(mocks.saveAsync).not.toHaveBeenCalled();
      expect(result.current.editing).toBe(false);
    });

    // View-mode Reset (Plan 7 Task 3): HomeBoardControls' "Reset to default"
    // menu item is reachable from the NOT-editing dropdown — its confirm
    // dialog calls `resetBoard()` directly, with `startEdit()` never called
    // first. Every other resetBoard test above enters edit mode first; this
    // is the one genuinely different call shape.
    it("called directly in view mode (no prior startEdit) still fires the reset mutation and converges lg to the role default", () => {
      // A custom single-widget saved layout — clearly not the 8-widget
      // founder default — so "converges to the default" is a meaningful
      // assertion, not trivially true from the start.
      mocks.layout = [{ i: "budget", x: 0, y: 0, w: 1, h: 1 }];
      const { result, rerender } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      expect(result.current.editing).toBe(false);
      expect(result.current.lg).toEqual(mocks.layout);

      act(() => result.current.resetBoard());

      expect(mocks.reset).toHaveBeenCalledTimes(1);
      expect(result.current.editing).toBe(false); // resetBoard doesn't itself enter edit mode

      // While still not editing, `lg` always tracks `sourceLg` (draft is
      // ignored) — so the board only visibly converges once the DELETE's
      // success invalidates + refetches the underlying layout query, which
      // resolves it to null (same mechanism the "background refetch" tests
      // above simulate via rerender after mutating the mock).
      mocks.layout = null;
      act(() => rerender());

      expect(result.current.lg).toEqual(buildDefaultLg("founder"));
      expect(result.current.editing).toBe(false);
    });
  });

  // [P2] Reset failure was silent: useBoardEdit never threaded
  // useHomeBoardLayout's `resetError` through at all, so HomeBoardControls
  // had nothing to render on a failed Reset (only saveError was ever
  // surfaced). This just proves the wiring at the hook level; HomeBoard.
  // test.tsx covers the rendered "Couldn't reset" + Retry affordance.
  describe("resetError (P2 — reset failure was silently dropped)", () => {
    it("is null by default", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      expect(result.current.resetError).toBeFalsy();
    });

    it("exposes the underlying reset mutation's error", () => {
      mocks.resetError = new Error("delete failed");
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      expect(result.current.resetError).toBeTruthy();
    });
  });

  // [P2] Dirty draft lost on navigate-away: Home's save-on-exit discipline
  // only ever fires from Done (attemptSave) — there was no flush at all if
  // the user navigated away from Home mid-edit with unsaved changes (a route
  // change unmounts Dashboard, and useBoardEdit with it). The fix is a
  // best-effort, fire-and-forget saveAsync on unmount while editing && dirty.
  describe("unmount-while-dirty flush (P2 — no lost edits on navigate-away)", () => {
    it("fires a best-effort save when unmounting while editing with a dirty draft", () => {
      const { result, unmount } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());
      act(() => result.current.removeWidget("budget"));
      expect(result.current.dirty).toBe(true);
      const draftAtUnmount = result.current.lg;

      unmount();

      expect(mocks.saveAsync).toHaveBeenCalledTimes(1);
      const [savedLayout] = mocks.saveAsync.mock.calls[0]!;
      expect(savedLayout).toEqual(draftAtUnmount);
    });

    it("clamps disallowed sizes in the unmount flush too (same defense-in-depth as attemptSave)", () => {
      const { result, unmount } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());
      const baseline = result.current.lg;
      act(() => {
        result.current.onLayoutChange([], { lg: baseline }); // consume the init echo
      });
      const bogusLayout = baseline.map((item) =>
        item.i === "agents-now" ? { ...item, w: 2, h: 2 } : item,
      );
      const newItem = bogusLayout.find((item) => item.i === "agents-now")!;
      act(() => {
        // onResizeStop alone (no follow-up onLayoutChange) so the draft's
        // OTHER items stay whatever onResizeStop leaves them as — not
        // exercised further here, this test only cares about the resized
        // item's own clamp reaching the unmount flush.
        result.current.onResizeStop(bogusLayout, null, newItem, null, new Event("mouseup"), null);
      });

      unmount();

      expect(mocks.saveAsync).toHaveBeenCalledTimes(1);
      const [savedLayout] = mocks.saveAsync.mock.calls[0]! as [HomeBoardLayoutItem[]];
      const savedAgentsNow = savedLayout.find((i) => i.i === "agents-now")!;
      expect({ w: savedAgentsNow.w, h: savedAgentsNow.h }).toEqual({ w: 2, h: 1 });
    });

    it("does not save on unmount when not editing", () => {
      const { unmount } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      unmount();
      expect(mocks.saveAsync).not.toHaveBeenCalled();
    });

    it("does not save on unmount when editing but the draft is clean (not dirty)", () => {
      const { result, unmount } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());
      expect(result.current.dirty).toBe(false);

      unmount();

      expect(mocks.saveAsync).not.toHaveBeenCalled();
    });
  });

  // [P2] setAnnouncement was called from INSIDE moveWidget/cycleWidgetSize's
  // setDraft(prev => ...) functional updater — an impure side effect. React
  // Strict Mode double-invokes updater functions specifically to catch this
  // class of bug. The fix moves the layout computation out of the updater
  // (reads `draft` directly, calls setDraft with a plain value) so there's no
  // updater slot left for StrictMode to double-invoke. Proven here by
  // spying on the pure helper each one delegates to (moveTileKeyboard /
  // cycleTileSize) — before the fix, StrictMode ran it twice per call
  // (it lived inside the updater); after the fix, exactly once (it runs in
  // the plain callback body).
  describe("moveWidget/cycleWidgetSize keep setDraft updaters pure (P2 — StrictMode double-invoke)", () => {
    it("moveTileKeyboard runs exactly once per moveWidget call under real StrictMode", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"), {
        wrapper: strictModeWrapper,
      });
      act(() => result.current.startEdit());
      gridLayoutSpies.moveTileKeyboard.mockClear();

      act(() => result.current.moveWidget("budget", 1, 0));

      expect(gridLayoutSpies.moveTileKeyboard).toHaveBeenCalledTimes(1);
      expect(result.current.announcement).toMatch(/Budget/);
    });

    it("cycleTileSize runs exactly once per cycleWidgetSize call under real StrictMode", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"), {
        wrapper: strictModeWrapper,
      });
      act(() => result.current.startEdit());
      gridLayoutSpies.cycleTileSize.mockClear();

      act(() => result.current.cycleWidgetSize("agents-now"));

      expect(gridLayoutSpies.cycleTileSize).toHaveBeenCalledTimes(1);
      expect(result.current.announcement).toMatch(/Agents working now/);
    });
  });

  describe("background refetch vs a dirty draft", () => {
    it("does not clobber a dirty draft when the underlying saved layout changes", () => {
      const { result, rerender } = renderHook(
        ({ companyId, role }) => useBoardEdit(companyId, role),
        { initialProps: { companyId: COMPANY_A, role: "founder" as const } },
      );
      act(() => result.current.startEdit());
      act(() => result.current.removeWidget("budget"));
      expect(result.current.dirty).toBe(true);
      const dirtyDraft = result.current.lg;

      // Simulate a background refetch changing the saved layout underneath us.
      mocks.layout = [{ i: "my-tasks", x: 0, y: 0, w: 2, h: 1 }];
      rerender({ companyId: COMPANY_A, role: "founder" });

      expect(result.current.lg).toEqual(dirtyDraft);
      expect(result.current.dirty).toBe(true);
    });

    it("adopts the refreshed source when the draft is clean (not dirty)", () => {
      const { result, rerender } = renderHook(
        ({ companyId, role }) => useBoardEdit(companyId, role),
        { initialProps: { companyId: COMPANY_A, role: "founder" as const } },
      );
      act(() => result.current.startEdit());
      expect(result.current.dirty).toBe(false);

      const refreshed: HomeBoardLayoutItem[] = [{ i: "my-tasks", x: 0, y: 0, w: 2, h: 1 }];
      mocks.layout = refreshed;
      act(() => rerender({ companyId: COMPANY_A, role: "founder" }));

      expect(result.current.lg).toEqual(refreshed);
      expect(result.current.dirty).toBe(false);
    });
  });

  describe("moveWidget (Task D2 — keyboard nudge)", () => {
    it("moves the widget in the draft by (dx,dy) and dirties it", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());
      const before = result.current.lg.find((item) => item.i === "budget")!;

      act(() => result.current.moveWidget("budget", 1, 0));

      const after = result.current.lg.find((item) => item.i === "budget")!;
      expect(after).toEqual({ ...before, x: before.x + 1 });
      expect(result.current.dirty).toBe(true);
    });

    it("sets an announcement naming the widget and its new position", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());
      act(() => result.current.moveWidget("budget", 1, 0));
      expect(result.current.announcement).toMatch(/Budget/);
    });

    it("announces the tile's position in the resulting draft (announce == land) for a vertical/cross-row move", () => {
      // Regression guard for the a11y bug: agents-now (w:1) above the wider
      // action-queue (w:2). A downward nudge cannot stay at the raw target row
      // — the grid's vertical compaction (compactor={verticalCompactor}) swaps
      // the two — so the announcement must name where agents-now ACTUALLY lands
      // in the committed draft, not the pre-compaction row it never occupies.
      mocks.layout = [
        { i: "agents-now", x: 0, y: 0, w: 1, h: 1 },
        { i: "action-queue", x: 0, y: 1, w: 2, h: 1 },
      ];
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());

      act(() => result.current.moveWidget("agents-now", 0, 2));

      const moved = result.current.lg.find((item) => item.i === "agents-now")!;
      // The move genuinely stuck at the compacted row (compaction did not
      // revert it to its origin y:0), so this isn't a vacuous "announce matches
      // because nothing moved" assertion.
      expect(moved.y).toBe(1);
      // announce == land: the column/row named in the announcement equals the
      // tile's real position in the committed lg draft.
      expect(result.current.announcement).toBe(
        `Agents working now moved to column ${moved.x + 1}, row ${moved.y + 1}`,
      );
    });

    it("is a no-op (including no announcement) when blocked at bounds", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());
      const before = result.current.lg;
      // Plan 7 Task 5: "agents-now" sits at the founder default's x:0
      // (leftmost column, sharing the final row with budget at x:1 — see
      // defaultLayout.ts's packing comment) — moving left is blocked.
      expect(before.find((item) => item.i === "agents-now")!.x).toBe(0);

      act(() => result.current.moveWidget("agents-now", -1, 0));

      expect(result.current.lg).toEqual(before);
      expect(result.current.announcement).toBe("");
    });

    it("is a no-op before editing starts", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      const before = result.current.lg;
      act(() => result.current.moveWidget("budget", 1, 0));
      expect(result.current.lg).toEqual(before);
    });

    it("is ignored while the active breakpoint is not lg", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());
      act(() => result.current.onBreakpointChange("sm", 1));
      const before = result.current.lg;

      act(() => result.current.moveWidget("budget", 1, 0));

      expect(result.current.lg).toEqual(before);
    });
  });

  describe("cycleWidgetSize (Task D2 — keyboard resize)", () => {
    it("cycles the widget's size in the draft and dirties it", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());

      act(() => result.current.cycleWidgetSize("agents-now"));

      const item = result.current.lg.find((entry) => entry.i === "agents-now")!;
      expect({ w: item.w, h: item.h }).toEqual({ w: 2, h: 1 });
      expect(result.current.dirty).toBe(true);
    });

    it("sets an announcement naming the widget and its new size", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());
      act(() => result.current.cycleWidgetSize("agents-now"));
      expect(result.current.announcement).toMatch(/Agents working now/);
    });

    it("is a no-op before editing starts", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      const before = result.current.lg;
      act(() => result.current.cycleWidgetSize("agents-now"));
      expect(result.current.lg).toEqual(before);
    });

    it("is ignored while the active breakpoint is not lg", () => {
      const { result } = renderHook(() => useBoardEdit(COMPANY_A, "founder"));
      act(() => result.current.startEdit());
      act(() => result.current.onBreakpointChange("md", 2));
      const before = result.current.lg;

      act(() => result.current.cycleWidgetSize("agents-now"));

      expect(result.current.lg).toEqual(before);
    });
  });

  describe("company scoping", () => {
    it("discards the draft when companyId changes mid-edit (never saves the old company's layout)", async () => {
      const { result, rerender } = renderHook(
        ({ companyId, role }) => useBoardEdit(companyId, role),
        { initialProps: { companyId: COMPANY_A, role: "founder" as const } },
      );
      act(() => result.current.startEdit());
      act(() => result.current.removeWidget("budget"));
      expect(result.current.dirty).toBe(true);

      act(() => {
        rerender({ companyId: COMPANY_B, role: "founder" });
      });

      expect(result.current.editing).toBe(false);
      expect(result.current.dirty).toBe(false);

      // A stray exitEdit call after the switch must never fire a save.
      await act(async () => {
        result.current.exitEdit();
      });
      expect(mocks.saveAsync).not.toHaveBeenCalled();
    });
  });
});
