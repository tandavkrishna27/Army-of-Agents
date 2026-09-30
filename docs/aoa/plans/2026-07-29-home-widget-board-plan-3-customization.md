# Home Widget Board — Plan 3: Customization (the tile board)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Make Home the customizable Android-launcher tile board — snap-grid tiles, drag to reorder, resize to preset sizes, add/remove from a tray, responsive, per-user persisted, with an edit mode.

**Architecture:** `react-grid-layout@2.2.3` (spike GO). We persist ONE canonical desktop (`lg`) layout per user in `home_board_layouts` (owner-scoped `/me` PATCH, mirrors `sidebar_preferences`); `md`/`sm` are *derived* (never edited/persisted). `HomeBoard` is a controlled RGL `Responsive` grid; each widget renders in a `WidgetShell` tile (a clickable header that navigates when not editing). Edit mode toggles drag/resize + a remove `×` + an add-widget tray + reset; the draft (`lg` only) saves on exit. All widgets are team-visible (2026-07-29), so NO per-role data sanitization.

**Codex review (2026-07-29) resolutions folded in — see §RESOLUTIONS at the end.**

**Tech Stack:** `react-grid-layout@2.2.3` + `react-resizable` (direct dep), React 19 + Vite + Tailwind, react-query, Express + Drizzle. Vitest + Playwright.

---

## Roadmap position (plan 3 of 4)
Plans 1+2 ✅. **Plan 3 (this) — the tile board.** Plan 4 — comprehensive testing. One PR at the end (`claude/home-page-widgets-a927af`).

## Phase 0 — spike (DONE)
GO `react-grid-layout@2.2.3` native (React 19 rewrite). Risk = transitive-dep silent break → pin lockfile, ensure `react-draggable >= 4.7.1`, real drag/resize e2e.
**CRITICAL API NOTE:** v2's classic `WidthProvider(Responsive)` + `compactType`/`isDraggable`/`isResizable`/`draggableHandle` props live under `react-grid-layout/legacy`. The **native v2 root API** (which we use, to stay on the rewritten path) is different: `Responsive` + `useContainerWidth()` (pass `width`), `dragConfig={{ enabled, handle, cancel }}`, `resizeConfig={{ enabled }}`, `compactor` (vertical compactor), and `onLayoutChange(current, all)` / `onResizeStop`. **The implementer MUST read the installed `node_modules/react-grid-layout/dist/*.d.ts` (v2.2.3) to confirm exact export names + prop shapes before wiring — do not trust legacy tutorials.**

---

# Phase A — dependency + server persistence

## Task A1: Install the grid deps
**Files:** `ui/package.json` (+ lockfile), possibly root `package.json` (`pnpm.overrides`).
- [ ] Step 1: `pnpm --filter @armyofagents/ui add react-grid-layout@2.2.3 react-resizable` (react-resizable is a DIRECT dep because we import its CSS — pnpm won't hoist a transitive for a direct import).
- [ ] Step 2: Ensure `react-draggable >= 4.7.1` resolves (`pnpm --filter @armyofagents/ui why react-draggable`); if not, add root `pnpm.overrides` `"react-draggable": ">=4.7.1"` + reinstall.
- [ ] Step 3: Read `node_modules/react-grid-layout/dist/*.d.ts` and note the exact native v2 API (Responsive export, `useContainerWidth`, `dragConfig`/`resizeConfig`/`compactor`, layout item shape `{i,x,y,w,h}`). Record it in a short comment in Task B3's file.
- [ ] Step 4: Import CSS once in `ui/src/main.tsx`: `import "react-grid-layout/css/styles.css"; import "react-resizable/css/styles.css";`. `pnpm --filter @armyofagents/ui build` → succeeds. Commit `chore(home): add react-grid-layout@2.2.3 + react-resizable`.

## Task A2: `home_board_layouts` schema + migration
Store the **canonical `lg` array only** (`HomeBoardLayoutItem[]`); md/sm are derived at render. Mirror `sidebar_preferences`.
**Files:** Create `packages/db/src/schema/home_board_layouts.ts`; modify `packages/db/src/schema/index.ts`; `pnpm db:generate`.
- [ ] Step 1:
```ts
import { pgTable, uuid, text, integer, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";

export interface HomeBoardLayoutItem { i: string; x: number; y: number; w: number; h: number; }

/** Per-user, per-company canonical desktop (lg) Home layout. md/sm are derived at render, never stored. Null row => role default. */
export const homeBoardLayouts = pgTable(
  "home_board_layouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    layout: jsonb("layout").$type<HomeBoardLayoutItem[]>().notNull(), // canonical lg
    schemaVersion: integer("schema_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("home_board_layouts_company_idx").on(table.companyId),
    userIdx: index("home_board_layouts_user_idx").on(table.userId),
    userCompanyUq: uniqueIndex("home_board_layouts_user_company_uq").on(table.userId, table.companyId),
  }),
);
```
- [ ] Step 2: Register in `schema/index.ts`: `export { homeBoardLayouts, type HomeBoardLayoutItem } from "./home_board_layouts.js";`.
- [ ] Step 3: `pnpm db:generate` → inspect whatever `NNNN_*.sql` the generator assigns (do NOT hard-code the number) — must CREATE the table, both FKs `ON DELETE CASCADE`, unique index. Commit `feat(db): home_board_layouts table`.

## Task A3: Shared constants + validator
Server can't import the UI registry, so widget keys + allowed (desktop) sizes live in shared. **`HOME_BOARD_ALLOWED_SIZES` are DESKTOP (lg, 4-col) editing sizes** — responsive width-clamping is a render-time projection (Task B3), NOT a validation concern.
**Files:** Create `packages/shared/src/home-board.ts` + `packages/shared/src/validators/home-board-layout.ts` + test; re-export from validators/index + root.
- [ ] Step 1: `home-board.ts`:
```ts
export const HOME_BOARD_WIDGET_KEYS = ["action-queue","suggestions","objectives","activity-feed","agents-now","budget","approvals","my-tasks"] as const;
export type HomeBoardWidgetKey = (typeof HOME_BOARD_WIDGET_KEYS)[number];
export const HOME_BOARD_LG_COLS = 4;
export const HOME_BOARD_MAX_ROWS = 50;           // y ceiling (sanity)
export const HOME_BOARD_LAYOUT_SCHEMA_VERSION = 1;
/** Allowed desktop {w,h} footprints per widget (w in lg cols ≤ 4). Readonly single source of truth. */
export const HOME_BOARD_ALLOWED_SIZES = {
  "agents-now": [{ w: 1, h: 1 }, { w: 2, h: 1 }],
  budget: [{ w: 1, h: 1 }, { w: 2, h: 1 }],
  approvals: [{ w: 1, h: 1 }, { w: 2, h: 1 }],
  "action-queue": [{ w: 2, h: 1 }, { w: 2, h: 2 }],
  suggestions: [{ w: 2, h: 1 }, { w: 2, h: 2 }],
  objectives: [{ w: 2, h: 1 }, { w: 2, h: 2 }],
  "my-tasks": [{ w: 2, h: 1 }, { w: 2, h: 2 }],
  "activity-feed": [{ w: 2, h: 2 }, { w: 2, h: 1 }, { w: 4, h: 2 }],
} as const satisfies Record<HomeBoardWidgetKey, readonly { w: number; h: number }[]>;
export const HOME_BOARD_MAX_ITEMS = HOME_BOARD_WIDGET_KEYS.length; // one instance per widget
```
- [ ] Step 2: `validators/home-board-layout.ts` — a `layout` = array of `{ i: HomeBoardWidgetKey, x,y,w,h: int ≥ 0 }`, with: ≤ `HOME_BOARD_MAX_ITEMS`; **no duplicate `i`**; **unknown `i` REJECTED**; `x + w <= HOME_BOARD_LG_COLS`; `y + h <= HOME_BOARD_MAX_ROWS`; `{w,h}` ∈ that widget's `HOME_BOARD_ALLOWED_SIZES`; **no two items overlap** (rectangle-intersection check). Export `updateHomeBoardLayoutSchema` = `.strict()` object `{ layout }` (NO client `schemaVersion` — the server stamps it). Export a pure `validateHomeBoardLayout(layout): {ok:true}|{ok:false,error}` for unit tests.
- [ ] Step 3: TDD `packages/shared/src/__tests__/home-board-layout.test.ts`: valid passes; oversize footprint, out-of-bounds `x+w`, overlap, duplicate key, unknown key, >max items, negative coords all fail. Re-export from validators/index + root. Run shared tests → PASS. Commit `feat(shared): home board layout constants + validator (collision + bounds + allowed-sizes)`.

## Task A4: Layout service
**Files:** Create `server/src/services/home-board-layout.ts` + `server/src/__tests__/home-board-layout-service.test.ts`.
- [ ] Step 1 (TDD, Drizzle mocks): `get(userId, companyId): Promise<{ layout: HomeBoardLayoutItem[]; schemaVersion: number } | null>`; `upsert(userId, companyId, layout): Promise<...>` (insert…onConflictDoUpdate on `(userId,companyId)`, **server sets `schemaVersion = HOME_BOARD_LAYOUT_SCHEMA_VERSION` and `updatedAt = now`** — never from the client); `reset(userId, companyId): Promise<void>` DELETEs the row (explicit contract: deletion → future reads return null → default). 
- [ ] Step 2: Implement `homeBoardLayoutService(db)`. Import the service directly in the route (no services barrel).
- [ ] Step 3: Run → PASS. Commit `feat(home): home board layout service`.

## Task A5: Owner-scoped route
Mirror `sidebar-preferences.ts` (`requireBoardUserId` + `assertCompanyAccess` + `/me`). No role gate (team-visible). No activity-log entry (a personal layout pref, exactly like sidebar-preferences, which does not log). Server stamps schemaVersion.
**Files:** Create `server/src/routes/home-board-layout.ts`; register in `server/src/app.ts`.
- [ ] Step 1:
  - `GET …/home-board-layout/me` → `{ layout, schemaVersion } | null`.
  - `PATCH …/home-board-layout/me` (`validate(updateHomeBoardLayoutSchema)`) → `svc.upsert(userId, companyId, req.body.layout)`; return `{ layout, schemaVersion }`.
  - `POST …/home-board-layout/me/reset` → `svc.reset`; return `{ ok: true }`.
- [ ] Step 2: Register `api.use(homeBoardLayoutRoutes(db));` in `app.ts`.
- [ ] Step 3: Contract test (supertest): valid PATCH → 200; **PATCH with `userId` in the body → 400** (`.strict()` rejects the extra field); oversize/unknown/overlapping layout → 400; **cross-company** (actor not a member) → 403; **agent/mcp actor** → 403 (board-only via `requireBoardUserId`); **board session without `userId`** → 401; GET on a fresh user → `null`; reset then GET → `null`. Run → PASS. Commit `feat(home): owner-scoped home board layout route`.

## Task A6: UI api client + queryKey + hook
**Files:** Create `ui/src/api/home-board-layout.ts`; modify `ui/src/lib/queryKeys.ts`; create `ui/src/hooks/useHomeBoardLayout.ts` + test.
- [ ] Step 1: api client:
```ts
import type { HomeBoardLayoutItem } from "@armyofagents/shared";
import { api } from "./client";
export interface HomeBoardLayoutResponse { layout: HomeBoardLayoutItem[]; schemaVersion: number; }
export const homeBoardLayoutApi = {
  get: (companyId: string) => api.get<HomeBoardLayoutResponse | null>(`/companies/${companyId}/home-board-layout/me`),
  save: (companyId: string, layout: HomeBoardLayoutItem[]) => api.patch<HomeBoardLayoutResponse>(`/companies/${companyId}/home-board-layout/me`, { layout }),
  reset: (companyId: string) => api.post<{ ok: true }>(`/companies/${companyId}/home-board-layout/me/reset`, {}),
};
```
(Ensure `HomeBoardLayoutItem` is exported from `@armyofagents/shared`.)
- [ ] Step 2: `queryKeys.homeBoardLayout: (companyId) => ["home-board-layout", companyId] as const`.
- [ ] Step 3: `useHomeBoardLayout(companyId)` — `useQuery` for the saved layout; a `save` mutation (optimistic like `SessionsSidebar`: `onMutate` cancel+snapshot+set, `onError` rollback, `onSettled` invalidate) and a `reset` mutation. TDD: save calls the api with the layout; error rolls back. Commit `feat(home): home board layout api client + hook`.

---

# Phase B — grid integration + tile chrome

## Task B1: Registry sizes + type unification
**Files:** Modify `ui/src/components/home/widgets/types.ts`, `registry.ts`, `registry.test.ts`.
- [ ] Step 1: In `types.ts`: `export type WidgetKey = HomeBoardWidgetKey` (import from shared — one union, no duplication). `WidgetProps` gains `size: { w: number; h: number }`. `WidgetDef` gains `icon`, `defaultSize`, `allowedSizes` — the latter two **reference** `HOME_BOARD_ALLOWED_SIZES[key]` (do not copy literals); `defaultSize = allowedSizes[0]`.
- [ ] Step 2: `registry.test.ts`: each def's `allowedSizes === HOME_BOARD_ALLOWED_SIZES[key]` and includes `defaultSize`.
- [ ] Step 3: `pnpm typecheck` (existing `WidgetProps` call sites now need a `size` — HomeBoard passes it in B3; widget tests pass `size`). Commit `feat(home): registry sizes referencing shared allowed footprints; unify WidgetKey`.

## Task B2: `WidgetShell` tile chrome + rework the 8 widgets
**Files:** Create `ui/src/components/home/widgets/WidgetShell.tsx` + test; modify all 8 widgets + their tests + the board tests.
- [ ] Step 1: `WidgetShell({ title, icon, to, editing, children })` — full-height card. The **header row is the clickable open link** (a `Link to={to}` wrapping icon + title + a trailing `›`, `aria-label={`Open ${title}`}`) when `!editing`; when `editing`, render the header as a non-navigating `div` (drag/select). Body = `min-h-0 flex-1 overflow-auto`. TDD: not-editing → header is a link to `to`; editing → header is not a link.
- [ ] Step 2: Rework each of the 8 widgets to `<WidgetShell title icon to editing>…existing body…</WidgetShell>` (drop each widget's own `<h2>`). Titles come from a single source (the registry `title`) — reconcile the Plan-2 divergence so the shell title, registry title, and tray label all match (choose: "Action queue", "Suggestions", "Objectives", "Today's activity", "Agents working now", "Budget", "Approvals & questions", "My tasks"). Drill-in `to`: action-queue→`/issues`, suggestions→`/inbox`, objectives→`/objectives`, activity-feed→`/activity`, agents-now→`/agents`, budget→`/budget`, approvals→`/inbox`, my-tasks→`/issues`. Widgets receive `editing` via `WidgetProps`? No — pass `editing` from HomeBoard through a small prop or context; simplest: add `editing?: boolean` to `WidgetProps` and thread it. Keep each widget's data/body behavior identical.
- [ ] Step 3: Update each widget test + the `HomeBoard`/`Dashboard` heading-order tests to the shell titles (now the registry titles). Full home suite + `Dashboard.test.tsx` green. Commit `feat(home): WidgetShell tile chrome across all widgets`.

## Task B3: `gridLayout.ts` helpers + `HomeBoard` RGL grid
**Files:** Create `ui/src/components/home/gridLayout.ts` + test; rewrite `ui/src/components/home/HomeBoard.tsx` + test.
- [ ] Step 1: `gridLayout.ts` (pure, TDD):
  - `buildDefaultLg(role): HomeBoardLayoutItem[]` — flow `getDefaultLayout(role)` keys into a 4-col grid at each widget's `defaultSize`, deterministic packing (row-major, next-fit). No overlaps, `x+w<=4`.
  - `reconcileLg(saved, role): HomeBoardLayoutItem[]` — from a saved lg array: **drop items whose `i` is not a currently-registered key** (retired widget); **clamp each `{w,h}` to the widget's `allowedSizes`** (nearest allowed). **Do NOT auto-add missing widgets** — saved membership is authoritative; newly-shipped widgets appear only in the tray. Returns a valid, overlap-free lg (re-pack if a clamp caused overlap).
  - `projectToBreakpoint(lg, cols): HomeBoardLayoutItem[]` — derive md (cols=2) / sm (cols=1): clamp each item's `w` to `≤ cols` (so a `w:2` tile → `w:1` on sm), preserve order, re-flow with vertical compaction into `cols`. Deterministic.
  - Tests: default packing deterministic + valid; reconcile drops unknown keys, clamps sizes, never adds; project clamps width and re-flows for cols=2 and cols=1.
- [ ] Step 2: `HomeBoard.tsx` — controlled RGL `Responsive` (native v2 API — verify exact names against the installed `.d.ts` from Task A1):
  - `const width = useContainerWidth(ref)` (or the v2 equivalent); pass `width`.
  - `const lg = saved ? reconcileLg(saved, role) : buildDefaultLg(role)`; `layouts = { lg, md: projectToBreakpoint(lg, 2), sm: projectToBreakpoint(lg, 1) }`.
  - `breakpoints={{ lg: 1024, md: 640, sm: 0 }}`, `cols={{ lg: 4, md: 2, sm: 1 }}`, `rowHeight={104}`, `margin={[12,12]}`, vertical `compactor`, `dragConfig={{ enabled: editing }}`, `resizeConfig={{ enabled: editing }}`.
  - One grid child per `lg` item: `<div key={i}>` → `<WidgetErrorBoundary key={`${i}-${companyId}`}><Widget companyId role editing size={{w,h}} /></WidgetErrorBoundary>` via `getWidget(i)`; skip unknown keys.
  - `onLayoutChange`/`onResizeStop` handling lives in `useBoardEdit` (Task C1) — HomeBoard just wires the callbacks and passes `editing`.
- [ ] Step 3: Component test (async mocks as in the current HomeBoard test): founder default renders 8 tiles; a saved-layout case renders reconciled positions; unknown saved key is skipped. Commit `feat(home): HomeBoard as a react-grid-layout tile grid (canonical lg + derived breakpoints)`.

---

# Phase C — edit mode + tray

## Task C1: `useBoardEdit` — draft state, dirty-gating, save-on-exit
**Files:** Create `ui/src/components/home/useBoardEdit.ts` + test; wire into `HomeBoard`.
- [ ] Step 1 (the draft discipline — this is the subtle part):
  - Holds `editing` + a **draft `lg`** initialized from the rendered lg when edit begins (a baseline snapshot).
  - **`onLayoutChange` is ignored unless `editing && initialized && activeBreakpoint==='lg'`**, and only mutates the draft when the new lg **differs from the baseline** (RGL fires it on mount / breakpoint sync / StrictMode double-invoke — never treat those as edits). Compare by value.
  - `onResizeStop` snaps the resized item's `{w,h}` to the nearest `allowedSizes` for that widget, then updates the draft.
  - **A background query refetch must NOT overwrite a dirty draft** (the hook owns the draft while editing; the query result is only adopted when not dirty).
  - **Exit** flushes: call `save(draft)` immediately (not just debounced). While a save is in flight, disable exit/re-entry/reset. On failure keep the draft + expose `dirty`/`saveError`/retry. Scope the draft to `companyId` — **on company change, discard the draft** (never save an old-company layout).
  - Unit-test the pure parts: baseline-diff dirty detection, resize snapping, and that a spurious `onLayoutChange` equal to baseline does NOT dirty.
- [ ] Step 2: Wire into HomeBoard; tiles in edit mode overlay a remove `×` (removes the item from the draft) and the drag affordance; header navigation suppressed (`editing`).
- [ ] Step 3: Component test: enter edit → handles/`×` appear; drag/remove updates draft; exit → `save` called with the draft; failed save → dirty + retry; company switch mid-edit → draft discarded, no save. Commit `feat(home): board edit mode (draft + dirty-gated save-on-exit)`.

## Task C2: Add-widget tray + reset
**Files:** Create `ui/src/components/home/AddWidgetTray.tsx` + test.
- [ ] Step 1: Tray lists `listWidgets()` minus the draft's current keys (all team-visible — no role filter). Each shows icon + `title`; click adds it at `defaultSize` (appended; compaction places it) to the draft. **Reset**: calls the `reset` mutation (server DELETE) then the query refetches `null` → board shows `buildDefaultLg(role)`, and the draft is set clean (no delete-then-upsert race — reset is immediate + marks the draft clean so exit does not re-save).
- [ ] Step 2: Component test: tray excludes on-board widgets; adding puts it in the draft; reset restores default + clears dirty. Commit `feat(home): add-widget tray + reset`.

---

# Phase D — responsive, a11y, header, verification

## Task D1: Canonical-lg persistence + edit-on-lg-only
- [ ] Step 1: Persist ONLY the `lg` array; `md`/`sm` are always derived by `projectToBreakpoint` (never sent to the server). Disable drag/resize/add/remove below `lg` (edit affordances hidden under 1024px). Unit test: save lg → reload → identical lg; md/sm are pure functions of lg. Commit `feat(home): persist canonical desktop layout; derive breakpoints; edit on lg only`.

## Task D2: Keyboard a11y (move/resize)
- [ ] Step 1: In edit mode a focused tile: Arrow keys nudge position by one cell (respect bounds + collision — reuse RGL core move/compaction helpers if exported, else compute + re-pack so no overlap and compaction can't silently revert the move); `Shift+Arrow` steps size through the widget's `allowedSizes`. Announce via an ARIA live region; retain focus across the op. Component test: arrow moves the tile in the draft (blocked at bounds), shift-arrow cycles allowed sizes, focus retained, live-region announces. Commit `feat(home): keyboard move/resize for the board (a11y)`.

## Task D3: Pinned header controls + attention line + states
**Files:** Modify `ui/src/pages/Dashboard.tsx`.
- [ ] Step 1: Add to the pinned header (above the grid, never blocked by grid load/error): `Edit board` toggle, `Add widget` (opens tray, edit-mode only), a thin "needs attention" line, and — in edit mode — `Reset` + a dirty/`Saving…`/retry indicator. Layout loading → skeleton; per-widget error → existing boundary. Keep `Dashboard.test.tsx` green (add controls without weakening behavior assertions). Commit `feat(home): pinned edit/add controls + attention line + save state`.

## Task D4: e2e — drag/resize/add/remove/persist
**Files:** Extend `tests/e2e/home-widget-board.spec.ts`.
- [ ] Step 1: seed a company → `/home` → assert a tile's **header link** navigates (not editing) → enter edit → drag a tile → resize a tile → add a widget from the tray → remove one → exit → reload → assert the layout persisted. (Windows skips e2e; runs on Linux CI. The real drag/resize here is the RGL smoke test the spike mandated.) Commit `test(home): e2e drag/resize/add/remove/persist`.

## Task D5: Migration integration test
**Files:** Create `server/src/__tests__/home-board-layout.integration.test.ts` (`skipIf(process.platform==='win32')`, embedded-PG per repo pattern).
- [ ] Step 1: `applyPendingMigrations` → upsert a layout → read back → assert equality; assert the `unique(userId, companyId)` constraint (second insert conflicts→update) and FK cascade (delete company → row gone). Commit `test(home): home_board_layouts migration + constraints integration`.

## Final verification (repo-canonical)
- [ ] `pnpm typecheck` → clean; `pnpm build` → succeeds.
- [ ] `pnpm test:run` (full root suite) → green. (If the pre-existing onboarding cross-file flake trips in the aggregate UI run, re-run it isolated to confirm it's unrelated — see Plan 2 notes.)
- [ ] Preview: `/home` → edit → drag/resize/add/remove → reload → layout persists; non-edit tile header click navigates.

---

## RESOLUTIONS — Codex review (2026-07-29)
| # | Finding | Resolution |
|---|---|---|
| P1 | Legacy vs native v2 API | Phase-0 note + B3 use the native v2 API (`useContainerWidth`/`dragConfig`/`resizeConfig`/`compactor`); A1 Step 3 reads the installed `.d.ts` to confirm exact names |
| P1 | Responsive unresolved | Persist canonical `lg` ONLY; md/sm derived by `projectToBreakpoint` (D1); never rely on RGL auto-gen for the payload |
| P1 | sm can't hold w:2 tiles | `HOME_BOARD_ALLOWED_SIZES` = desktop sizes; `projectToBreakpoint` clamps `w ≤ cols` and re-flows |
| P1 | reconcile resurrects removals | `reconcileLg` drops unknown keys + clamps sizes; **never auto-adds**; new widgets → tray |
| P1 | types don't compile | `WidgetProps += size` (+`editing`); shared exports `HomeBoardLayoutItem`; `WidgetKey = HomeBoardWidgetKey` |
| P1 | server contract inconsistent | `get`/route both return `{layout,schemaVersion}\|null`; service imported directly; reset = DELETE (explicit + tested) |
| P1 | userId test wrong | `.strict()` → PATCH body `userId` = **400**; + cross-company/agent/no-userId tests |
| P1 | activity log | Matches `sidebar_preferences` (a personal pref — no activity log); documented, not omitted by accident |
| P1 | schemaVersion ownership | Server STAMPS `HOME_BOARD_LAYOUT_SCHEMA_VERSION`; client cannot set it (`.strict()` rejects) |
| P1 | onLayoutChange not intent | `useBoardEdit` gates on `editing && initialized && lg && value-differs-from-baseline`; refetch never clobbers a dirty draft |
| P1 | save concurrency | Disable exit/re-entry/reset while saving; draft scoped to `companyId`; company-switch discards draft; dropped the false `updatedAt` LWW claim |
| P1 | navigate vs drag | WidgetShell header IS the open link (not editing); edit suppresses it; `dragConfig.enabled=false` off-edit; e2e clicks the header link |
| P1 | react-resizable direct dep | A1 adds it as a direct UI dep |
| P1 | final verification | `pnpm typecheck` / `pnpm build` / `pnpm test:run` |
| P2 | sizes referenced not copied | Registry references `HOME_BOARD_ALLOWED_SIZES` (readonly `as const`) |
| P2 | migration number brittle | Accept generator's number; inspect the SQL |
| P2 | keyboard bounds/collision | D2 uses RGL helpers + bounds/collision + focus tests |
| P2 | validator overlap/y | Validator adds overlap + `y+h ≤ HOME_BOARD_MAX_ROWS`; cap = key count |
| P2 | reset race | Reset = server DELETE + mark draft clean (no delete-then-upsert) |

## Self-review
- **Deferred to Plan 4:** exhaustive matrix — multi-tab concurrency, malicious payloads, StrictMode, bundle/query regression, per-widget edge coverage, full a11y sweep, responsive breakpoint round-trips, role transitions (moot — team-visible).
- **Open for implementer:** exact native v2 export/prop names (read installed `.d.ts`); whether RGL exports a reusable vertical `compactor` + move helpers or we implement them; Tailwind breakpoint alignment.
