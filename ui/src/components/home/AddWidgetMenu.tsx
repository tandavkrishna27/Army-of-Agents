import type { UserRole } from "@armyofagents/shared";
import { listWidgets } from "./widgets/registry";
import type { WidgetKey } from "./widgets/types";

export interface AddWidgetMenuProps {
  /** Widget keys currently on the board (the edit draft, or the read-only lg while not yet editing) — excluded from the offered list. */
  boardKeys: readonly WidgetKey[];
  /** The current viewer's role — hides `requiresFounder` widgets from non-founders (Plan 7: the tray now actually enforces the flag, matching getDefaultLayout's own founder/team_lead/null-vs-team_member split). */
  role: UserRole | null;
  /** Adds a widget. The two callers pass different hook actions — see this component's own doc comment. */
  onAdd: (key: WidgetKey) => void;
}

/**
 * The addable-widget list (Plan 7 Task 3), shared by two different Radix
 * surfaces:
 *  - the view-mode customize dropdown's "Add widget" submenu
 *    (`HomeBoardControls`), wired to `onAdd={addWidgetAndEdit}` since that
 *    caller isn't editing yet;
 *  - the arrange-mode floating toolbar's own "Add widget" popover
 *    (`ArrangeToolbar`), wired to `onAdd={addWidget}` since that caller is
 *    already editing.
 *
 * Deliberately dumb/presentational — no Radix awareness of its own (plain
 * `<button>` rows, not `DropdownMenuItem`s) so it can be embedded inside
 * either a `DropdownMenuSubContent` or a plain `DropdownMenuContent`
 * unchanged, and so it can be unit-tested standalone with plain props rather
 * than by driving it through a Radix submenu (submenu content opens on
 * pointer-hover with an internal timer jsdom/userEvent fire unreliably).
 *
 * Ported from the retired `AddWidgetTray` — same row markup and empty copy —
 * minus the header row and the Reset control, which the two callers above
 * now render themselves (Reset lives in the customize dropdown's own
 * top-level item and in ArrangeToolbar's own button).
 */
export function AddWidgetMenu({ boardKeys, role, onAdd }: AddWidgetMenuProps) {
  const available = listWidgets().filter(
    (def) => !boardKeys.includes(def.key) && (!def.requiresFounder || role !== "team_member"),
  );

  if (available.length === 0) {
    return (
      <p className="px-2 py-3 text-sm text-muted-foreground">
        All widgets are already on your board.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {available.map((def) => {
        const Icon = def.icon;
        return (
          <li key={def.key}>
            <button
              type="button"
              onClick={() => onAdd(def.key)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-text transition-colors hover:bg-accent/50"
            >
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span>{def.title}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
