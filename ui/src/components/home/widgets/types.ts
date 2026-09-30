import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { HomeBoardWidgetKey, UserRole } from "@armyofagents/shared";

/** One union, defined in shared (server + UI both need the widget-key set). */
export type WidgetKey = HomeBoardWidgetKey;

/** A grid footprint in {lg} columns/rows. Mirrors HOME_BOARD_ALLOWED_SIZES entries. */
export interface WidgetSize {
  w: number;
  h: number;
}

/** Props every widget receives. Widgets own their own data hooks internally. */
export interface WidgetProps {
  companyId: string;
  role: UserRole | null;
  /**
   * Current grid footprint (columns × rows) the tile is rendered at.
   *
   * Row/list widgets (My tasks, Objectives, Discussions, Waiting on you,
   * Today's activity, Memory review, Action queue, Suggestions) read this
   * via `rowsForSize` (widgetSizing.ts) to decide how many rows/items to
   * render — a taller tile shows more, a shorter one fewer, with a "+N more"
   * affordance (WidgetOverflow in WidgetStates.tsx) when truncated. Width is
   * not a factor — see rowsForSize's own doc comment for why.
   *
   * Single-value "stat" widgets (Agents working now, Budget) legitimately
   * ignore it — they only ever show one number, regardless of tile size.
   */
  size: WidgetSize;
  /** True while the Home board is in edit mode (suppresses header navigation). */
  editing?: boolean;
}

export interface WidgetDef {
  key: WidgetKey;
  title: string;
  icon: LucideIcon;
  requiresFounder?: boolean; // UX-only: hides this widget from the Add-widget tray for team_members (enforced today in AddWidgetMenu.tsx's filter) — not a data-access restriction; the underlying data stays team-readable.
  Component: ComponentType<WidgetProps>;
  /** Allowed desktop {w,h} footprints — references HOME_BOARD_ALLOWED_SIZES[key] (never copied). */
  allowedSizes: readonly WidgetSize[];
  defaultSize: WidgetSize;
}
