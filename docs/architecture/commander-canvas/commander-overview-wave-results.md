# B07 Commander and overview source results

**Branch:** `codex/universe-interface`

**Date:** 2026-09-20
**Packages:** E1.4/2, E1.5/1, E1.5/2 and E1.5/3 source boundary

## Delivered

- Open panels uses stable opening order and bounded Previous/Next pages. Closing
  enough panels clamps the active page; a one-page result has no redundant pager.
- The left recovery rail projects minimized and fully offscreen panels from the
  active conversation only. It follows the observed persisted camera and measured
  canvas bounds. Hover uses 180 ms intent and 120 ms exit grace; keyboard focus
  exposes the same preview. Selecting restores/focuses the existing panel and
  recenters an unavailable view through the normal persisted viewport commit.
- Commander chat retains one canonical composer across compact, expanded,
  maximized and tucked presentation. Header actions are distinct, Compact is
  rightmost, and Tuck returns focus to the stable Commander tray control.
- Chat, blob and caption visibility remain independent presentation flags. The
  blob continues to expose truthful unavailable voice controls until E3 supplies
  a real session port; no simulated connection was added.
- Scope replacement still dismisses stale tray menus and drops the old workspace
  projection because the dedicated Universe owner remounts by identity/company.

## Verification

Focused UI verification covers overview pagination, page clamping, rail
visibility math, hover/focus restoration, tray ownership, Commander presentation,
canonical composer continuity, persisted workspace camera observation and the
dedicated Universe route:

- focused B07 plus shared-workspace regression: 83/83 tests passed;
- `pnpm -r typecheck`: passed;
- `pnpm build`: passed (existing chunk-size warnings only);
- `pnpm test:run`: 18,129 passed, 98 skipped and 175 failed. The full-run
  failures remain the previously recorded Windows Node 24/Drizzle
  `require(esm)` cycle plus unfinished worker-session/placement contract suites;
  all new B07 suites passed in the same run. This patch neither masks nor claims
  closure of those repository-level failures.

## Deferred acceptance joins

This source boundary does not invent later producers:

- E8.1/2.a applies saved `dockHiding`, chat/blob/caption placement, motion, blob
  style and theme preferences after their actual settings store and UI exist.
- E1.6 in B09 owns smooth requested offscreen focus, blob dock-aside motion and
  reduced-motion transition acceptance. B07 only establishes the deterministic
  restore/recenter path.
- E3 supplies live captions and voice session commands. With no active provider,
  captions have no fabricated text and voice remains truthfully unavailable.
- Expanded-chat drag/resize cannot claim persistence until its geometry contract
  is added to the shared layout/presentation owner. Existing task/artifact panel
  geometry was not overloaded with a fake Commander panel reference.
- Actual-host Playwright matrices and user acceptance remain later integration
  evidence; focused component tests do not close those gates.

These joins keep the original increments open for final acceptance while allowing
the next sequenced source wave to consume the stable B07 surfaces.
