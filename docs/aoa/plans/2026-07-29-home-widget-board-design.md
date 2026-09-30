# Home Widget Board — Design

- **Date:** 2026-07-29
- **Status:** Design (approved direction; Codex-reviewed 2026-07-29, resolutions folded in — see §14; pending founder review of this doc)
- **Branch:** `claude/home-page-widgets-a927af`
- **Authors:** Founder (TK) + Claude (brainstorming session)
- **Scope:** Replace today's fixed Home (`ui/src/pages/Dashboard.tsx`) with an Android-launcher-style **widget board** — a single home screen of glanceable, fixed-footprint widgets the user can add, remove, resize (to preset sizes), and rearrange on a snap grid. v1 ships 8 widget types, a widget registry for "add as we go" extensibility, and per-user layout persistence.

> This is a **design doc**, not an implementation plan. It defines the model, the v1 widget set, the interaction model, and the architecture, and inventories what today's Home does so nothing is dropped. The phased, file-by-file plan is the follow-up via writing-plans — with the §8.2 grid-library spike as its phase 0.

> **Codex review (2026-07-29) resolutions are folded in throughout; see §14 for the finding-by-finding map.**

---

## 1. Goals & non-goals

### Goals
1. **Home as a customizable board.** Add, remove, resize (to preset sizes), and drag-rearrange widgets on a snap grid.
2. **Glance from outside.** Each widget shows a readable summary in place; clicking drills into the full surface.
3. **Add widgets as we go.** A widget registry makes the *board-shell* cost of a new widget ≈ one module + one registry line (backend data work is separate — see §8.1).
4. **Preserve today's value.** The v1 default board reproduces the content Home shows today; replacing Home loses nothing (§2 preservation requirements).
5. **Keep Home focused.** A thin, always-visible "needs attention" line stays pinned above the board.
6. **Ship secure and complete.** Server-side data authorization, save/concurrency correctness, and the full test matrix (§13) are part of v1, not follow-ups.

### Non-goals (v1)
- **Multiple home screens / pages** (model supports it later).
- **Founder-editable company default layout** (built-in per-role defaults only).
- **Inline approve/answer on tiles** beyond Suggestions' existing accept/dismiss.
- **Marketplace/plugin-contributed widgets.**
- **Perfect gap-free 2-D bin-packing.** D5 is *vertical compaction* (§3, §8.2) — a trailing row may be partially filled. True hole-free 2-D packing is out of scope.
- **The rest of the catalog** (Crew board, Workspaces, Routines, Trust scores, Discussions, Goals at risk, Memory review, Notes, Commander, Team presence, Task pipeline, Budget incidents, Workload balance) — the "as we go" tail.

---

## 2. Current state (grounded)

Home today is `ui/src/pages/Dashboard.tsx` (exported `Dashboard`) — a fixed single-column layout (`max-w-3xl`), no customization.

| Section | Source | Behavior |
|---|---|---|
| Greeting + status line | `getGreeting()`, `useLiveAgentCount()`, `getTotalActionCount()` | greeting + "N agents working · M items need attention" |
| 3 Quick-action cards | `useDialog()` | New Task / Discussion / Goal dialogs |
| Action Queue | `buildActionGroups(HomeSummary)` | Needs Review (`discussionsPendingReview`→`/discussions`, `tasksInReview`→`/issues?status=in_review`), Blocked (`blockedTasks`→`/issues?status=blocked`), Due Today (`myTasksDueToday`→`/issues/:id`) |
| Suggestions | `suggestionsApi.pending`; `SuggestionCard`; `detectSuggestions` (founder-only) | accept/dismiss inline, **founder-gated** (`canAct = isFounder`) — plus show-more, task-create callback, memory-create dialog, archive confirm, cache mutation, toasts (`Dashboard.tsx:579`, `:633`) |
| Active Goals | `HomeSummary.goalProgress` | `done/total` bars, status pill, row→`/goals/:id` |
| Today's Activity | `HomeSummary.recentActivity` | event rows, **not currently links** (`Dashboard.tsx:852`) |

**RBAC reality (corrected per Codex).** `useHomeSummary` → `HomeSummary` (`server/src/services/home.ts`). Its counts are **company-wide**, not user/department-scoped: `tasksInReview` (`home.ts:91`), `blockedTasks` (`:100`), `recentActivity` (`:166`), `goalProgress` (`:191`) all filter only by `companyId`. The one user-scoped field is `myTasksDueToday` (`:149`, `assigneeUserId = userId`). For a founding-team tool, that shared operational view is existing, intentional behavior — **not** a per-user leak. What is genuinely sensitive is the *new* Budget and Approvals data (§8.5). `progressPercent` is computed at `home.ts:248` and counts cancelled tasks in the denominator (`:234`) — a real semantic bug we fix (§11).

**Preservation requirements (replacing Home is not a clean swap).** The board host must keep: the shared `queryKeys.home(companyId)` cache the Layout WS9 first-run gate reads (`Dashboard.tsx:569`); the no-company onboarding CTA (`:710`); `firstRunCompleted`-based routing to `/onboarding` (`:730`); and a loading state (today `PageSkeleton variant="dashboard"`, `:724`).

**Persistence precedent** — `sidebar_preferences` (`packages/db/src/schema/sidebar_preferences.ts`): `id` uuid pk, `userId`/`companyId` FKs with `onDelete: cascade`, jsonb columns with defaults, `created_at`/`updated_at`, company + user indexes, unique `(userId, companyId)`.

**Primitives in repo** — React 19; `@dnd-kit/core`+`sortable` (`ui/package.json:28`); `react-resizable-panels` (`:51`). **No** grid-layout library.

---

## 3. Locked product decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Interaction model | Android-launcher board: fixed-footprint tiles, snap grid, glanceable peek + click-to-open, add from a tray, resize between preset sizes |
| D2 | Board count | One board for v1; multi-page deferred |
| D3 | Layout owner | System default + personal — built-in per-role default seeds the board; each user personalizes their own copy |
| D4 | Role defaults | Role-aware, composed from the same 8 widget types (founder/lead oversight-weighted; member execution-weighted) |
| D5 | Tile placement | **Vertical compaction** — tiles rise to fill vertical space; a trailing row may be partially filled. No free-floating gaps *above* a tile; perfect hole-free packing is not promised (§8.2) |
| D6 | Rollout | Replace Home — board becomes Home; default reproduces today's content; §2 preservation requirements hold |
| D7 | Inline actions | Only Suggestions keeps inline accept/dismiss (founder-gated, full behavior preserved); everything else acts by drill-in |
| D8 | Attention line | A thin pinned "needs attention" line stays above the board, always visible, and never blocked by board loading/error states |

---

## 4. v1 widget set (8)

`repackage` = re-renders data Home already shows; `build` = new data/UI. Every widget's data is authorized server-side (§8.5).

| Widget | Default size | Data source | Build |
|---|---|---|---|
| **Action queue** | 2×1 | `HomeSummary` (in-review, blocked, due-today, discussions) | repackage |
| **Approvals & questions** | 1×1 | **authorized endpoint** — pending approvals + `work_questions` (role-gated) | build |
| **Suggestions** | 2×1 | `suggestionsApi.pending` (+ full accept/dismiss behavior, §2) | repackage |
| **Activity feed** | 2×2 | `HomeSummary.recentActivity` | repackage |
| **Objectives** | 2×1 | `HomeSummary.goalProgress` | repackage |
| **Agents working now** | 1×1 | `useLiveAgentCount()` | build (cheap) |
| **Budget** | 1×1 | **authorized endpoint** — month spend vs budget (role-gated, §11 semantics) | build |
| **My tasks** | 2×1 | user-scoped `issues` (`assigneeUserId = me`) | build |

---

## 5. Interaction model

Three click zones: header/`›` opens the surface; a row deep-links to that item; inline actions (Suggestions only).

| Widget | Header / `›` opens | Row inside → | Inline actions |
|---|---|---|---|
| Action queue | Tasks list | that filter (In review / Blocked / Due today) | — |
| Approvals & questions | Inbox, filtered to approvals + questions | the specific approval/question | — |
| Agents working now | Agents (running now) | whole tile | — |
| Activity feed | Activity view | the entity the event is about (by `entityType`/`entityId`) | — |
| Objectives | Objectives list | that goal (`/goals/:id`) | — |
| Suggestions | all suggestions | the suggestion's target | **Accept · Dismiss** (founder-gated; Accept may open a task/memory dialog) |
| My tasks | Tasks filtered to "assigned to me" | that task (`/issues/:id`) | — |
| Budget | Budget page | whole tile | — |

**Drill-in routes are intents, verified in planning.** Some destinations do not exist as links today (activity rows aren't linked; "Activity view" / "all suggestions" / filtered-Inbox routes must be confirmed against the router). Each drill-in defines: exact route, supported `entityType`s, behavior for a missing/deleted target, and behavior when the user lacks access (no dead ends, no unauthorized navigation).

**Pinned header** (not arrangeable): greeting + needs-attention line (D8); Quick actions (`+ Task`/`+ Discussion`/`+ Goal`); `Edit board` + `Add widget`.

**Edit mode** — tiles do not navigate; they show remove `×` + snap resize handles; drag reorders; `Add widget` opens the RBAC-filtered tray; `Reset to default` restores the role default. Save semantics in §8.3.

---

## 6. Default layouts (role-aware)

Both composed from the same 8 widget types; 4-column reference grid, vertically compacted. **Role-aware here means arrangement, not data filtering** — the operational widgets show the same company-wide data to everyone (§2); the difference is which widgets lead and that the member default omits the role-gated ones (Budget, Approvals) and leans on the user-scoped `My tasks`.

**Founder / team-lead (oversight-weighted):**
```
[ Action queue 2×1 ][ Approvals 1×1 ][ Agents 1×1 ]
[ Activity feed 2×2 .......][ Objectives 2×1 ]
[ Activity feed (cont) .....][ Suggestions 2×1 ]
[ My tasks 2×1 ][ Budget 1×1 ][ + Add ]
```

**Team member (execution-weighted; no Budget/Approvals):**
```
[ My tasks 2×2 .......][ Action queue 2×1 ]
[ My tasks (cont) .....][ Objectives 2×1 ]
[ Activity feed 2×1 ][ Suggestions 2×1 (view-only) ]
[ Agents 1×1 ][ + Add ]
```

---

## 7. Widget size options

Each widget declares allowed footprints in the registry; content adapts to height. Resize snaps between allowed sizes only.

| Widget | Allowed sizes |
|---|---|
| Approvals, Agents, Budget | 1×1 (default), 2×1 |
| Action queue / Suggestions / Objectives / My tasks | 2×1 (default), 2×2 |
| Activity feed | 2×2 (default), 2×1, 4×2 |

---

## 8. Architecture

### 8.1 Widget registry (the "add as we go" core)
`ui/src/components/home/widgets/registry.ts` maps `widgetKey → WidgetDef`:

```
WidgetDef = {
  key: string
  title: string
  icon: LucideIcon
  defaultSize: { w, h }
  allowedSizes: { w, h }[]       // must include defaultSize
  requires?: Permission           // gates tray visibility (UI only — real gate is server, §8.5)
  Component: React.FC<WidgetProps>   // OWNS its own data hooks internally
}
```

**Hook-safety (Codex P1).** The board renders a stable, key-identified list of `<Component/>` instances; each widget component calls its own hooks internally. The board **never** calls a per-widget `useData` hook in a loop — that would violate React's rules-of-hooks as tiles add/remove/reorder. There is no `useData` field.

**Honest extensibility claim.** The registry removes the *board-shell* cost (grid slot, tray entry, resize/persist wiring) for a new widget. A data-backed widget still needs its own query/endpoint, shared types, server authz, possibly a migration, API client, and tests. "One module + one line" is true for the board integration, not the whole feature.

### 8.2 Grid mechanics + responsive — **phase-0 spike gate**
Candidate: `react-grid-layout` (new dep). **Blocking spike before the plan is finalized**, with explicit accept/reject criteria:
- Maintained + **React 19 / StrictMode** compatible (double-invoke safe).
- Ships or has reliable TypeScript types; bundle-size within an agreed budget.
- Controlled-layout model that round-trips our persisted layout deterministically.
- Keyboard + touch drag/resize is achievable (see §9) — or we build it.

If it fails criteria, fall back to a hand-rolled snap grid on `dnd-kit` + CSS grid (reorder + snap-resize), accepting more custom code. The plan's phase 0 is go/no-go.

**Compaction (D5).** Use vertical compaction. This does **not** guarantee zero horizontal holes with mixed-width tiles; a partially-filled trailing row is expected and acceptable. The packing behavior is pinned by tests (§13).

**Responsive vs persistence (Codex P1).** We persist **one canonical desktop layout**. Narrower breakpoints (≈4-6 → 2 → 1 columns) are **derived deterministically at render** from the canonical layout (documented clamp: a tile wider than the current column count clamps to full width; height preserved), and are **not** persisted. Editing is enabled on the desktop/canonical breakpoint only in v1, so a resize never has to be mapped back from a clamped breakpoint into a possibly-disallowed size.

### 8.3 Persistence & concurrency
New table `home_board_layouts` (Drizzle, `packages/db/src/schema/`), mirroring `sidebar_preferences` explicitly: `id` uuid pk; `userId`/`companyId` FKs `onDelete: cascade`; `layout` jsonb (`{ widgetKey, x, y, w, h }[]`); `schemaVersion` int (default 1); `created_at`/`updated_at`; company + user indexes; unique `(userId, companyId)`. Null row ⇒ role default.

**PUT contract (Codex P1).** `GET`/`PUT /companies/:cid/home-board-layout`:
- Owner derived from the **authenticated session**, never from the body; reject agent/MCP principals without a user identity; enforce company membership.
- Server validates: JSON shape, integer bounds/coords, each `w×h` ∈ that widget's `allowedSizes`, known `widgetKey`s, payload size cap, max widget count, duplicate-key policy, supported `schemaVersion`.
- Server strips any widget the caller's role may not access before persist and before returning (§8.5).

**Save semantics (Codex P1).** Edit mode holds a **draft** separate from the persisted layout. Exiting edit **flushes immediately** (not just debounced); a failed save keeps the draft, shows a dirty/retry state, and never silently drops edits. Concurrency: last-write-wins keyed on `updated_at`/a `version`, so a stale second tab can't clobber without notice.

**Layout invariants + migration (Codex P2).** Define and test: duplicate widget types allowed or not; deterministic ordering; malformed-coordinate rejection; **unknown `widgetKey`s are preserved round-trip** (not silently dropped — that's data loss) unless the schema migration explicitly retires them; `schemaVersion` upgrade path for older saved layouts.

### 8.4 Data strategy
- **`HomeSummary` carries only cheap, non-sensitive, company-wide aggregates** already present (Action queue, Objectives, Activity feed) + `useLiveAgentCount`, `suggestionsApi`.
- **Sensitive/new widgets fetch from their own lazily-loaded, authorized endpoints** (Approvals & questions, Budget, My tasks), invoked only when the widget is on the board. "Unused widget costs zero" is true **only** for these lazy endpoints — we do **not** bloat the always-fetched `HomeSummary` with budget/approvals (that would both leak data and cost queries for removed widgets).

### 8.5 Security & RBAC (server is the gate)
- The `requires` field and the tray filter are **UX only**. Authorization lives in each widget's server endpoint.
- Company-wide operational data (in-review/blocked/activity/goals) stays as-is — existing, intended founding-team visibility.
- **Budget and Approvals endpoints are role-gated server-side.** A member calling them gets 403/empty, regardless of any saved layout.
- **Layout sanitization on read:** the server strips widgets the *current* role can't access before returning a layout, so a **downgraded founder** never receives Budget data and a **promoted member** simply gains access when they next add the widget (their old layout is still valid, just missing it). Role transitions are covered by tests (§13).

### 8.6 Component structure
`ui/src/pages/Dashboard.tsx` → board host (greeting + attention line + quick actions + `HomeBoard`). `ui/src/components/home/HomeBoard.tsx` → grid, edit mode, tray, persistence. `ui/src/components/home/widgets/*` + `registry.ts`. Reuse the design-system card language (`docs/architecture/design-system.md`).

---

## 9. Accessibility
Keyboard-drivable move + resize (arrow-key reposition, modified-arrow resize snapping to allowed sizes), ARIA live-region announcements for move/resize/add/remove, focus retention across an operation, and touch (long-press) drag. This is **not** inherited from the Commander dnd-kit reorder (different library/interaction) — it is an explicit build item and part of the §8.2 spike acceptance.

---

## 10. Loading / error / empty states
- **Pinned attention line renders first and independently** — never blocked by board load/error (D8).
- Layout loading and `HomeSummary` loading each have skeletons (reuse/extend `PageSkeleton variant="dashboard"`).
- **Per-widget failure is isolated** — one widget's data error shows an in-tile error + retry, not a whole-board crash.
- Layout-save failure → dirty/retry (§8.3). Stale cached layout renders optimistically, reconciles on fetch.
- Empty board → centered `Add widget` state; header + attention line remain.

---

## 11. Edge cases
- **Role transitions** — §8.5 sanitization; tested both directions.
- **Zero-task Objectives** — hide the bar, show "no tasks yet" (not a misleading 0%).
- **`progressPercent` denominator** — exclude cancelled tasks (`denominator = total − cancelled`); fixes the 1-done+1-cancelled = 50% bug (`home.ts:248`).
- **First-run / onboarding** — the §2 preservation requirements are explicit acceptance criteria, not assumptions.
- **Unknown widget key** — preserved round-trip (§8.3), not silently dropped.

---

## 12. Out of scope / "as we go" tail
Addable later through the registry: multi-page boards (D2), founder-editable company default (D3), inline approve/answer (D7), marketplace widgets, and the remaining catalog.

---

## 13. Testing bar

All categories the project uses (CLAUDE.md § Test Patterns) apply.

- **Pure / unit**: registry lookup + `allowedSizes ⊇ defaultSize`; layout serialize/deserialize; size-clamp; **compaction/packing invariants** (deterministic, pinned); responsive **breakpoint round-trip** (canonical→derived→canonical); unknown-key round-trip; role-default selection.
- **Service (Drizzle mocks)**: `home_board_layouts` get/put; the authorized Approvals/Budget/My-tasks endpoints; extended `HomeSummary` aggregates.
- **Contract**: `GET`/`PUT` shapes; body-`userId` rejected; `HomeSummary` new fields optional-safe for old clients.
- **Component**: each widget's peek + click zones; **loading/empty/error per widget** + isolated per-widget failure; edit-mode suppresses navigation; tray RBAC-filtered; **every Suggestions branch** (founder gate, show-more, task-create callback, memory dialog, archive confirm, cache mutation, toasts); empty-board; reset-to-default; zero-task Objectives.
- **Integration (embedded-PG)**: layout round-trip; new-table migration + `unique(userId, companyId)`; schema-version migration of a legacy layout; budget/approvals aggregation.
- **Authz / RBAC**: layout route owner-scoped (no cross-user read/write); **cross-company membership**; **non-user (agent/MCP) principals rejected**; member ↛ budget/approvals (server 403); **role downgrade/upgrade** layout sanitization; malicious/malformed layout payloads (bounds, disallowed sizes, dup keys, oversized).
- **Save/concurrency**: navigation/unload during save; failed-save rollback + dirty state; **multi-tab last-write-wins**.
- **Accessibility**: keyboard move/resize/add/remove; announcements; focus retention; touch drag.
- **E2E (Playwright)**: add→resize→reorder→remove persists across reload; reset-to-default; replace-Home smoke (default reproduces today's content); founder vs member default divergence; drill-in navigation; **responsive breakpoint reflow**; mobile touch.
- **Regression / perf**: today's Home behaviors survive; **React 19 StrictMode** double-invoke; **bundle-size + query-count** regression guard for the new grid dep.
- **First-run**: `firstRunCompleted` false, legacy no-row, and no-company CTA states.

CI: integration + e2e are Linux-required (skipped on Windows) — validate locally via `AOA_E2E_FORCE_WINDOWS=1` + embedded-PG flags before claiming green.

---

## 14. Codex review resolution map (2026-07-29)

| # | Finding | Resolution |
|---|---|---|
| P1 | RBAC claim false — data is company-wide | §2 corrected; §6 reframed (arrangement not data-filtering); operational visibility accepted as existing behavior |
| P1 | Extending `HomeSummary` leaks budget/approvals | §8.4 + §8.5 — sensitive data via authorized lazy endpoints only |
| P1 | `useData` hook illegal | §8.1 — components own hooks; no board-level hook loop; field removed |
| P1 | Grid lib unresolved | §8.2 — blocking phase-0 spike with accept/reject criteria |
| P1 | a11y claim unsupported | §9 — explicit keyboard/touch a11y build item + spike criterion |
| P1 | Compaction ≠ no gaps | D5 reworded to vertical compaction; §8.2 + packing tests |
| P1 | Responsive vs persistence | §8.2 — persist canonical desktop layout; derive breakpoints; edit on canonical only |
| P1 | PUT contract underspecified | §8.3 — full ownership/membership/validation contract; never trust body `userId` |
| P1 | "Save on exit debounced" lossy | §8.3 — draft vs persisted, immediate flush, failure recovery, LWW |
| P1 | Role changes unhandled | §8.5 — server sanitizes layout against current role; §13 tests |
| P1 | "First run unchanged" insufficient | §2 preservation requirements as acceptance criteria |
| P2 | `progressPercent` counts cancelled | §11 — exclude cancelled from denominator |
| P2 | `sidebar_preferences` "exact pattern" vague | §8.3 — columns/indexes/FKs enumerated |
| P2 | data-strategy self-contradiction | §8.4 — lazy endpoints, HomeSummary not bloated |
| P2 | registry "one line" overclaim | §8.1 — board-shell only, backend work separate |
| P2 | drill-ins fictional/unspecified | §5 — routes are intents, verified in planning; missing/authz handling |
| P2 | Suggestions inventory understated | §2/§4/§13 — full behavior preserved + tested |
| P2 | layout invariants missing | §8.3 — invariants + unknown-key preservation + migration |
| P2 | budget semantics undefined | §11 open decision + §8.5 gating (currency/tz/month/policies resolved in plan) |
| P2 | loading/error rollout unspecified | §10 |
| P2 | test plan gaps | §13 expanded |
| P2 | v1 scope inflated | §15 — surfaced to founder as an explicit scope decision; resize kept per founder, spike-gated |

---

## 15. Open decisions

1. **Scope (founder's call).** Codex recommends a leaner v1: fixed responsive footprints + add/remove/reorder on existing `dnd-kit`, deferring free resize + 2-D placement. Founder chose the full Android resize model; **kept**, gated by the §8.2 spike. Revisit only if founder wants to ship faster.
2. **Budget widget semantics** — currency, timezone/month boundary, missing/unlimited/multiple policies, refunds/delayed events, and who sees spend vs limit — pinned during planning against `cost_events`/`budget_policies`.
3. **Exact drill-in routes** — verified against the router in planning (§5).

---

## 16. Next step
Founder reviews this doc → writing-plans turns it into a phased plan whose **phase 0 is the §8.2 grid-library spike (go/no-go)**, followed by schema + registry + grid + widgets + authorized endpoints + persistence + tests.
