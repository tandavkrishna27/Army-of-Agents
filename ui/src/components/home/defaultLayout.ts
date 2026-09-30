import type { UserRole } from "@armyofagents/shared";
import type { WidgetKey } from "./widgets/types";

// Plan 2: role-aware default boards. Founder/team_lead get the oversight
// board; members get an execution-weighted subset. Data stays team-visible
// either way (2026-07-29 decision) — this is arrangement-only, not
// data-gating.
//
// Plan 7 Task 5 (2026-07-30) CURATED both sets down from "every registered
// widget" (Plans 2-6) to a smaller, prioritized default — everything dropped
// (suggestions + memory-review for founder; budget + suggestions +
// memory-review for member) is still fully available via the Add-widget
// tray, just no longer pre-populated. This lands alongside "Waiting on you"
// (approvals) becoming a genuine list widget instead of a stat (see
// HOME_BOARD_ALLOWED_SIZES.approvals), so it now defaults to 2x2 like the
// other list widgets instead of 1x1.
//
// Order is STATS-LAST — agents-now and budget are the only two widgets left
// at 1x1; every other widget on both boards is 2x2 — so
// packRowMajorNextFit's shelves fill cleanly: the 2x2s pair up two-per-shelf
// with zero interior gaps, and the trailing 1x1 stat(s) share one half-empty
// final row instead of puncturing an earlier shelf. Verified empirically
// against the real buildDefaultLg (not hand-derived) with a throwaway
// script, deleted before commit:
//
//   - FOUNDER (8 widgets: approvals, action-queue, objectives, my-tasks,
//     discussions, activity-feed, agents-now, budget — 6x2x2 + 2x1x1). Packs
//     to 7 rows (26/28 cells used), ZERO interior gaps — only the
//     unavoidable trailing 2-cell gap where the two 1x1 stats share their
//     final row with 2 empty columns beside them.
//   - MEMBER (7 widgets: my-tasks, action-queue, approvals, objectives,
//     discussions, activity-feed, agents-now — 6x2x2 + 1x1x1). Packs to 7
//     rows (25/28 cells used), ZERO interior gaps — only the unavoidable
//     trailing 3-cell gap where the lone 1x1 stat sits alone on its final
//     row (6 is even, so no 2x2 is ever left unpaired for it to ride with).
//
// If HOME_BOARD_ALLOWED_SIZES or either role's widget SET changes again,
// re-verify with buildDefaultLg (a throwaway script printing the real grid)
// before re-deriving this reasoning from scratch — don't assume a naive
// append/reorder stays optimal.
const FOUNDER: WidgetKey[] = ["approvals", "action-queue", "objectives", "my-tasks", "discussions", "activity-feed", "agents-now", "budget"];
const MEMBER: WidgetKey[] = ["my-tasks", "action-queue", "approvals", "objectives", "discussions", "activity-feed", "agents-now"];

// Only team_member gets the execution board; founder, team_lead, null, and
// instance-admin (null role) all get the oversight board.
export function getDefaultLayout(role: UserRole | null): WidgetKey[] {
  return role === "team_member" ? MEMBER : FOUNDER;
}
