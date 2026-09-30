import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HomeBoardLayoutItem, UserRole } from "@armyofagents/shared";
import { HOME_BOARD_LG_COLS } from "@armyofagents/shared";
import type { EventCallback, Layout, ResponsiveLayouts } from "react-grid-layout";
import { useHomeBoardLayout } from "../../hooks/useHomeBoardLayout";
import { buildDefaultLg, cycleTileSize, moveTileKeyboard, nearestAllowedSize, reconcileLg } from "./gridLayout";
import { getWidget } from "./widgets/registry";
import type { WidgetKey } from "./widgets/types";

/**
 * Value-equality for two lg arrays: same set of {i,x,y,w,h}, independent of
 * array order (RGL's own layout arrays aren't guaranteed to preserve our
 * insertion order). Exported for unit tests and reused as the core
 * "differs from baseline" gate throughout this hook.
 */
export function layoutsEqual(
  a: readonly HomeBoardLayoutItem[],
  b: readonly HomeBoardLayoutItem[],
): boolean {
  if (a.length !== b.length) return false;
  const byKey = new Map(b.map((item) => [item.i, item]));
  return a.every((itemA) => {
    const itemB = byKey.get(itemA.i);
    return (
      !!itemB &&
      itemA.x === itemB.x &&
      itemA.y === itemB.y &&
      itemA.w === itemB.w &&
      itemA.h === itemB.h
    );
  });
}

/** The lowest free row across a set of items — where a freshly-added widget lands before compaction pulls it into place. */
function bottomEdge(items: readonly HomeBoardLayoutItem[]): number {
  return items.reduce((max, item) => Math.max(max, item.y + item.h), 0);
}

/**
 * Clamp every item's `{w,h}` to its own widget's nearest allowed footprint
 * (gridLayout's nearestAllowedSize). Unknown/retired widget keys pass through
 * unchanged — membership (dropping retired keys) is reconcileLg's job, not
 * this helper's; this only guards size.
 *
 * Shared by two call sites for two different reasons:
 *  - onLayoutChange (the load-bearing fix): RGL fires onLayoutChange
 *    synchronously right after onResizeStop, with its OWN internal layout
 *    state — which still reflects the user's raw, possibly-disallowed drag
 *    target, not the snap onResizeStop already computed. Without clamping
 *    here too, that raw emit clobbers the snap and the draft can end up
 *    holding a footprint the server validator rejects (400 on save, forever,
 *    since Retry just re-sends the same bad draft). A no-op for drags, which
 *    only ever change x/y.
 *  - attemptSave (defense-in-depth): a save must never send a disallowed
 *    size regardless of how one made it into the draft — e.g. onResizeStop's
 *    own snap only touches the item actually being resized, so an unrelated
 *    item elsewhere in the same RGL layout callback could in principle carry
 *    a stale/bogus size through untouched.
 */
function clampToAllowedSizes(items: readonly HomeBoardLayoutItem[]): HomeBoardLayoutItem[] {
  return items.map((item) => {
    const def = getWidget(item.i);
    if (!def) return item;
    const size = nearestAllowedSize({ w: item.w, h: item.h }, def.allowedSizes);
    return size.w === item.w && size.h === item.h ? item : { ...item, w: size.w, h: size.h };
  });
}

export interface UseBoardEditResult {
  /** The lg to render: the draft while editing, else the computed (saved-reconciled or role-default) layout. */
  lg: HomeBoardLayoutItem[];
  editing: boolean;
  /** True when the draft differs (by value) from the baseline snapshot taken at startEdit/resetBoard. */
  dirty: boolean;
  isSaving: boolean;
  isResetting: boolean;
  saveError: unknown;
  /** Surfaces a failed Reset (the underlying DELETE mutation's error) — previously silently dropped. */
  resetError: unknown;
  /**
   * The RGL breakpoint currently in effect ("lg" | "md" | "sm"). Task D1:
   * editing is enforced lg-only — callers (HomeBoard/HomeBoardControls) gate
   * every mutating edit affordance (drag, resize, remove, add, keyboard
   * move/resize, and starting edit mode at all) on `activeBreakpoint ===
   * "lg"`, since only the lg layout is canonical/persisted; md/sm are
   * always-derived projections (see gridLayout.ts projectToBreakpoint).
   */
  activeBreakpoint: string;
  /** Latest human-readable description of a keyboard move/resize (Task D2), for an aria-live region. Empty until the first keyboard operation this edit session. */
  announcement: string;
  startEdit: () => void;
  /** Flushes: saves the draft if dirty, otherwise just closes edit mode. No-op while a save is in flight. */
  exitEdit: () => void;
  /** Re-attempts the same save after a failure. */
  retrySave: () => void;
  removeWidget: (key: WidgetKey) => void;
  addWidget: (key: WidgetKey) => void;
  /**
   * Appends a widget AND enters edit mode in one atomic action (Plan 7 Task
   * 3) — the view-mode "Add widget" entry point (the customize dropdown's
   * submenu). Unlike `addWidget`, callable while NOT already editing; see
   * this function's own implementation comment for why `addWidget` itself
   * can't be used for that (a stale-closure trap).
   */
  addWidgetAndEdit: (key: WidgetKey) => void;
  /** Deletes the persisted layout, falls back to the role default, and marks the draft clean (no re-save on exit). */
  resetBoard: () => void;
  onLayoutChange: (current: Layout, all: ResponsiveLayouts) => void;
  onBreakpointChange: (breakpoint: string, cols: number) => void;
  onResizeStop: EventCallback;
  /** Keyboard a11y (Task D2): nudge a focused tile by (dx,dy) grid cells. No-op unless editing at the lg breakpoint, or when blocked at bounds. */
  moveWidget: (key: WidgetKey, dx: number, dy: number) => void;
  /** Keyboard a11y (Task D2): step a focused tile forward through its allowedSizes (wrapping). No-op unless editing at the lg breakpoint. */
  cycleWidgetSize: (key: WidgetKey) => void;
}

/**
 * Owns Home board edit-mode state: whether we're editing, a DRAFT `lg`
 * layout separate from the persisted query, and the save-on-exit discipline
 * (Task C1). This is deliberately the ONLY place that composes
 * useHomeBoardLayout with the gridLayout reconcile/default helpers — HomeBoard
 * just consumes the result.
 *
 * The draft discipline (see plan Task C1 — encoded here exactly):
 *  1. startEdit() snapshots the current computed lg as BOTH the draft and a
 *     baseline.
 *  2. onLayoutChange is ignored unless editing && initialized &&
 *     activeBreakpoint==='lg', and only updates the draft when the new lg
 *     differs BY VALUE from the baseline — RGL fires onLayoutChange on
 *     mount/breakpoint-sync/StrictMode double-invoke, and those are not user
 *     edits. `initialized` specifically absorbs the first post-startEdit
 *     call (the mount/sync echo for this edit session) unconditionally,
 *     regardless of its value, then flips true for every call after.
 *  3. onResizeStop snaps the resized item's {w,h} to the nearest allowed
 *     footprint before committing to the draft.
 *  4. removeWidget drops an item from the draft.
 *  5. addWidget appends a widget at its defaultSize (RGL's own compactor
 *     places it once rendered).
 *  6. A background query refetch never overwrites a DIRTY draft — the query
 *     result (sourceLg) is only adopted (resyncing draft+baseline) while
 *     editing and NOT dirty, since there's nothing to lose in that case.
 *  7. exitEdit calls save(draft) immediately when dirty (not debounced).
 *     While a save OR a reset is in flight, re-entry/exit/reset are no-ops
 *     (attemptSave bails on isSaving OR isResetting — a reset's DELETE must
 *     never race a concurrent save PATCH; resetBoard bails on isSaving OR
 *     isResetting symmetrically). On failure, the draft + dirty state are
 *     kept and saveError is exposed with a retry; resetError is exposed the
 *     same way for a failed Reset. On success, editing clears and the draft
 *     resets to null (the persisted/query-derived lg takes back over). When
 *     NOT dirty, exit just closes edit mode without saving — this is what
 *     makes Reset (Task C2) safe: resetBoard marks the draft clean, so the
 *     exit that follows it does not re-upsert the layout it just asked the
 *     server to delete.
 *  8. The draft is scoped to companyId: if companyId changes while a draft
 *     exists, it's discarded unconditionally (editing/draft/baseline all
 *     reset) — a stale draft must never be saved against a new company.
 *  9. dirty = draft differs (by value) from the baseline.
 *  10. Every {w,h} written into the draft — from onLayoutChange (RGL's raw
 *      post-resize emit) or into a save payload (attemptSave, the unmount
 *      flush) — is clamped to nearestAllowedSize first, so the draft can
 *      never hold a footprint the server validator rejects regardless of
 *      which path produced it (see clampToAllowedSizes). Unmounting while
 *      editing && dirty (e.g. navigating away from Home) fires a best-effort
 *      fire-and-forget save of the draft.
 */
export function useBoardEdit(
  companyId: string | null | undefined,
  role: UserRole | null,
): UseBoardEditResult {
  const {
    layout: savedLayout,
    saveAsync,
    isSaving,
    reset: resetMutation,
    isResetting,
    resetError,
  } = useHomeBoardLayout(companyId);

  const sourceLg = useMemo(
    () => (savedLayout ? reconcileLg(savedLayout, role) : buildDefaultLg(role)),
    [savedLayout, role],
  );

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<HomeBoardLayoutItem[] | null>(null);
  const [activeBreakpoint, setActiveBreakpoint] = useState<string>("lg");
  const [initialized, setInitialized] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [announcement, setAnnouncement] = useState("");
  const baselineRef = useRef<HomeBoardLayoutItem[] | null>(null);

  const dirty =
    editing && draft !== null && baselineRef.current !== null
      ? !layoutsEqual(draft, baselineRef.current)
      : false;

  // Rule 8 — company scoping: discard the draft unconditionally when
  // companyId changes, so a stale draft can never be saved against the new
  // company (useHomeBoardLayout(companyId) itself has already switched to
  // querying/mutating the new company by this same render).
  const companyIdRef = useRef(companyId);
  useEffect(() => {
    if (companyIdRef.current === companyId) return;
    companyIdRef.current = companyId;
    setEditing(false);
    setDraft(null);
    baselineRef.current = null;
    setSaveError(null);
    setAnnouncement("");
  }, [companyId]);

  // Rule 6 — adopt a fresh source layout (e.g. a background refetch) only
  // when there's nothing to lose: editing but not dirty. A dirty draft is
  // never touched here. Gated on sourceLg's REFERENCE actually changing
  // (tracked via lastSourceLgRef) rather than merely "dirty is false right
  // now" — otherwise resetBoard's own optimistic draft (clean by
  // construction, but intentionally ahead of the still-stale sourceLg until
  // the delete's invalidation/refetch lands) would get immediately
  // overwritten back to the pre-reset value by this same effect.
  const lastSourceLgRef = useRef(sourceLg);
  useEffect(() => {
    if (lastSourceLgRef.current === sourceLg) return; // sourceLg didn't actually change
    lastSourceLgRef.current = sourceLg;
    if (!editing || dirty) return;
    setDraft(sourceLg);
    baselineRef.current = sourceLg;
  }, [editing, dirty, sourceLg]);

  // Rule 10 — unmount-while-dirty flush: navigating away from Home (route
  // change unmounts Dashboard, and this hook with it) is currently the only
  // way to lose a dirty draft with no save attempt at all — Done/exitEdit is
  // the sole other save trigger. Best-effort, not a replacement for that
  // discipline: no beforeunload/route-guard prompt, just a fire-and-forget
  // saveAsync so a stray navigation doesn't silently discard the edit. Refs
  // (kept fresh every render via the effect below, not closed over) so the
  // CLEANUP — which fires exactly once, on true unmount, since its own
  // effect has an empty dependency array — reads the LATEST editing/dirty/
  // draft/saveAsync, not whatever was current when this effect first ran.
  const editingRef = useRef(editing);
  const dirtyRef = useRef(dirty);
  const draftRef = useRef(draft);
  const saveAsyncRef = useRef(saveAsync);
  useEffect(() => {
    editingRef.current = editing;
    dirtyRef.current = dirty;
    draftRef.current = draft;
    saveAsyncRef.current = saveAsync;
  });

  useEffect(() => {
    return () => {
      if (editingRef.current && dirtyRef.current && draftRef.current) {
        // The mutation lives on the persistent QueryClient (see
        // useHomeBoardLayout) and can complete after this component has
        // unmounted — there's nothing left mounted to update on success or
        // failure, so this deliberately doesn't chain more than swallowing a
        // rejection (an unmounted Home can't show saveError or offer Retry).
        saveAsyncRef.current(clampToAllowedSizes(draftRef.current)).catch(() => {});
      }
    };
  }, []);

  const startEdit = useCallback(() => {
    if (isSaving) return; // rule 7 — no re-entry while a save is in flight
    setDraft(sourceLg);
    baselineRef.current = sourceLg;
    setInitialized(false);
    setSaveError(null);
    setAnnouncement("");
    setEditing(true);
  }, [isSaving, sourceLg]);

  const attemptSave = useCallback(() => {
    if (isSaving) return;
    // P2 fix (reset-vs-save race): a Reset (DELETE) may still be in flight —
    // saving now would fire a concurrent PATCH against the same layout row,
    // racing the delete non-deterministically. Bail out; the draft/dirty
    // state is untouched, so a later exit (once the reset settles) can
    // still flush it correctly.
    if (isResetting) return;
    if (!editing) return;
    if (!draft || !dirty) {
      // Nothing to persist — either there's no draft, or it matches the
      // baseline (including a baseline a just-completed Reset marked
      // clean). Exiting without saving here is what prevents the
      // delete-then-upsert race documented in Task C2.
      setEditing(false);
      setDraft(null);
      baselineRef.current = null;
      setSaveError(null);
      return;
    }
    // P1 defense-in-depth: never send a disallowed size, regardless of how
    // one made it into the draft (see clampToAllowedSizes' own comment).
    saveAsync(clampToAllowedSizes(draft))
      .then(() => {
        setEditing(false);
        setDraft(null);
        baselineRef.current = null;
        setSaveError(null);
      })
      .catch((err: unknown) => {
        setSaveError(err);
      });
  }, [dirty, draft, editing, isResetting, isSaving, saveAsync]);

  const exitEdit = useCallback(() => attemptSave(), [attemptSave]);
  const retrySave = useCallback(() => attemptSave(), [attemptSave]);

  const removeWidget = useCallback(
    (key: WidgetKey) => {
      if (!editing) return;
      setDraft((prev) => (prev ?? []).filter((item) => item.i !== key));
    },
    [editing],
  );

  const addWidget = useCallback(
    (key: WidgetKey) => {
      if (!editing) return;
      setDraft((prev) => {
        const current = prev ?? [];
        if (current.some((item) => item.i === key)) return current; // already on the board
        const def = getWidget(key);
        if (!def) return current; // unknown key — defensive no-op
        return [
          ...current,
          { i: key, x: 0, y: bottomEdge(current), w: def.defaultSize.w, h: def.defaultSize.h },
        ];
      });
    },
    [editing],
  );

  // Plan 7 Task 3 — view-mode "Add widget" entry point (the customize
  // dropdown's submenu, before Rearrange has ever been clicked). A naive
  // handler would try `startEdit(); addWidget(key);` in one click callback,
  // but `addWidget` is a `useCallback` closed over `editing` (dep
  // `[editing]`, see above) and guards `if (!editing) return;` — calling it
  // synchronously right after `startEdit()` in the SAME event handler still
  // reads the STALE `editing` captured when this render's closures were
  // created (false), so it silently no-ops. This action exists specifically
  // to avoid that trap: it mirrors `startEdit` FULLY (identical five
  // setters, identical order) and inlines `addWidget`'s own bottomEdge/
  // append shape for the new item, all in one body that never depends on
  // `editing` at all. Deps are `[isSaving, isResetting, sourceLg]` — NOT
  // `[editing]` —
  // precisely because depending on `editing` here would reintroduce the same
  // staleness this action exists to avoid (the whole point is to be callable
  // while `editing` is false). Baseline is set to `sourceLg` (the PRE-add
  // layout), not the freshly-built `next` — so the new widget is immediately
  // dirty and a subsequent Done actually saves it, exactly like any other
  // edit-session change.
  const addWidgetAndEdit = useCallback(
    (key: WidgetKey) => {
      // No entry while a save OR a reset is in flight. The isResetting guard
      // (Codex P2) matters for the view-mode path: without it, adding a widget
      // during a slow reset DELETE reads the PRE-reset `sourceLg` (the query
      // hasn't refetched yet) into a dirty draft; when the reset then resolves
      // and the user hits Done, attemptSave re-upserts that stale layout + the
      // new widget, silently undoing the reset they just confirmed. Mirrors
      // resetBoard/attemptSave, which already bail on isResetting.
      if (isSaving || isResetting) return;
      const def = getWidget(key);
      if (!def) return; // unknown key — defensive no-op, mirrors addWidget's own guard
      const next: HomeBoardLayoutItem[] = [
        ...sourceLg,
        { i: key, x: 0, y: bottomEdge(sourceLg), w: def.defaultSize.w, h: def.defaultSize.h },
      ];
      setDraft(next);
      baselineRef.current = sourceLg; // NOT next — so dirty is true and Done saves
      setInitialized(false);
      setSaveError(null);
      setAnnouncement("");
      setEditing(true);
    },
    [isSaving, isResetting, sourceLg],
  );

  const resetBoard = useCallback(() => {
    if (isSaving || isResetting) return;
    resetMutation();
    const next = buildDefaultLg(role);
    setDraft(next);
    baselineRef.current = next; // marks the draft clean — exit must not re-save
    setSaveError(null);
  }, [isResetting, isSaving, resetMutation, role]);

  const onBreakpointChange = useCallback((breakpoint: string) => {
    setActiveBreakpoint(breakpoint);
  }, []);

  const onLayoutChange = useCallback(
    (_current: Layout, all: ResponsiveLayouts) => {
      if (!editing || activeBreakpoint !== "lg") return;
      if (!initialized) {
        // The first onLayoutChange after startEdit is RGL's mount/breakpoint-
        // sync echo (or a StrictMode double-invoke) — never a user edit.
        // Absorb it unconditionally and start trusting the callback from the
        // next call on.
        setInitialized(true);
        return;
      }
      const baseline = baselineRef.current;
      if (!baseline) return;
      const rawLg = (all.lg ?? []) as unknown as HomeBoardLayoutItem[];
      // P1 fix: clamp BEFORE the baseline-diff comparison and before
      // setDraft — see clampToAllowedSizes' own comment for why RGL's raw
      // post-resize emit needs this, regardless of onResizeStop's snap.
      const newLg = clampToAllowedSizes(rawLg);
      if (layoutsEqual(newLg, baseline)) return; // spurious echo — never dirty on a no-op
      setDraft(newLg);
    },
    [editing, activeBreakpoint, initialized],
  );

  const onResizeStop: EventCallback = useCallback(
    (layout, _oldItem, newItem) => {
      if (!editing || activeBreakpoint !== "lg") return;
      if (!newItem) return;
      const def = getWidget(newItem.i as WidgetKey);
      if (!def) return;
      const snapped = nearestAllowedSize({ w: newItem.w, h: newItem.h }, def.allowedSizes);
      const next: HomeBoardLayoutItem[] = layout.map((item) =>
        item.i === newItem.i
          ? { i: item.i as WidgetKey, x: item.x, y: item.y, w: snapped.w, h: snapped.h }
          : { i: item.i as WidgetKey, x: item.x, y: item.y, w: item.w, h: item.h },
      );
      setDraft(next);
    },
    [editing, activeBreakpoint],
  );

  // Task D2 — keyboard a11y. Both moveWidget/cycleWidgetSize are gated
  // exactly like every other mutating edit affordance: editing AND at the lg
  // breakpoint (Task D1 — edit is lg-only). Each delegates the actual
  // move/resize-with-collision-cascade math to gridLayout.ts (pure,
  // independently unit-tested) and only sets an announcement when something
  // actually changed — a move blocked at bounds stays silent rather than
  // announcing a no-op.
  // P2 fix: neither of these calls setDraft with a functional updater
  // anymore — both read `draft` directly (already a dependency of this
  // callback) to compute `next` in a local variable, THEN call setDraft(next)
  // and setAnnouncement(...) as separate, sequential statements. Previously
  // setAnnouncement was called from INSIDE the setDraft(prev => ...) updater,
  // an impure side effect React's Strict Mode double-invokes (updater
  // functions must be pure) — harmless today only because the computation is
  // fully deterministic, but a latent landmine and against React's own
  // documented contract. Behavior is unchanged.
  const moveWidget = useCallback(
    (key: WidgetKey, dx: number, dy: number) => {
      if (!editing || activeBreakpoint !== "lg") return;
      const current = draft ?? [];
      const next = moveTileKeyboard(current, key, dx, dy, HOME_BOARD_LG_COLS);
      if (next === current) return; // blocked at bounds — no-op, no announcement
      setDraft(next);
      const def = getWidget(key);
      const moved = next.find((item) => item.i === key);
      if (def && moved) {
        setAnnouncement(`${def.title} moved to column ${moved.x + 1}, row ${moved.y + 1}`);
      }
    },
    [editing, activeBreakpoint, draft],
  );

  const cycleWidgetSize = useCallback(
    (key: WidgetKey) => {
      if (!editing || activeBreakpoint !== "lg") return;
      const def = getWidget(key);
      if (!def) return;
      const current = draft ?? [];
      const next = cycleTileSize(current, key, def.allowedSizes, HOME_BOARD_LG_COLS);
      if (next === current) return; // only one allowed size — no-op, no announcement
      setDraft(next);
      const resized = next.find((item) => item.i === key);
      if (resized) {
        setAnnouncement(`${def.title} resized to ${resized.w} by ${resized.h}`);
      }
    },
    [editing, activeBreakpoint, draft],
  );

  return {
    lg: editing && draft ? draft : sourceLg,
    editing,
    dirty,
    isSaving,
    isResetting,
    saveError,
    resetError,
    activeBreakpoint,
    announcement,
    startEdit,
    exitEdit,
    retrySave,
    removeWidget,
    addWidget,
    addWidgetAndEdit,
    resetBoard,
    onLayoutChange,
    onBreakpointChange,
    onResizeStop,
    moveWidget,
    cycleWidgetSize,
  };
}
