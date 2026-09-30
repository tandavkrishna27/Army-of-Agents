export const HOME_BOARD_WIDGET_KEYS = ["action-queue","suggestions","objectives","activity-feed","agents-now","budget","approvals","my-tasks","discussions","memory-review"] as const;
export type HomeBoardWidgetKey = (typeof HOME_BOARD_WIDGET_KEYS)[number];
export const HOME_BOARD_LG_COLS = 4;
export const HOME_BOARD_MAX_ROWS = 50;           // y ceiling (sanity)
export const HOME_BOARD_LAYOUT_SCHEMA_VERSION = 1;
/**
 * Allowed desktop {w,h} footprints per widget (w in lg cols ≤ 4). Readonly
 * single source of truth — first entry per widget is its default.
 *
 * Stats (`agents-now`/`budget`) stay 2 footprints (1×1 compact / 2×1 wide).
 * Do NOT add 2×2 — a square stat is poor UX, and `agents-now 2×2` is the
 * canonical "disallowed size" in multiple existing tests (shared
 * home-board-layout.test.ts, gridLayout.test.ts clamp + cycle-wrap, server
 * routes-home-board-layout.test.ts OVERSIZE_LAYOUT).
 *
 * `approvals` ("Waiting on you") is no longer a stat — Plan 7 Task 5 turned
 * it into a list widget (it renders actual approval rows, not a count), so
 * it now takes the same 3-footprint shape as the other list widgets below
 * (2×2 default / 2×1 compact / 4×2 wide) instead of the old 1×1/2×1 stat
 * pair. This drops 1×1 as an allowed size for approvals specifically —
 * existing saved boards with approvals at 1×1 clamp to the nearest allowed
 * size (2×1) via reconcileLg/nearestAllowedSize on next load.
 */
export const HOME_BOARD_ALLOWED_SIZES = {
  "agents-now": [{ w: 1, h: 1 }, { w: 2, h: 1 }],
  budget: [{ w: 1, h: 1 }, { w: 2, h: 1 }],
  approvals: [{ w: 2, h: 2 }, { w: 2, h: 1 }, { w: 4, h: 2 }],
  "action-queue": [{ w: 2, h: 2 }, { w: 2, h: 1 }, { w: 4, h: 2 }],
  suggestions: [{ w: 2, h: 2 }, { w: 2, h: 1 }, { w: 4, h: 2 }],
  objectives: [{ w: 2, h: 2 }, { w: 2, h: 1 }, { w: 4, h: 2 }],
  "my-tasks": [{ w: 2, h: 2 }, { w: 2, h: 1 }, { w: 4, h: 2 }],
  "activity-feed": [{ w: 2, h: 2 }, { w: 4, h: 2 }, { w: 2, h: 1 }],
  discussions: [{ w: 2, h: 2 }, { w: 2, h: 1 }, { w: 4, h: 2 }],
  "memory-review": [{ w: 2, h: 2 }, { w: 2, h: 1 }, { w: 4, h: 2 }],
} as const satisfies Record<HomeBoardWidgetKey, readonly { w: number; h: number }[]>;
export const HOME_BOARD_MAX_ITEMS = HOME_BOARD_WIDGET_KEYS.length; // one instance per widget

/**
 * A single tile in the canonical desktop (lg) Home board layout. Structurally
 * mirrors packages/db's HomeBoardLayoutItem (which keeps its own hand-written
 * `i: string` interface so the DB schema module has no dependency on
 * @armyofagents/shared) — this copy narrows `i` to the known widget-key union
 * for shared/UI consumption (server + UI import this one; the DB layer only
 * needs the loose shape for its jsonb column type).
 */
export interface HomeBoardLayoutItem {
  i: HomeBoardWidgetKey;
  x: number;
  y: number;
  w: number;
  h: number;
}
