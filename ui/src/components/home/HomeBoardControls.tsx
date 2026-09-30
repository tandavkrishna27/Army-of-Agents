import { useState } from "react";
import { LayoutGrid, Move, Plus, RotateCcw } from "lucide-react";
import type { UserRole } from "@armyofagents/shared";
import type { UseBoardEditResult } from "./useBoardEdit";
import { AddWidgetMenu } from "./AddWidgetMenu";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

export interface HomeBoardControlsProps {
  boardEdit: UseBoardEditResult;
  /** Threaded through to the Add-widget submenu so it can hide `requiresFounder` widgets from non-founders (Plan 7 Task 3). */
  role: UserRole | null;
}

/**
 * The Home board's pinned-header edit chrome (Plan 7 Task 3 rewrite — was the
 * "Customize board"/"Done" icon-to-text morph from Plan 6 Task 2). The
 * customize icon button now NEVER changes shape or position: no more header
 * morph, and critically no more Create-button shift next to it (the founder
 * complaint this plan responds to).
 *
 *  - Not editing: the icon is a Radix `DropdownMenu` trigger — "Rearrange
 *    tiles" (-> startEdit), "Add widget" (a submenu wrapping the shared
 *    `AddWidgetMenu`, wired to `addWidgetAndEdit` since this caller isn't
 *    editing yet), a separator, then "Reset to default" (confirms first,
 *    then resetBoard). Radix's own dismissable layer gives us outside-click/
 *    escape close for free — the retired hand-rolled `AddWidgetTray` never
 *    had that.
 *  - Editing: the icon renders as a plain, disabled button — fully inert,
 *    since Rearrange no longer applies once already arranging, and Add
 *    widget/Reset/the Saving…/Unsaved/Retry status/Done all live in the
 *    floating `ArrangeToolbar` now (mounted by `HomeBoard`, gated on
 *    `editing` alone — not `editableNow` — so Done stays reachable even
 *    below the lg breakpoint or mid-save; see HomeBoard.tsx's own comment)
 *    instead of this pinned header.
 *
 * Purely presentational: every piece of state and every callback comes from
 * the single `boardEdit` bundle Dashboard computes via `useBoardEdit` and
 * shares with `<HomeBoard boardEdit={boardEdit}>` — there is exactly one
 * edit session/draft, never two independently-owned ones.
 */
export function HomeBoardControls({ boardEdit, role }: HomeBoardControlsProps) {
  const { lg, editing, isSaving, isResetting, resetError, activeBreakpoint, startEdit, addWidgetAndEdit, resetBoard } =
    boardEdit;
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);

  // Task D1: editing is enforced lg-only — the customize trigger (like every
  // other mutating edit affordance) stays disabled below the lg breakpoint,
  // exactly as before this rewrite.
  const disabledBelowLg = !editing && activeBreakpoint !== "lg";

  return (
    <div className="flex items-center gap-2">
      {/* Codex P2: the view-mode "Reset to default" (customize dropdown -> confirm
          -> resetBoard) fires a DELETE with no optimistic snap; if it fails, the
          old layout stays and — since ArrangeToolbar (which shows resetError
          inline while editing) is unmounted in view mode — the founder got NO
          feedback or retry. Surface it here, in view mode only (editing is
          ArrangeToolbar's job). Only renders on failure (rare), so the header's
          no-reflow-on-the-common-path guarantee (Plan 7) is preserved. Mirrors
          ArrangeToolbar's copy/Retry exactly. */}
      {!editing && resetError != null && (
        <span className="text-sm text-destructive">
          Couldn't reset your board.{" "}
          <button type="button" onClick={resetBoard} className="underline">
            Retry
          </button>
        </span>
      )}
      {editing ? (
        // Arrange mode: still rendered (never unmounted) so the header never
        // reflows — but fully inert, since every arrange-mode action now
        // lives in the floating ArrangeToolbar instead of here.
        <Button type="button" variant="outline" size="sm" disabled aria-label="Customize board">
          <LayoutGrid className="h-4 w-4" aria-hidden="true" />
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isSaving || disabledBelowLg}
              title={disabledBelowLg ? "Edit on a larger screen (1024px+)" : undefined}
              aria-label="Customize board"
            >
              <LayoutGrid className="h-4 w-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => startEdit()}>
              <Move className="size-4" aria-hidden="true" />
              Rearrange tiles
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Plus className="size-4" aria-hidden="true" />
                Add widget
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <AddWidgetMenu
                  boardKeys={lg.map((item) => item.i)}
                  role={role}
                  onAdd={addWidgetAndEdit}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => setResetConfirmOpen(true)}
              disabled={isSaving || isResetting}
            >
              <RotateCcw className="size-4" aria-hidden="true" />
              Reset to default
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Critical constraints (Plan 7 Task 3): resetBoard IS callable from
          view mode (guarded only on isSaving/isResetting), but it discards
          the saved layout with only a brief lag before the fallback default
          becomes visible (no optimistic snap) — a confirm speed bump before
          this NEWLY-view-mode-reachable action. Reuses the app's existing
          AlertDialog/confirm pattern (see ui/src/components/ui/confirm-dialog.tsx). */}
      <ConfirmDialog
        open={resetConfirmOpen}
        onOpenChange={setResetConfirmOpen}
        title="Reset board to default?"
        description="This discards your current layout and restores the default widget set for your role."
        confirmLabel="Reset"
        disabled={isSaving || isResetting}
        onConfirm={() => {
          resetBoard();
          setResetConfirmOpen(false);
        }}
      />
    </div>
  );
}
