# Agent Detail Page Redesign — Design

- **Date:** 2026-06-24
- **Status:** Design (approved direction; Codex-reviewed; product defaults flagged for confirmation)
- **Branch:** `docs/agent-page-redesign`
- **Authors:** Founder + Claude (brainstorming session)
- **Scope:** Visual + interaction redesign of the agent detail page — the shared chrome (`AgentDetailCore`), the worker/org page (`AgentDetail.tsx`), and the Commander/AoA page (`AoaAgentDetail.tsx`). No backend/API/wire changes for v1; the save patch shape is preserved exactly. RBAC enforcement, Triggers edit/delete, and type-drift cleanup are flagged as separate phases.

> This is a **design doc**, not an implementation plan. It defines the target UI + interaction model, inventories every existing field/action so nothing is dropped (Appendix B), and defines the testing bar (§10). The implementation plan (phasing, tasks, file-by-file) is the follow-up via writing-plans.

> **Codex review (2026-06-24) resolutions** are folded in throughout; see §11 for the finding-by-finding map.

---

## 1. Goals & non-goals

### Goals
1. **One cohesive "hero" card** carrying identity, live status, adapter/model, key metrics, and actions — replacing today's bare header row.
2. **One consistent card language** across all tabs, aligned with `docs/architecture/design-system.md`.
3. **Tame density** — Overview from a 7-section scroll to a few scannable blocks; Config from undifferentiated stacked sections to clearly labelled, consistently styled cards.
4. **A deliberate, consistent interaction model** — exactly how each surface edits/commits, what confirms destructive actions, what every loading/empty/error/saving state looks like.
5. **Preserve 100% of existing capability.** Every field/action in Appendix B survives.
6. **Ship with tests.** Every phase lands with unit + component coverage; new e2e closes the current agent-detail e2e gap (§10).

### Non-goals (v1)
- Renaming tabs or DB tables/routes.
- Backend/API/wire-shape changes (save payload stays identical — see §6.5).
- New product capability. RBAC enforcement, Triggers edit/delete, and `Agent` type-drift fixes are flagged separately.

---

## 2. Current state (grounded)

Two pages share one chrome:

| Page | File | Agents | Tabs | Header actions |
|---|---|---|---|---|
| Worker/org | `ui/src/pages/AgentDetail.tsx` (2801 lines) | `kind: org` | Overview · Instructions · Runs · Skills · Config | Assign Task, Invoke, Pause/Resume, status badge, mobile Live pill, More menu (Configure / Copy ID / Reset Sessions / Terminate) |
| Commander/AoA | `ui/src/pages/AoaAgentDetail.tsx` (591 lines) | `kind: aoa` | Overview · Instructions · Runs · Skills · Config · **Triggers** | Pause/Resume only (founder-gated); no Invoke/Terminate |

Shared chrome `ui/src/components/agent-detail/AgentDetailCore.tsx` renders header (icon picker + name + role/title subtitle + `headerActions` slot), a floating Save/Cancel bar (`actionBar`), the tab bar (`PageTabBar`), and the active tab via `renderTab()`.

### Problems this redesign fixes
- **Bare header row** carries no live status / adapter / model / KPIs — all buried in Overview.
- **Overview is a 7-section vertical scroll** — 4 stat cards (7-day window) → trust → latest run → 4 charts (14-day) → recent tasks → budget → config summary. Dense but unscannable; stat cards duplicate data; config summary duplicates the Config tab.
- **Config is visually undifferentiated.** It already uses `sectionLayout="cards"` (collapsible bordered sections via `AgentConfigForm`), but the styling isn't aligned with the rest of the app, the storage destinations are opaque, and the read-only-vs-edit distinction isn't designed. The redesign restyles + clarifies; it does **not** "turn a long form into cards" (that's already done).
- **Skills** is a flat checkbox list, no search/grouping, and (a real bug) **no error rollback** on a failed toggle, plus stale local state after refetch.
- **Inconsistent surfaces** — Runs, Instructions, Skills, Config each invent their own layout.
- **Duplicated code** — run-row rendering, status-icon maps, and the Skills tab are **behaviorally duplicated** (not byte-identical) across worker and AoA, with subtle drift.

---

## 3. Design principles
From `docs/architecture/design-system.md`: dense-but-scannable; **contextual, not modal — inline editing over dialogs**; one card language (`rounded-lg`, `0.5px`/`border-border` borders, `shadow-sm` max, section titles `text-sm font-medium`, property rows label-left `text-xs text-muted-foreground` / value-right); status/priority via `StatusBadge`/`StatusIcon`; dark-theme default, semantic tokens only.

---

## 4. Information architecture
Keep the 5 worker tabs (Overview stays — hero carries KPIs, Overview carries the analytical dashboard). AoA keeps the 6th tab (Triggers). Hero lives in `AgentDetailCore` (both pages inherit) via an explicit prop contract — see §5.1.

```
┌──────────────────────────────── HERO CARD ────────────────────────────────┐
│ [icon] Name ● status   adapter · model            [Assign][Invoke][Pause][⋯]│
│        role — title                                                          │
│ ─────────────────────────────────────────────────────────────────────────  │
│ Tasks(wk) · Success(wk) · Cost(wk) · Trust · Last run · Last heartbeat      │
└─────────────────────────────────────────────────────────────────────────────┘
  (header error line renders directly under the hero card when present)
  Overview · Instructions · Runs · Skills · Config        (· Triggers, AoA only)
```

---

## 5. The hero card

### 5.1 Prop contract (resolves Codex P1.2)
The hero is **presentational** and lives in `AgentDetailCore`; each page computes the data and passes it in. Extend `AgentDetailCoreProps` with:

```ts
heroKpis?: HeroKpi[];            // [{ key, label, value, tone?, to?, loading? }]
heroBadges?: { adapter?: string; model?: string };
heroStatus: AgentStatus;         // drives the status pill
onIdentityEdit?: {               // inline name/title (omit → read-only, e.g. AoA non-founder)
  onNameCommit?: (v: string) => void;
  onTitleCommit?: (v: string) => void;
};
headerError?: string | null;     // actionError (worker) / lifecycleError (AoA) rendered under the card
routeBuilder: (target: AgentRouteTarget) => string;  // page owns /agents/:id vs /team/aoa/:uuid
```

- KPI **values, loading, and links are computed in the page** (`AgentDetail.tsx` ~lines 309/787; `AoaAgentDetail.tsx:338`) and passed down — the core never fetches. Each KPI may carry a `to` for deep-linking (§7.5) and a `loading` flag for skeletons.
- `routeBuilder` removes all hardcoded routes from shared children (resolves Codex P1.4 — see §6.2/§6.4).

### 5.2 Identity zone
| Element | Source | Editable? |
|---|---|---|
| Icon (48px) | `agent.icon` | Inline `AgentIconPicker` (immediate commit). |
| Name | `agent.name` | Inline (immediate) — **but see §7.2 dirty-guard.** |
| Role — title | `roleLabels[agent.role]` + `agent.title` | Title inline; role in Config. |
| Status pill | `agent.status` (`StatusBadge`) | read-only. |
| Adapter + model badges | `agent.adapterType` + `adapterConfig.model` | read-only (edit in Config). |

`pending_approval` keeps the existing amber banner + disables Invoke/Pause/Resume.

### 5.3 KPI strip (read-only; deep-links per §7.5)
Worker: **Tasks(wk)** · **Success(wk)** · **Cost(wk)** · **Trust** · **Last run** · **Last heartbeat**.
> `Last heartbeat` is added here to re-home one of the two ConfigSummary fields the old Overview carried (resolves part of Codex P1.1). The other re-homed field — **direct reports** — moves to Overview (§6.1); reports-to and capabilities are editable in Config.

AoA KPI strip: **Status · Role · Total runs** (default — see §9, Decision D1).

### 5.4 Actions zone (full inventory)
Worker: Assign Task (`Plus`) · Invoke (`Play`, disabled when pending/`pending_approval`) · Resume (`Play`, only when `paused`) / Pause (`Pause`, otherwise) · status badge (`sm:`+) · mobile Live pill (when a `running`/`queued` run exists) · More menu (`⋯`: Configure / Copy Agent ID / Reset Sessions / **Terminate**).
AoA: Pause/Resume only, **founder-gated** (`isFounder`); no Invoke/Assign/Terminate/More menu (backend hard-blocks invoke + delete for `kind=aoa`).

### 5.5 Header error placement (resolves Codex P2)
`headerError` (worker `actionError`, AoA `lifecycleError`) renders as a `text-destructive` line **directly beneath the hero card**, plus the `pending_approval` amber banner. Never silently dropped when actions move into the hero.

### 5.6 Mobile
Action labels → icon-only; Save/Cancel → fixed bottom bar; KPI strip wraps to 2 rows.

---

## 6. Per-tab redesign

### 6.1 Overview (worker) — scannable blocks
Hero owns the KPIs; `ConfigSummary` leaves Overview (it duplicated the Config tab) **but its non-Config-editable data is re-homed** (resolves Codex P1.1):

1. **Activity** card — the 4 charts (`RunActivityChart`, `PriorityChart`+legend, `IssueStatusChart`+legend, `SuccessRateChart`), 14-day window, in one card. Per-chart empty states preserved; zero-days render faint placeholder bars.
2. **Recent tasks** (left) — `EntityRow` list, `slice(0,10)`, "+N more" footer, "See All →". Empty: "No assigned tasks."
3. **Budget** (right) — aggregate tokens (input/output/cached) + total cost; per-run cost table (Date/Run/Input/Output/Cost). **Add an empty state** (today only the heading shows when empty).
4. **Org & health** card (the re-homed ConfigSummary remnants) — **Reports to** (link), **Direct reports** (links + status dots), **Last heartbeat** (also in hero KPI). Capabilities + prompt-template stay in Config (editable there).
5. **Trust score** — keep `AgentTrustScoreCard` (header + Info tooltip, big % tone-colored, progress bar, "X of Y approved", recent-20 line, trend indicator, "No data yet").

Removed from Overview: the 4 quick-stat cards (→ hero KPIs) and the bulk of `ConfigSummary` (→ Config + the Org & health card). `LatestRunCard` collapses into hero "Last run" + Runs.

### 6.2 Instructions — one framed editor
Keep the engine (`ui/src/components/AgentInstructionsTab.tsx`), reframe in card language.
- Toolbar (active file + bundle-mode + save state) over a two-pane body: resizable file rail (180–500px) + editor. Mobile = list↔editor toggle.
- File ops: select (tree + dir expand/collapse); **create** (`+`, in-memory until Save; rejects `..`); **delete** (hidden for entry/virtual/deprecated files; **ConfirmDialog**); **no rename** (entry-file input changes entry point only).
- Bundle modes (Advanced disclosure): **Managed** (root path read-only) vs **External** (editable path); switching stashes/restores the other mode's ref; entry-file input (default `AGENTS.md`).
- Loaded-skills panel: read-only chips + amber orphan chips + count + "Manage in Skills tab" link — **link uses `routeBuilder`** (resolves Codex P1.4; today it hardcodes `/agents/:id/skills`).
- Commit: **batched** behind the page Save/Cancel bar (bundle then file); `useBeforeUnload` guard.
- Not-local guard; bundle skeleton; file skeleton; warnings banner; "New file in this bundle"; saving via bar.

### 6.3 Runs — master/detail (richest tab; logic unchanged)
- **Run list** (left rail; mobile list↔detail): status icon, short id, invocation-source pill (Timer/Assignment/On-demand/Automation), relative time, summary (60-char), metrics (`tok`, `$cost`). Sort `createdAt` desc; desktop auto-selects latest. Empty: "No runs yet."
- **Run detail** — summary header: `StatusBadge` + inline actions **Cancel** (running/queued — **immediate, no confirm**; resolves Codex P2 contradiction), **Resume** (`process_lost` + failed), **Retry** (failed/timed_out, not resume-eligible), each with pending labels + error lines; timing (start→end, relative, live-ticking duration); error+errorCode; **Claude auth recovery** (login button + url + stdout/stderr); exit code/signal. Metric grid (Input/Output/Cached/Cost) when present.
- **Session row** (collapsible): Before/After IDs (`CopyText`), "(changed)" marker, **Clear session** → **ConfirmDialog**.
- **Tasks Touched** links; **stderr/stdout excerpts**; **Adapter output** (process adapter only).
- **Log viewer**: live via WebSocket (`heartbeat.run.log`/`.event`, 1.5s reconnect) + 2s polling fallback; auto-follow; invocation panel (env redacted); transcript (per-kind colored) + "Jump to live" + live ping; failure box; raw-events list. States: "Loading run logs…", "No log events.", inline `logError`, 404-log → unavailable.
- **AoA Runs** (`AoaRunsPanel`): read-only flat list off `internal_agent_runs`; **trigger-type pill** (conversation/proactive/event/sub_agent); shows duration + tool-call count + **per-run cost** (no token totals). Keep read-only; restyle to shared row language.
- **Consolidate** run-row rendering + `runStatusIcons` + source/trigger pills + `formatDuration` (duplicated/drifting) into one shared `RunRow`/`runStatus` module.

### 6.4 Skills — grouped toggle rows (shared component)
- Grouped **Attached / Available** toggle rows. **Minimum fields (non-optional — resolves Codex P3):** name, description, `key` (mono), **trust-level badge**, **source label**. Attached-agent-count omitted in v1 (Decision D2).
- **Search box** + grouping.
- Commit: **immediate per-toggle** (hybrid) with a **pending state + error rollback + toast** (fixes today's silent-failure bug).
- **Local-state resync:** re-seed `localKeys` whenever `initialSkillKeys` changes (agent refetch/navigation) — today it initializes once and goes stale (resolves Codex P2).
- Routes via `routeBuilder` (AoA paths).
- States: loading skeleton; empty ("No skills available… Create or import" → skills route via `routeBuilder`); **error state**.
- **Consolidate** `AgentSkillsTab` + `AoaSkillsTab` (behaviorally duplicate) into one component taking `{ initialSkillKeys, onChange, routeBuilder }`.

### 6.5 Config — section cards as in-place form (save shape preserved)
Section cards are the live form (edit-in-place §7.2); any change raises the shared Save/Cancel bar. **The save patch shape is unchanged** — see Appendix B for the exact field→destination mapping; contract tests (§10) lock it.

Cards: **Identity** (edit-only) · **Adapter & model** · **Permissions & Configuration** (local adapters) · **Run policy** · **Context** (edit-only) + adapter-driven `ConfigFields` slot. Below: collapsible **Permissions** ("Can create agents", worker only), **API keys**, **Configuration revisions** (restore). **Full field inventory: Appendix B** (resolves Codex P1.5 — the inventory is now embedded, not referenced).

AoA Config = form only (no Permissions/API-keys/Revisions accordions).

### 6.6 Triggers (AoA only)
Restyle `AoaTriggersTab` to card language. v1 keeps current capability — create (kind `outbox`/`manual`, `task` reserved/unbuilt) + enable/disable (immediate). **Decision D4:** no edit/delete in v1; the card layout reserves room and the gap is a flagged follow-up (§9).

---

## 7. Interaction model (cross-cutting)

### 7.1 Commit model — **hybrid**
Multi-field edit sessions batch behind Save/Cancel; discrete reversible actions commit immediately with feedback.

| Surface | Commit |
|---|---|
| Config, Instructions | **Batched** (Save/Cancel bar; Cancel reverts the batch) |
| Skills toggle | Immediate + pending + error rollback |
| Hero icon / name / title | Immediate (with §7.2 guard) |
| Pause/Resume/Invoke/Assign, Run Retry/Cancel | Immediate |
| Triggers create / enable-disable | Immediate |

### 7.2 Editing architecture — **in-place** + dirty-guard (resolves Codex P1.3)
- Config tab = live form; hero identity = inline; **create dialog is the only modal.**
- **Dirty hazard fix:** `AgentConfigForm`'s overlay clears when `props.agent` refreshes, so an immediate hero name/title save that refetches the agent could wipe unsaved Config edits. Rule: **while the Config (or Instructions) tab is dirty, inline hero name/title editing is disabled** (icon/status still read-only-safe) — the user saves or cancels first. Implementation also scopes overlay-clearing to only the fields that actually changed server-side, so an unrelated refetch can't blow away the overlay. A regression test asserts this (§10).

### 7.3 Destructive actions → ConfirmDialog
**Confirm:** Terminate, Reset Sessions, Clear session, Delete instructions file, bundle-mode switch (data-stashing). **No confirm:** Run Cancel (stops a run; not destructive of data) — resolves the §6.3/§7.3 contradiction Codex flagged.

### 7.4 State matrix (every surface: loading / empty / error / saving)
Holes to fill beyond what exists: Budget empty state; Skills error + toggle rollback; **API-keys create/revoke errors**, **Triggers create/toggle errors**, **config-revision restore error** (today these only have pending-disables, no visible error — Codex P2); consistent saving indicator tied to the Save bar. Reuse `PageSkeleton`/`Skeleton` + design-guide empty-state pattern.

### 7.5 Deep-links (resolves Codex P2 ambiguity)
- Cross-tab deep-links use `routeBuilder` → the target tab URL (e.g. Last run → Runs with `runId`; task row → task). Note: run detail hides the tab bar when `urlRunId` is set — acceptable (the run is the focus).
- **Within-Overview** targets (Cost → Budget block, Trust → Trust card) use in-page scroll-to-anchor (`id` + `scrollIntoView`), since Overview has no sub-routes. KPI tiles without a meaningful target are non-interactive (no dead links).

---

## 8. RBAC (separate phase — Decision D3)
**Reality today:** worker page calls **no** `useTeamAccess` at all; AoA gates only the header Pause/Resume on `isFounder`. All other writes (config, skills, instructions, triggers, revisions, API keys) rely solely on backend authz.
**Proposal (Phase 9, not blocking the visual redesign):** component-level read-only modes across **Config, Skills, Instructions, API keys, revisions, triggers** — editors get controls + Save bar; viewers (`team_member`) get the same cards rendered read-only (no controls); tab visibility + destructive actions founder/lead-gated. This is net-new behavior with its own tests, so it ships after the restyle. Codex flagged this as understated — captured here as a real, separately-tested phase.

---

## 9. AoA / Commander variant + product decisions

Inherits hero + tabs via shared chrome; adds Triggers; UUID-only routes (`/team/aoa/:uuid`); founder-gated Pause/Resume only; Overview = 3 stats + latest run + **AoA config rendered as a formatted summary** (today raw `JSON.stringify` of `runtimeConfig.aoa`) + instructions excerpt; Config = form only; Runs = `AoaRunsPanel`.

**Resolved product defaults (confirm on review):**
- **D1 — AoA hero stats:** keep 3-stat (Status/Role/Total runs) for v1. AoA has no aggregate task/cost/trust data (only per-run cost in `AoaRunsPanel`); don't fabricate. Revisit if aggregates land.
- **D2 — Skills metadata:** show name + description + key + trust-level badge + source label. Omit attached-agent-count v1.
- **D3 — RBAC degrade:** separate phase (§8), after the restyle.
- **D4 — Triggers edit/delete:** not in v1; reserve layout room; flagged follow-up.

---

## 10. Testing strategy (required — "everything tested properly")

**Runners:** Vitest 3.0.5 (unit/component/integration across all packages), Playwright 1.58 (e2e). **Required CI gates** (`.github/workflows/pr.yml`): `verify` (= `pnpm -r typecheck` → `pnpm test:run` → `pnpm build`) and `e2e` (= `pnpm run test:e2e`, `AOA_E2E_SKIP_LLM=true`), both Linux. macOS/Windows lanes are advisory (`continue-on-error`); Windows e2e auto-skips embedded-postgres.

New UI/component tests are picked up automatically by `pnpm test:run` (root `vitest` projects include `ui`); new e2e specs by the `e2e` gate.

### 10.1 Unit (pure functions) — `pnpm --filter @armyofagents/ui test:run`
Extract-and-test (most are module-private today; extraction is the redesign's biggest testability win):
- `runMetrics` (`AgentDetail.tsx:203`) — token/cost derivation across camel/snake keys.
- Env-redaction trio `shouldRedactSecretValue`/`redactEnvValue`/`formatEnvForDisplay` (`:85/91/110`) — security-relevant; mirror `packages/adapter-utils/src/__tests__/redact-env-for-logs.test.ts`.
- `parseAgentDetailView` (`:186`) — tab-segment → view enum.
- **Extract the `AgentOverview` KPI math** (`:787-805`: successRate, tasksCompletedThisWeek, costThisWeek, week-window) into a pure helper and test it — these feed the hero KPI strip.
- Direct `ui/src/lib/trust-score.ts` test (currently only indirectly covered).
- The new shared `runStatus`/`RunRow` module (status maps + `formatDuration`).
- Reuse existing `ui/src/lib/__tests__/format.test.ts` for formatters — don't retest.

### 10.2 Component (Vitest + jsdom + RTL via `renderWithProviders`)
Precedents: `AgentCard.test.tsx`, `AgentTrustScoreCard.test.tsx`, `AgentConfigForm.*.test.tsx`. Mock `../api/*`, `CompanyContext`, `useNavigate`, react-query; render under `TooltipProvider`.
- **Hero:** identity + status pill + adapter/model badges + KPI strip render; inline name/title commit fires `onNameCommit`; action visibility (Invoke disabled on `pending_approval`; Pause↔Resume by status; AoA founder-gated, no Invoke/Terminate); `headerError` renders; KPI deep-link `to` present.
- **Config (extend existing tests):** every section renders; adapter switch resets adapter-specific fields + blanks model/effort; conditional visibility (`isLocal` gate; opencode model required; claude advanced; openclaw edit-only fields; `SchemaConfigFields` `visibleWhen`); edit raises Save bar; **dirty-guard regression test (Codex P1.3): make Config dirty → attempt inline hero edit → assert overlay survives**; read-only mode renders no controls (Phase 9).
- **Skills (shared):** grouped attached/available; search filter; immediate toggle → pending → success; **failed toggle → rollback + toast**; **`initialSkillKeys` prop change re-seeds local state**; `routeBuilder` link.
- **Runs:** `RunRow` renders all fields; detail action visibility (Cancel running/queued; Resume `process_lost`; Retry failed/timed_out); session/clear-session confirm; log-viewer empty/loading/error.
- **Instructions:** create rejects `..`; delete confirm; entry-file change; bundle-mode switch; not-local guard; skills link via `routeBuilder`.
- **Triggers:** create (outbox/manual); enable/disable; empty state.
- **States:** each surface's loading/empty/error/saving.
- **Overview re-home (Codex P1.1):** assert direct reports + last heartbeat render in their new homes.
- **A11y/keyboard:** tab nav, segmented controls, Skills row Space/Enter, focus management on inline edit + dialogs; assert roles/`aria` (add where missing).

### 10.3 Integration / contract (server) — `pnpm --filter @armyofagents/server test:run`
Vitest node env, Proxy-table + `createSequenceDb` mocks (copy `agents-list-excludes-platform.test.ts` / `budget-hooks.test.ts`).
- **Save-shape contract test (critical):** assert the in-place form's `agentsApi.update` patch maps fields to the correct destinations — top-level columns vs `adapterConfig.*` vs `runtimeConfig.heartbeat.*` vs runtimeConfig-level (`autoRunSummary`/`aoaAppPreviews`/`injectCompanyContext`/`contextMode`), and that adapter-switch sends a full `adapterConfig` replacement. This guards the wire shape against UI refactor drift.
- Reuse existing agent route/service tests (`agents-keys-routes`, `agents-lifecycle-routes`, `agents-adapter-test-environment-route`, `aoa-agents-api`, trust/heartbeat).

### 10.4 E2E (Playwright, `local_trusted`) — `pnpm test:e2e` (Linux/CI; Windows local needs `DATABASE_URL`)
**This is the current gap — no agent-detail spec exists.** New specs in `tests/e2e/*.spec.ts`, seeding via `helpers/seed-company.ts`, fake `claude`/`codex` fixtures:
- **agent-detail:** open `/:prefix/agents/:id` → hero shows status + KPIs → edit name inline → save → reload persists.
- **config edit:** change a field → Save bar appears → Save → revision recorded; Cancel reverts.
- **skills:** toggle on → persists across reload.
- **runs:** drive a run via fake adapter → run detail renders; cancel a running run.
- **tab navigation + deep-links** (URL-segment based).
- **AoA variant:** `/team/aoa/:uuid` tabs incl Triggers; founder-gated actions.
- **Prereq:** add stable `data-testid`s to tabs, hero, Save bar, and key controls (page currently has testids only inside `AgentTrustScoreCard`).

### 10.5 Visual / design-guide
New shared components (hero, `RunRow`, shared `SkillsTab`) **must be added to the `/design-guide` showcase page** (`ui/src/pages/DesignGuide.tsx`) per project rule — serves as the manual visual reference; `brand-check` token scan stays green.

### 10.6 Definition of done (per phase)
Phase ships only when: its unit + component tests pass; happy-path e2e for the surface exists; required CI gates (`verify` + `e2e`) green; and **no field/interaction in Appendix B is left unmapped**.

---

## 11. Codex review resolution map (2026-06-24)
| Finding | Resolution |
|---|---|
| P1.1 ConfigSummary drops direct-reports/last-heartbeat | Last heartbeat → hero KPI; direct reports + reports-to → Overview "Org & health" card (§5.3/§6.1). |
| P1.2 hero prop contract underspecified | Explicit `AgentDetailCoreProps` extension (§5.1). |
| P1.3 hybrid commit wipes dirty overlay | Disable inline hero edit while Config/Instructions dirty + scope overlay-clear; regression test (§7.2/§10.2). |
| P1.4 shared comps hardcode `/agents/:id` | `routeBuilder` prop threads AoA `/team/aoa/:uuid` (§5.1/§6.2/§6.4). |
| P1.5 field inventory not in doc | Embedded as Appendix B. |
| P2 "one long form" / "AoA no cost" / "byte-for-byte" | Corrected in §2/§6.3/§6.4. |
| P2 Cancel confirm contradiction | Cancel is immediate, no confirm (§7.3). |
| P2 header error placement | §5.5. |
| P2 state matrix gaps (keys/triggers/revisions) | §7.4. |
| P2 Skills local-state resync | §6.4. |
| P2 RBAC understated | §8 (separate phase, own tests). |
| P3 skills min-display vs open-question | D2 makes the minimum non-optional (§9). |

---

## 12. Out of scope / forthcoming
- **Provider switching** (`feat/provider-switching-org`) adds provider/runtime-key selection to agents — a field group for the Config "Adapter & model" card. Design it to accommodate without restructuring.
- Trigger `task` kind (reserved, unbuilt) — leave room.

---

## 13. Implementation outline (phased; detailed plan via writing-plans)
Each phase is independently shippable, visually verifiable, and lands with its tests (§10).
1. **Shared primitives** — hero prop contract in `AgentDetailCore`, `routeBuilder`, `RunRow`/`runStatus`, extracted KPI/`runMetrics`/redaction helpers (+ their unit tests).
2. **Hero card** (both pages inherit) — inline name/title (with dirty-guard), KPI strip, deep-links, header error.
3. **Overview** restructure (3 blocks + Org & health + Trust; remove duplicated stats/config-summary).
4. **Config** restyle to card-language in-place form (preserve all Appendix-B fields + accordions + save shape) + contract test.
5. **Skills** shared component — grouped toggle rows + search + rollback + resync.
6. **Runs / Instructions** reframe to card language (logic unchanged) + `routeBuilder`.
7. **Triggers** restyle (AoA).
8. **States** pass (fill loading/empty/error/saving holes) + e2e specs.
9. *(Separate)* RBAC read-only degrade; type-drift cleanup (`kind`/`instructions`); Triggers edit/delete.

---

## Appendix A — source references
Inventory gathered from `ui/src/components/AgentConfigForm.tsx`, `agent-config-primitives.tsx`, `agent-config-defaults.ts`, `ui/src/adapters/registry.ts`, `server/src/adapters/builtin-adapter-types.ts`, `ui/src/pages/AgentDetail.tsx`, `ui/src/pages/AoaAgentDetail.tsx`, `ui/src/components/AgentInstructionsTab.tsx`, `ui/src/components/agent-detail/*`. The rebuild must reconcile field-by-field against these before deleting the old form.

## Appendix B — Full Config field inventory (no field dropped)

> Two modes: **create** (`NewAgentDialog`, `sectionLayout="inline"`) and **edit** (Config tab, `sectionLayout="cards"`, `hideInlineSave` → Save lives in page chrome). Edit uses an overlay dirty-tracking system; `handleSave` routes fields to four destinations (see end of appendix).

### B.1 Identity (edit-only)
| Field | Label | Control | Values / default | Notes |
|---|---|---|---|---|
| `name` | Name | text (immediate) | `agent.name` | server-required |
| `title` | Title | text | `agent.title ?? ""`; empty→null | |
| `role` | Role | select | `AGENT_ROLES` (cxo/lead/general) | labels Executive/Lead/General |
| `parentType`+`parentId`+`reportsTo` | Reports to | picker (`ReportsToSelect`) | `agent:<id>`/`user:<id>`/`""` | writes 3 keys; `reportsTo` set only for agent parent |
| `budgetMonthlyCents` | Monthly budget | number ($) | dollars→cents ×100; default 0 | min 0 |
| `defaultEnvironmentId` | Default Environment | select | `none`(→null)+env list | overlay group `runtime` |
| `capabilities` | Capabilities | markdown | `agent.capabilities` | |
| `promptTemplate` | Prompt Template | markdown | local-only (edit shows here) | |

In create mode, Name/Title/Role/Reports-to/Budget live in `NewAgentDialog` chrome, not the form.

### B.2 Adapter & model
| Field | Label | Control | Notes |
|---|---|---|---|
| (action) | Test environment | button | `agentsApi.testEnvironment`; pass/warn/fail result |
| `adapterType` | Adapter type | `AdapterTypeDropdown` | switching is **destructive**: clears adapterConfig + blanks model/effort/mode |
| `cwd` | Working directory | text + Browse | local-only |
| `promptTemplate` | Prompt Template | markdown | local-only, create only (edit → Identity) |
| (adapter) | — | `<uiAdapter.ConfigFields>` | per-adapter, see B.6 |

### B.3 Permissions & Configuration (local adapters only)
| Field | Label | Control | Notes |
|---|---|---|---|
| `command` | Command | text | placeholder varies by adapter |
| `model` | Model | `ModelDropdown` (search) | required for `opencode_local`; grouped-by-provider there; "Default" option except opencode |
| thinking-effort | Thinking effort | `ThinkingEffortDropdown` | **key varies:** codex→`modelReasoningEffort`, cursor→`mode`, opencode→`variant`, else `effort`; option sets differ (B.5); cursor = "mode" not effort |
| `bootstrapPromptTemplate` | Bootstrap prompt (first run) | markdown | create key `bootstrapPrompt` |
| (claude advanced) | — | `ClaudeLocalAdvancedFields` | Enable Chrome, Skip permissions, Max turns/run (default 80) — `claude_local` only |
| model-key env | Model API key | `SecretBindingPicker` | when `adapterModelKeyEnv[type]` (codex→`OPENAI_API_KEY`, claude→`ANTHROPIC_API_KEY`) + company selected |
| `extraArgs` | Extra args (comma) | text | →`string[]` |
| `env` | Environment variables | `EnvVarEditor` | plain / secret_ref rows; "Seal" creates company secret; AOA_* auto-injected |
| `timeoutSec` | Timeout (sec) | number | edit-only |
| `graceSec` | Interrupt grace (sec) | number | edit-only; default 15 |

### B.4 Run policy / Context
- **Run policy — create:** `heartbeatEnabled` (toggle), `intervalSec` (default 300, when enabled).
- **Run policy — edit:** `enabled` (default true unless explicitly false), `intervalSec` (300), `wakeOnDemand` (default true), `cooldownSec` (10), `maxConcurrentRuns` (1), `autoRunSummary` (→runtimeConfig-level, default true), `aoaAppPreviews` (→runtimeConfig-level, default true).
- **Context (edit-only):** `injectCompanyContext` (→runtimeConfig-level, default OFF), `contextMode` (`minimal`/`standard`/`full`, default `standard`).

### B.5 Thinking-effort option sets
- codex (`modelReasoningEffort`): Auto, minimal, low, medium, high.
- opencode (`variant`): Auto, minimal, low, medium, high, max.
- cursor (`mode`): Auto, plan, ask.
- default (`effort`): Auto, low, medium, high.

### B.6 Per-adapter `ConfigFields`
| adapterType | `isLocal`? | Own fields |
|---|---|---|
| `claude_local` | yes | instructions file; advanced: chrome, skip-permissions, max turns; model-key `ANTHROPIC_API_KEY` |
| `codex_local` | yes | instructions file; bypass-sandbox; search; fast-mode (gpt-5.4); model-key `OPENAI_API_KEY` |
| `cursor` | yes | instructions file; "thinking effort" = cursor mode |
| `opencode_local` | yes | instructions file; model required + grouped; effort=`variant` |
| `gemini_local` | yes | instructions file |
| `hermes_local` | yes | none extra (Command→`hermesCommand`) |
| `grok_local` | **no** | instructions file only |
| `pi_local` | **no** | own Model field + instructions file |
| `openclaw` | no | Gateway URL; edit-only: API-URL override, transport (sse/webhook), session strategy (fixed/issue/run), session key, webhook auth header, gateway auth token |
| `process` | no | command, args |
| `http` | no | url, method (POST), headers JSON, payload template JSON, timeout ms |
| `acpx_local`, `cursor_cloud`, `openclaw_gateway`, unknown/external | no | `SchemaConfigFields` — dynamic from `/api/adapters/:type/config-schema` (text/textarea/number/boolean/select/secret/json/env + `visibleWhen`) |

`isLocal = adapterType ∈ {claude_local, codex_local, opencode_local, hermes_local, gemini_local, cursor}` — gates Working dir + the whole Permissions & Configuration block. (Note: grok/pi are local CLIs but NOT in `isLocal`; their `ConfigFields` carry what they need.)

### B.7 API keys (`KeysTab`)
List active/revoked; create (name → token shown **once** with show/hide + copy + dismiss banner); revoke; no per-key reveal. (Add visible create/revoke error states — §7.4.)

### B.8 Configuration revisions
List first 10: short id · date · `source` · changed keys; **Restore** (rollback) per revision; empty "No configuration revisions yet." (Add visible restore error state — §7.4.)

### B.9 Save destinations (must be preserved — contract-tested)
- **Top-level agent columns:** name, title, role, parentType/parentId/reportsTo, budgetMonthlyCents, capabilities, defaultEnvironmentId.
- **`adapterConfig.*`:** adapter type's config (cwd, command, model, effort key, bootstrap, extraArgs, env, timeout/grace, promptTemplate, adapter-specific).
- **`runtimeConfig.heartbeat.*`:** enabled, intervalSec, wakeOnDemand, cooldownSec, maxConcurrentRuns.
- **`runtimeConfig` (top-level):** autoRunSummary, aoaAppPreviews, injectCompanyContext, contextMode.
- Adapter switch → full `adapterConfig` replacement (not a merge).
