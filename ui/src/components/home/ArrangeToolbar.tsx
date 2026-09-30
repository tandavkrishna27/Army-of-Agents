import { Plus, RotateCcw } from "lucide-react";
import type { UserRole } from "@armyofagents/shared";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { Button } from "../ui/button";
import { AddWidgetMenu } from "./AddWidgetMenu";
import type { UseBoardEditResult } from "./useBoardEdit";

export interface ArrangeToolbarProps {
  boardEdit: UseBoardEditResult;
  role: UserRole | null;
}

/**
 * The floating arrange-mode toolbar (Plan 7 Task 3): a fixed, bottom-center
 * pill that replaces the old inline header morph (the "Customize board"
 * button turning into "Done") with a dedicated surface for every arrange-mode
 * affordance — Add widget, Reset, the Saving…/Unsaved/Retry status, and Done.
 * The pinned header (`HomeBoardControls`) now shows only the customize icon
 * — inert while arranging — so the header never reflows/shifts the Create
 * button next to it (the founder complaint Plan 7 responds to).
 *
 * Mounted by `HomeBoard` whenever `editing` is true (see HomeBoard's own
 * comment) — NOT gated on `editableNow`, so the toolbar (and Done) stay
 * reachable at any breakpoint and during an in-flight save, mirroring how
 * the pre-Plan-7 HomeBoardControls kept "Done" reachable whenever `editing`.
 * Internally, though, `editableNow` (computed here from the same three
 * boardEdit fields HomeBoard itself uses) still gates the mutating Add
 * widget/Reset affordances exactly like it gates the grid tiles' own drag/
 * resize/remove — DISABLED, not unmounted, below lg or mid-save. Done is
 * deliberately NOT gated on editableNow: it's always enabled except while
 * isSaving (disabled there only to prevent a double-click on an
 * already-in-flight save, not because it's unreachable).
 *
 * `position: fixed` + a bottom offset keeps it clear of the board's last row.
 */
export function ArrangeToolbar({ boardEdit, role }: ArrangeToolbarProps) {
  const {
    lg,
    editing,
    activeBreakpoint,
    dirty,
    isSaving,
    isResetting,
    saveError,
    resetError,
    exitEdit,
    retrySave,
    addWidget,
    resetBoard,
  } = boardEdit;

  // Mirrors HomeBoard's own gate exactly (Task D1/P2) — Add widget/Reset are
  // mutating edit affordances, same as the tiles' drag/resize/remove, so
  // they're disabled (not removed) below lg or during an in-flight save.
  // Done is intentionally excluded from this — see the doc comment above.
  const editableNow = editing && activeBreakpoint === "lg" && !isSaving;

  return (
    <div
      role="toolbar"
      aria-label="Arrange board"
      className="fixed inset-x-0 bottom-6 z-30 mx-auto flex w-fit max-w-[calc(100%-2rem)] flex-wrap items-center justify-center gap-2 rounded-full border border-border bg-card px-3 py-2 shadow-[0_4px_12px_rgba(0,0,0,0.4),0_16px_36px_rgba(0,0,0,0.3)]"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* Mutating affordance — disabled (not unmounted) below lg or
              mid-save, mirroring the tiles' own drag/resize/remove gate. */}
          <Button type="button" variant="outline" size="sm" disabled={!editableNow}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add widget
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent aria-label="Add widget" side="top" align="center">
          <AddWidgetMenu boardKeys={lg.map((item) => item.i)} role={role} onAdd={addWidget} />
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Reset is reachable directly here with no confirm — unlike the
          customize dropdown's view-mode "Reset to default" (which DOES
          confirm; see HomeBoardControls), this button is only reachable
          while already mid-arrange, matching the retired AddWidgetTray's own
          unconfirmed Reset row. Same editableNow gate as Add widget above
          (plus its own isResetting guard, unaffected by that gate). */}
      <Button type="button" variant="outline" size="sm" onClick={resetBoard} disabled={!editableNow || isResetting}>
        <RotateCcw className="h-4 w-4" aria-hidden="true" />
        Reset
      </Button>

      {saveError != null && (
        <span className="text-sm text-destructive">
          Couldn't save your changes.{" "}
          <button type="button" onClick={retrySave} className="underline">
            Retry
          </button>
        </span>
      )}
      {saveError == null && resetError != null && (
        <span className="text-sm text-destructive">
          Couldn't reset your board.{" "}
          <button type="button" onClick={resetBoard} className="underline">
            Retry
          </button>
        </span>
      )}
      {saveError == null && resetError == null && isSaving && (
        <span className="text-sm text-muted-foreground">Saving…</span>
      )}
      {saveError == null && resetError == null && !isSaving && dirty && (
        <span className="text-sm text-muted-foreground">Unsaved changes</span>
      )}

      {/* Reachable at ANY breakpoint/save-state (not gated on editableNow —
          see this component's own doc comment): disabled only while
          isSaving, purely to prevent a double-click on an already-in-flight
          save, never because the affordance itself is meant to be
          unreachable. */}
      <Button type="button" size="sm" disabled={isSaving} onClick={exitEdit}>
        Done
      </Button>
    </div>
  );
}
