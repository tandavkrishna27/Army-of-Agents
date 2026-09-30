# Memory Console Layout Follow-Up Plan

> **For agentic workers:** Use this as a focused follow-up to `2026-05-09-memory-ui-overhaul.md`. Keep changes scoped to Memory Explorer layout and pane behavior.

**Goal:** Make Memory Explorer feel like a dense operating console: the folder tree starts at the top of the content area, page-level intro chrome is removed, and scoped controls live in the center pane. Search is icon-only until activated. Pane behavior should support three natural modes: browse, inspect, and focus.

**User-facing behavior:**
- Remove the internal "Memory Explorer" title/description band.
- Move Memory title, item count, search, upload, new item, and view toggle into the center pane header.
- Search appears as an icon by default, expands inline when clicked, and collapses when cleared/closed.
- Left pane remains navigation-first and starts at the top of the Memory content area.
- Right pane starts collapsed on Home and when there are no open tabs.
- Clicking an item opens/expands the right pane.
- Collapsing the right pane with open tabs shows the vertical tab strip.
- Closing the last tab collapses the right pane and gives the center pane room back.
- Fix resizable panel refs so collapse/expand APIs work reliably.

## Tasks

- [x] Task 1: Capture layout/interaction decision in this Superpowers plan.
- [x] Task 2: Move Memory toolbar controls into the center pane header.
- [x] Task 3: Replace always-visible center search input with icon-to-expand search.
- [x] Task 4: Remove Memory Explorer intro band and page-level toolbar.
- [x] Task 5: Fix left/right panel imperative refs and collapsed strip behavior.
- [x] Task 6: Collapse right pane when no tabs remain; expand it when a row is selected.
- [x] Task 7: Run focused typecheck/tests and browser smoke check.

## Acceptance Checks

- Memory tree/rail begins at the top of the Memory page content.
- Center pane header shows the current scope title and counts.
- Search icon expands to an input without adding vertical height.
- Upload and New item stay scoped to the center pane.
- Right pane collapse button shows `MemoryCollapsedTabStrip` when tabs exist.
- Clicking a collapsed tab icon expands the viewer and activates that tab.
- Closing the last tab collapses the viewer.
- `pnpm.cmd --filter ui exec tsc --noEmit` passes.
- Focused Memory tests pass.
