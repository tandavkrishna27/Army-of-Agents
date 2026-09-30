import { X } from "lucide-react";
import { Responsive, useContainerWidth, verticalCompactor } from "react-grid-layout";
import type { UserRole } from "@armyofagents/shared";
import { getWidget } from "./widgets/registry";
import { WidgetErrorBoundary } from "./WidgetErrorBoundary";
import type { UseBoardEditResult } from "./useBoardEdit";
import { projectToBreakpoint } from "./gridLayout";
import { ArrangeToolbar } from "./ArrangeToolbar";
import { cn } from "../../lib/utils";

// Native v2 RGL API (see RGL_V2_API.md) — breakpoints/cols are fixed, not
// props, since Home's board only ever has 3 tiers (lg/md/sm) and doesn't
// need to be configurable per caller.
const BREAKPOINTS = { lg: 1024, md: 640, sm: 0 };
const COLS = { lg: 4, md: 2, sm: 1 };

// CSS selector passed to dragConfig.cancel so a click on the remove button
// never gets swallowed as a drag-start by react-draggable's DraggableCore
// (which otherwise treats mousedown anywhere on the tile, other than the
// resize handle, as a potential drag).
const REMOVE_BUTTON_CANCEL_SELECTOR = ".home-board-tile-remove";

// Task D2 — keyboard a11y: arrow key -> (dx,dy) grid-cell nudge. Shift+Arrow
// (any direction) instead cycles the tile's size — direction is irrelevant
// there, it just needs to be a documented modifier+key combo.
const ARROW_KEY_DELTAS: Record<string, readonly [number, number]> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

/**
 * The Home widget board: a react-grid-layout tile grid with an edit mode
 * (Task C1). The canonical desktop (lg) layout is either the user's saved
 * layout (reconciled against the live registry) or the role default while
 * read-only; while editing it's the draft owned by useBoardEdit. md/sm are
 * always *derived* from lg at render, never persisted (Task D1).
 *
 * Task D3: the `useBoardEdit` hook is owned by the caller (Dashboard), not
 * by this component — the pinned page header (HomeBoardControls) needs the
 * SAME edit session (draft/dirty/save state) as the grid, so Dashboard
 * computes one `boardEdit` and shares it with both HomeBoardControls (header)
 * and this component (grid) as a plain prop. HomeBoard renders the grid, the
 * per-tile remove `×` button, keyboard move/resize handling (Task D2), and
 * — Plan 7 Task 3 — the floating `ArrangeToolbar` (Add widget/Reset/status/
 * Done), gated on the same `editableNow` that already freezes the tiles'
 * drag/resize/remove. The header (HomeBoardControls) itself only ever shows
 * the customize icon now — a Radix dropdown while not editing, an inert
 * disabled icon while editing — so it never reflows regardless of edit state.
 */
export function HomeBoard({
  companyId,
  role,
  boardEdit,
}: {
  companyId: string;
  role: UserRole | null;
  boardEdit: UseBoardEditResult;
}) {
  const {
    lg,
    editing,
    isSaving,
    activeBreakpoint,
    announcement,
    removeWidget,
    onLayoutChange,
    onBreakpointChange,
    onResizeStop,
    moveWidget,
    cycleWidgetSize,
  } = boardEdit;
  const { width, mounted, containerRef } = useContainerWidth();

  // Task D1: editing is enforced lg-only (the persisted layout is the
  // canonical desktop lg array — md/sm are always-derived projections, never
  // edited). `editing` alone isn't enough to gate drag/resize/remove/
  // keyboard: if the viewport shrinks below 1024px mid-edit-session
  // (activeBreakpoint flips away from "lg"), every mutating affordance
  // freezes until it's back at lg — the user can still hit "Done" (in the
  // floating ArrangeToolbar) to exit/save, they just can't keep
  // dragging/resizing/adding/nudging below desktop width.
  //
  // P2 fix: also require !isSaving. Without this, drag/resize/remove/
  // keyboard stayed live during the "Saving…" window between clicking Done
  // and the mutation settling; attemptSave's `.then` does `setDraft(null)`
  // on success, so any edit made in that window was silently discarded the
  // instant the save resolved. Freezing every mutating affordance for that
  // (usually brief) window closes the gap.
  //
  // Plan 7 Task 3 follow-up fix: this gate is deliberately NOT used to
  // decide whether the floating ArrangeToolbar mounts (see below) — an
  // earlier version of this plan gated the toolbar's mount on editableNow
  // too, which meant narrowing the window below lg mid-edit, or the brief
  // isSaving window, made the ONLY "Done"/exit affordance vanish entirely
  // (the old pre-Plan-7 HomeBoardControls kept "Done" reachable whenever
  // `editing`, regardless of breakpoint/isSaving — this restores that
  // guarantee). ArrangeToolbar's own Add widget/Reset controls still mirror
  // this exact editableNow gate (disabled, not unmounted) — only Done and
  // the toolbar's own mount are keyed on `editing` alone.
  const editableNow = editing && activeBreakpoint === "lg" && !isSaving;

  const layouts = {
    lg,
    md: projectToBreakpoint(lg, COLS.md),
    sm: projectToBreakpoint(lg, COLS.sm),
  };

  return (
    // Plan 4 Task 4 (a11y sweep): a labeled landmark so assistive tech can
    // name/jump to the widget grid as a whole, independent of the per-tile
    // labels below.
    <div role="region" aria-label="Home widget board">
      {/* Task D2 keyboard a11y: announces each keyboard move/resize. Always
          mounted (not conditionally rendered) so screen readers are already
          watching it before the first announcement ever lands. */}
      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>

      {/* Task 5: `data-home-board-editing` scopes the resize-handle visibility
          CSS in index.css — react-grid-layout's own `react-resizable-hide`
          class already removes the handle from the DOM outside edit mode
          (see resizeConfig.enabled below); this attribute is what makes it a
          clearly-visible grab affordance (not just a hover-revealed sliver)
          while editing. */}
      <div
        ref={containerRef}
        data-home-board-editing={editableNow ? "true" : undefined}
        // Plan 7 Task 3: leaves clearance under the last row for the fixed,
        // bottom-center ArrangeToolbar so it never sits on top of tile
        // content when the page is scrolled all the way down.
        className={cn(editableNow && "pb-24")}
      >
        {mounted && lg.length === 0 && (
          // Plan 4 Task 6: every widget removed (in edit mode, or a saved
          // empty layout on a later visit) — a plain, centered nudge rather
          // than blank space. Points at whichever affordance is currently
          // reachable: "Add widget" while editing at lg, "Customize board"
          // otherwise (mirrors HomeBoardControls' own editableNow gating;
          // Plan 6 Task 2 renamed the latter from a text "Edit board" button
          // to an icon labeled "Customize board").
          <div className="flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border p-12 text-center">
            <p className="text-sm font-medium">Your board is empty</p>
            <p className="text-sm text-muted-foreground">
              {editableNow ? "Use Add widget above to add one." : "Click Customize board above to add a widget."}
            </p>
          </div>
        )}
        {mounted && lg.length > 0 && (
          <Responsive
            width={width}
            breakpoints={BREAKPOINTS}
            cols={COLS}
            layouts={layouts}
            rowHeight={120}
            margin={[12, 12]}
            // Plan 7 Task 2: `containerPadding` defaults to null (falls back to
            // `margin`), which put a 12px outer inset around the grid — flush
            // with nothing, overhanging the pinned header's edges by 12px on
            // each side. Zeroing it removes that outer inset while leaving the
            // 12px inter-tile gutter (`margin` above) intact, so the grid's
            // outer edge lines up with the header above it.
            containerPadding={[0, 0]}
            compactor={verticalCompactor}
            dragConfig={{ enabled: editableNow, cancel: REMOVE_BUTTON_CANCEL_SELECTOR }}
            resizeConfig={{ enabled: editableNow }}
            onLayoutChange={onLayoutChange}
            onBreakpointChange={onBreakpointChange}
            onResizeStop={onResizeStop}
          >
            {lg.map((item) => {
              const def = getWidget(item.i);
              if (!def) return null; // unknown key — skip defensively (design §11)
              const Widget = def.Component;
              // Included in the accessible name so an assistive-tech user
              // gets the current position/size just from focusing the tile,
              // in addition to the aria-live announcement on each change.
              const tileLabel = `${def.title} tile, column ${item.x + 1}, row ${item.y + 1}, size ${item.w} by ${item.h}`;
              return (
                <div
                  key={item.i}
                  className={cn(
                    "relative h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus-ring",
                    // Task 2 (Plan 6): the whole tile already drags while
                    // editing (dragConfig sets no `handle`, only the remove-
                    // button `cancel` selector below) — this class is the
                    // visual affordance (grab cursor + outline) that makes
                    // that obvious. Actual cursor/outline styles live in
                    // index.css, scoped under the same
                    // `[data-home-board-editing]` attribute as the
                    // resize-handle CSS (Plan 5), for a single source of
                    // truth on "is the board in arrange mode".
                    editableNow && "home-board-tile-editable",
                  )}
                  tabIndex={editableNow ? 0 : undefined}
                  role={editableNow ? "group" : undefined}
                  aria-label={editableNow ? tileLabel : undefined}
                  onKeyDown={
                    editableNow
                      ? (event) => {
                          const delta = ARROW_KEY_DELTAS[event.key];
                          if (!delta) return;
                          // Also prevents arrow keys from scrolling the page
                          // out from under a focused tile.
                          event.preventDefault();
                          if (event.shiftKey) {
                            cycleWidgetSize(item.i);
                          } else {
                            moveWidget(item.i, delta[0], delta[1]);
                          }
                        }
                      : undefined
                  }
                >
                  {editableNow && (
                    <button
                      type="button"
                      onClick={() => removeWidget(item.i)}
                      aria-label={`Remove ${def.title}`}
                      className="home-board-tile-remove absolute right-1 top-1 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  )}
                  {/* Key includes companyId so a switch remounts the boundary — a
                      widget that errored for one company recovers when you change
                      companies. */}
                  <WidgetErrorBoundary key={`${item.i}-${companyId}`}>
                    {/* P2 fix: editableNow, not editing — WidgetShell suppresses
                        header navigation whenever `editing` is truthy, but below
                        the lg breakpoint (or while isSaving) editableNow is false
                        and every mutating affordance (drag/resize/remove/
                        keyboard) is already disabled. Passing bare `editing`
                        left the tile neither navigable (nav suppressed) nor
                        editable (affordances gated on editableNow) — inert. */}
                    <Widget companyId={companyId} role={role} editing={editableNow} size={{ w: item.w, h: item.h }} />
                  </WidgetErrorBoundary>
                </div>
              );
            })}
          </Responsive>
        )}
      </div>

      {/* Plan 7 Task 3 (follow-up fix): the floating arrange-mode toolbar
          (Add widget/Reset/status/Done) mounts on `editing` alone — NOT
          `editableNow`. Gating the mount on editableNow (as an earlier
          version of this did) meant narrowing the window below lg mid-edit,
          or the brief isSaving window, unmounted the toolbar entirely —
          taking the only "Done"/exit affordance with it and stranding the
          founder with no way out short of widening the window back or
          navigating away. `editing` alone keeps the toolbar (and Done)
          reachable at any breakpoint/save-state, exactly like the pre-Plan-7
          HomeBoardControls did; ArrangeToolbar's own Add widget/Reset
          controls still mirror the tiles' editableNow gate internally
          (disabled, not unmounted — see ArrangeToolbar's own doc comment).
          Mounted here (not Dashboard) so the four HomeBoard.*.test.tsx
          harnesses — which render HomeBoardControls + HomeBoard with no
          Dashboard — can still reach Done. */}
      {editing && <ArrangeToolbar boardEdit={boardEdit} role={role} />}
    </div>
  );
}
