import type { WidgetSize } from "./types";

/**
 * How many list rows a row/list widget should render for its current tile
 * footprint. Height-driven only: a wider tile gives each row more
 * horizontal room, not more rows, so width never changes the count (see
 * HomeBoard.tsx's `<Widget ... size={{ w: item.w, h: item.h }} />` — both
 * axes are always passed, this deliberately only reads `h`).
 *
 * Tuned against HomeBoard's actual react-grid-layout geometry (`rowHeight`
 * =120, `margin`=[12,12]):
 *   - h=1 tile  -> ~120px total, minus WidgetShell's ~44px header ->
 *     ~76px left for rows, ~2 rows at ~34px each.
 *   - h=2 tile  -> 120*2 + 12 (inter-row gutter) = 252px total, minus the
 *     ~44px header -> ~208px left for rows, ~6 rows.
 * No widget's `HOME_BOARD_ALLOWED_SIZES` entry currently exceeds h=2 (the
 * tallest allowed footprint on the board today), so h>=2 collapses to one
 * tier — if a taller footprint is ever introduced, revisit this mapping
 * rather than assuming it extrapolates linearly.
 *
 * `size` is optional so a caller that can't supply one (an older/incomplete
 * test, or any future call site outside HomeBoard) still gets a safe row
 * count instead of a crash. Missing size defaults to the h>=2 (6-row)
 * branch — the more generous option, matching every widget's un-sized
 * behavior before this feature existed.
 */
export function rowsForSize(size: WidgetSize | undefined): number {
  const h = size?.h ?? 2;
  return h <= 1 ? 2 : 6;
}
