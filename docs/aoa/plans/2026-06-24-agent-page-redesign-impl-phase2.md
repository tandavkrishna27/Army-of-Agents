# Agent Page Redesign — Phase 2 (Hero Card) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans / subagent-driven-development. TDD; commit per task.

**Goal:** Introduce a consolidated **hero card** at the top of the agent detail page (both worker + AoA, via shared `AgentDetailCore`): identity + live status pill + adapter/model badges + a KPI strip with deep-links + the actions slot + a header-error line. Replaces today's bare header row (design doc §5).

**Architecture:** New focused presentational component `AgentHeroCard` (in `ui/src/components/agent-detail/`). `AgentDetailCore` renders it in place of the current header block, threading new **optional** hero props so both existing consumers keep working and KPIs can be wired per-page incrementally. Status/icon/name/role/title derive from the `agent` prop; KPIs/badges/error are page-computed and passed down (resolves Codex P1.2 prop-contract gap).

**Scope note:** This cut renders name/title as **display** (still editable in the Config tab). Inline name/title editing + its dirty-guard (design §7.2, Codex P1.3) is sequenced as a later P2 refinement — the hero's core value doesn't depend on it. Removing the now-duplicate Overview quick-stat cards is **Phase 3** (brief intentional overlap).

**Tech Stack:** React, RTL + Vitest (`renderWithProviders`), react-router `Link`.

**Run from:** `C:/Users/TK/.aoa/wt/agent-page-redesign`. Component test: `pnpm --filter @armyofagents/ui exec vitest run <path>`. Typecheck: `pnpm --filter @armyofagents/ui exec tsc -p tsconfig.json --noEmit`. Preview: `preview_start` per the verification workflow.

---

## Component contract (`AgentHeroCard`)

```ts
export interface HeroKpi {
  key: string;            // stable id (also data-testid suffix: hero-kpi-<key>)
  label: string;
  value: React.ReactNode;
  to?: string;            // deep-link route; wraps tile in <Link>
  loading?: boolean;      // renders a placeholder dash
}

export interface AgentHeroCardProps {
  agent: Agent;                                  // icon/name/role/title/status
  kpis?: HeroKpi[];
  badges?: { adapter?: string; model?: string };
  actions?: React.ReactNode;                     // headerActions slot
  onIconChange?: (icon: string) => void;         // omit → static icon (read-only)
  error?: string | null;                         // header-error line under the card
}
```

`AgentDetailCore` gains optional props `heroKpis?`, `heroBadges?`, `headerError?` and passes them through; it already has `agent`, `headerActions`, `onIconChange`.

---

### Task 1: `AgentHeroCard` component + tests
- Create `ui/src/components/agent-detail/AgentHeroCard.tsx` (per contract above).
- Test `ui/src/components/agent-detail/__tests__/AgentHeroCard.test.tsx` (RTL via `renderWithProviders` for the router): renders name + status text (`status.replace("_"," ")`) + role/title; renders adapter (mapped via `adapterLabels`) + model badges; renders each KPI label/value with `data-testid="hero-kpi-<key>"`; a KPI with `to` renders an `<a>` (href contains the route), without `to` renders no link; renders `error` with `role="alert"`; renders the `actions` slot; icon button exposes `aria-label` when `onIconChange` given.
- TDD: write test → run (fail, module missing) → implement → run (pass) → commit.

### Task 2: Wire `AgentDetailCore` to render the hero card
- Modify `ui/src/components/agent-detail/AgentDetailCore.tsx`: add optional props `heroKpis`, `heroBadges`, `headerError`; replace the existing header `<div>` block (the icon+name+actions row) with `<AgentHeroCard agent={agent} kpis={heroKpis} badges={heroBadges} actions={headerActions} onIconChange={onIconChange} error={headerError} />`. Keep the Save bar + tab bar + `renderTab` untouched.
- Verify: existing `AoaAgentDetail.test.tsx` + `TeamDetail.smoke.test.tsx` still pass; typecheck clean. Both pages now show the hero card (status + actions + icon) even before KPIs are wired.
- Commit.

### Task 3: Worker page KPIs + badges + error
- In `ui/src/pages/AgentDetail.tsx` at the `<AgentDetailCore>` call: pass `heroBadges={{ adapter: agent.adapterType, model: (agent.adapterConfig as any)?.model }}`, `headerError={actionError}`, and `heroKpis` computed from existing data — `computeAgentKpis({ runs: heartbeats ?? [], assignedIssues })` for Tasks/Success/Cost, `trustScore` for Trust, latest run for Last run (`relativeTime`), `agent.lastHeartbeatAt` for Last heartbeat — each with a `to` deep-link (Cost→`?tab=overview`#budget, Last run→runs/<id>, etc. using the page's `canonicalAgentRef`).
- Verify: typecheck + a worker-page render test asserting the hero KPI testids appear. Commit.

### Task 4: AoA page KPIs + badges + error
- In `ui/src/pages/AoaAgentDetail.tsx`: pass `heroBadges` (adapter/model), `headerError={lifecycleError}`, and the **3-stat** `heroKpis` (Status/Role/Total runs per design D1) computed from `getAoaRuns`. No inline edit (founder gating already governs `headerActions`).
- Verify: typecheck + existing `AoaAgentDetail.test.tsx` still green. Commit.

### Task 5: Live preview verification
- `preview_start`; open a company → an agent detail page; confirm the hero card renders (status pill, badges, KPI strip), KPIs deep-link, header error path. `preview_screenshot` for the record. Fix any runtime issues, re-verify.

### Task 6: Full-suite gate
- `pnpm --filter @armyofagents/ui test:run` + typecheck green (no regressions). Commit any cleanup.

---

## Self-review
- **Spec coverage:** design §5 (hero card: identity, status, badges, KPI strip, actions, header error, prop contract). Inline-edit/dirty-guard explicitly deferred within P2 (noted).
- **Placeholder scan:** none.
- **Type consistency:** `HeroKpi`/`AgentHeroCardProps` used identically by `AgentDetailCore` pass-through and both pages; `computeAgentKpis` (Phase 1) supplies the worker KPI numbers.
- **Risk:** new optional props keep both consumers working; the only structural change is swapping the header block for `AgentHeroCard`. Visual change is additive (KPIs duplicate Overview stats until Phase 3 removes them).
