// ui/src/components/commander/commanderChrome.ts
// Single source of truth for Commander panel chrome (Phase 0). Mirrors the
// Workspace/Memory/Discussions recipe (design-system §5.1 radius, §6 shadow).
// NOTE: overflow-hidden is intentionally NOT here — it clips the viewer's
// resize divider. Add "overflow-hidden" per-panel only where content must clip
// (sessions, chat); omit it on the viewer. Phase 1 reuses these unchanged.
export const COMMANDER_PANEL_CARD =
  "rounded-xl border border-border bg-background shadow-sm";

/** The row that holds the panels: gap + padding + muted backdrop. */
export const COMMANDER_PANEL_ROW = "gap-2 p-2 bg-muted/30";
