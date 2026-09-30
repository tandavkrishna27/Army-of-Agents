# Home Widget Board — Plan 4: Comprehensive widget testing

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Close the remaining gaps in the design §13 test matrix that the per-plan tests didn't already cover — harden the board against StrictMode, over-fetching, concurrency, and a11y regressions, and guarantee every widget has loading/empty/error coverage.

**Context:** Plans 1–3 shipped with substantial tests already (validator 25, route authz 17, gridLayout 35, useBoardEdit 26, per-widget edges, e2e, migration integration). This plan is a **testing-only hardening pass** — no product code changes except tiny test-affordance tweaks (e.g. a `data-testid` or an `aria-*` attribute) if a gap can't otherwise be asserted. Do not change behavior.

**Tech Stack:** Vitest + jsdom + @testing-library/react (+ Playwright for the founder/member e2e). No axe in the repo → a11y via manual ARIA assertions.

---

## Roadmap position (plan 4 of 4 — final)
Plans 1 (foundation) + 2 (new-data widgets) + 3 (tile board) ✅. **Plan 4 (this) — comprehensive testing.** After this: one holistic review → single PR (`claude/home-page-widgets-a927af`).

## What's already covered (do NOT re-test)
gridLayout packing/reconcile/project; layout validator (bounds/collision/unknown/dup/oversize); route authz (owner-scope, cross-company, agent/mcp, no-userId, body-userId→400); service CRUD; useBoardEdit dirty-gating + company-discard + resize-snap + reset-race; edit-mode drag/resize/add/remove component tests; keyboard move/resize + announcements + focus; Suggestions accept branches (Dashboard.test); zero-task Objectives; migration + unique + FK integration (D5); e2e add/remove/move/resize/persist + header-link nav (D4); first-run states.

## The gaps this plan fills
1. StrictMode double-invoke on the real board. 2. Query-count / no-over-fetch (perf regression guard). 3. Per-widget loading/empty/error completeness (all 8). 4. A11y completeness sweep (manual ARIA). 5. Save-concurrency edges (in-flight guards, unload). 6. Empty-board state + founder/member default e2e.

---

## Task 1: StrictMode double-invoke test
Prove the board is StrictMode-safe: no spurious layout `save`, no `dirty` on mount, no double data-fetch — the whole point of `useBoardEdit`'s mount-echo absorption + the query dedup.
**Files:** Create `ui/src/__tests__/home/HomeBoard.strictmode.test.tsx`.
- [ ] Step 1: Render `Dashboard` (or `HomeBoardControls` + `HomeBoard` via the existing harness) wrapped in `<React.StrictMode>`, with the api mocks from the existing home tests (incl. the `useContainerWidth` width mock). Spy on `homeBoardLayoutApi.save`. Assert on mount (not editing): `save` is NEVER called; the board renders once settled; entering edit then immediately exiting (no change) calls `save` **zero** times (clean draft → no-op exit). Also assert each mocked api `summary`/`list`/`pending` is called at most once despite StrictMode's double-render.
- [ ] Step 2: Run → PASS. Commit `test(home): StrictMode-safe board (no spurious save/fetch)`.

## Task 2: Query-count / no-over-fetch guard
The board loads many widgets; Budget + Approvals share ONE `queryKeys.dashboard` query, and nothing should N+1.
**Files:** Create `ui/src/__tests__/home/HomeBoard.queries.test.tsx`.
- [ ] Step 1: Render the founder board (all 8 widgets) with spies on every api the widgets call: `homeApi.summary`, `dashboardApi.summary`, `workQuestionsApi.list`, `issuesApi.list`, `suggestionsApi.pending`, `heartbeatsApi.liveRunsForCompany`, `homeBoardLayoutApi.get`. After the board settles, assert each is called **exactly once** — crucially `dashboardApi.summary` once (Budget + Approvals dedup via the shared key), and no widget triggers a redundant fetch. Document the expected count per api in the test.
- [ ] Step 2: Run → PASS. Commit `test(home): query-count guard (dashboard dedup, no N+1)`.

## Task 3: Per-widget loading/empty/error completeness
Guarantee EVERY one of the 8 widgets returns a safe render (null or a defined state) for loading, empty, and error. Fill whichever the per-plan tests missed (Plan-1 widgets — Action queue, Objectives, Activity feed, Suggestions — likely lack an explicit error-state test; the Plan-2 widgets have edges already).
**Files:** Modify the 8 `ui/src/__tests__/home/*Widget.test.tsx` (add the missing cases); optionally a shared `ui/src/__tests__/home/widget-completeness.test.tsx` that asserts a matrix.
- [ ] Step 1: For each widget, ensure three cases exist: (a) **loading** (hook/query pending → renders `null` or a skeleton, never crashes), (b) **empty** (no data → `null` or the widget's empty state), (c) **error** (the query rejects → `null`, and — because the board wraps each in `WidgetErrorBoundary` — a render throw would be contained; assert the widget itself doesn't throw on error data). Add only the missing cases; don't duplicate existing ones.
- [ ] Step 2: Add a completeness meta-test: iterate `listWidgets()`, render each with an empty/erroring mock, and assert none throws + each produces either `null` or a titled shell. (Mock the shared hooks/apis generically.)
- [ ] Step 3: Run the full home suite → PASS. Commit `test(home): per-widget loading/empty/error completeness (all 8)`.

## Task 4: A11y completeness sweep (manual ARIA)
No axe in the repo — assert the ARIA contract directly.
**Files:** Create `ui/src/__tests__/home/HomeBoard.a11y.test.tsx`.
- [ ] Step 1: Non-edit: every widget's open affordance is an accessible link with an `aria-label` ("Open {title}"); the board container has a sensible label. Edit mode: every tile is focusable (`tabIndex=0`) + has a descriptive `aria-label` (title + position/size); the remove control has an `aria-label` ("Remove {title}"); the tray is a labeled `menu` with labeled items; the ARIA live region (`aria-live="polite"`) exists and updates on a keyboard move; focus is retained on the tile after a move. Assert these via role/name queries (reuse the width mock).
- [ ] Step 2: Run → PASS. Commit `test(home): board a11y contract sweep (ARIA roles/labels/live-region/focus)`.

## Task 5: Save-concurrency + unload edges
Harden the exit/save race conditions beyond what `useBoardEdit.test.ts` covers.
**Files:** Modify `ui/src/__tests__/home/useBoardEdit.test.ts` (add cases).
- [ ] Step 1: Add cases: (a) while a `save` is in flight (mutation pending), `exitEdit`/`startEdit`/`reset` are guarded (no second `save`, no re-enter); (b) a failed save keeps `dirty` + `editing` + exposes `retrySave` which re-issues the save; (c) `retrySave` after a transient failure succeeds and clears dirty; (d) a background layout query refetch while editing does NOT overwrite a dirty draft (assert the draft is preserved). (If any of these already exist, confirm and skip.)
- [ ] Step 2: Run → PASS. Commit `test(home): board save-concurrency + retry + refetch-vs-dirty`.

## Task 6: Empty-board + founder/member default e2e
**Files:** Modify `ui/src/__tests__/home/HomeBoard.test.tsx` (empty-board unit) + `tests/e2e/home-widget-board.spec.ts` (founder/member — if the seed can set a role; else a component-level assertion).
- [ ] Step 1 (unit): removing every widget in edit mode → the board shows a centered "Add widget" empty state (add one to `HomeBoard` if absent — a minimal, tested addition), while the pinned header + attention line remain.
- [ ] Step 2 (member/founder default): assert (unit via `HomeBoard` with `role="team_member"` vs `role="founder"`, already partly covered) that the member default omits Budget/Approvals and leads with My tasks, and the founder default includes all 8 — a single explicit divergence test if not already present.
- [ ] Step 3: Run → PASS. Commit `test(home): empty-board state + founder/member default divergence`.

## Final verification (repo-canonical)
- [ ] `pnpm typecheck` → clean.
- [ ] `pnpm test:run` (full root suite) → green. (Re-run the onboarding cross-file flake isolated if it trips in aggregate — see Plan 2 notes.)
- [ ] `pnpm build` → succeeds.
- [ ] Confirm no product behavior changed: `git diff` on non-test files should be empty or limited to tiny a11y/testid affordances explicitly called out above.

---

## Self-review notes (author)
- **Testing-only:** no feature changes; at most tiny `aria-*`/empty-state additions strictly needed to assert a gap (Task 4/6), each committed with its test.
- **No re-testing:** the "already covered" list above is explicitly out of scope — add only the six gap areas.
- **Ends the initiative:** after Plan 4, a single holistic Codex review over Plans 1–4, then the one PR.
- **Open for implementer:** confirm the exact api export names to spy on (Task 2) against `ui/src/api/*`; confirm whether an empty-board state already exists in `HomeBoard` before adding one (Task 6).
