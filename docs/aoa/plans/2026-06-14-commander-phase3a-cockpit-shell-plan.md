# Commander Phase 3a — Cockpit Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add the **cockpit** as a 4th resizable region on the Commander page — a collapsible mission-control panel — proven end-to-end with **one live card (▶ Running)** reusing the existing `/live-runs` endpoint. Establishes the panel + collapse + responsive cap + per-user prefs + card-registry + show-only-active framework that Phase 3b/3c extend.

**Architecture:** Mirror the Phase 1 viewer exactly. The cockpit is a `react-resizable-panels` `Panel` (`commander-cockpit`) added to the existing Commander `<Group>` after the detail panel; collapsed → a `w-9` semi-rail with a badge (the viewer-rail pattern). A localStorage collapse hook + a localStorage prefs store (which cards / order) mirror `useCommanderViewerCollapsed`. The **responsive "protect the chat" cap**: below ultrawide (`useBreakpoint().isWide === false`) only ONE of {detail, cockpit} may be expanded — expanding either collapses the other (chat always readable). Cards come from a small registry; **show-only-active** hides empty cards. The one card, ▶ Running, reuses the existing `/live-runs` query (`queryKeys.liveRuns`) — live via `LiveUpdatesProvider`'s heartbeat-event invalidation **plus a 5s `refetchInterval`** that covers crew/internal runs (which `internal_agent.run.status` does not invalidate).

**Tech Stack:** React + Tailwind v4; `react-resizable-panels@^4.9.0`; localStorage prefs (no backend/schema change this slice).

**Scope (locked with founder): THIN VERTICAL SLICE, localStorage prefs.**
- IN: 4th panel + collapse (full / semi-rail) + responsive cap + ⚙ config (show/hide) + show-only-active + prefs (localStorage) + the ▶ Running card (reuses `/live-runs`).
- OUT (later sub-phases): the batched `/cockpit` endpoint + `cockpitScope` + the other default cards + row interactions/Ask↩ (3b); `user_entity_pins` + opt-in cards + "In this conversation" zone (3c); the "hidden" (full-focus) collapse state, card drag-reorder, mobile tab-bar, and "Brief me" (deferred — noted inline). **No backend, schema, or `/cockpit` endpoint this slice.**

**Verified anchors (read before editing):**
- `ui/src/components/InternalAgentPanel.tsx`: hooks `:420-436` (`useDefaultLayout({id:"aoa:commander:panel-sizes", panelIds:["commander-chat","commander-detail"]})`, `useCommanderViewerCollapsed`, `expandViewer`/`collapseViewer`, the auto-open bridge effect); desktop return `:1395-1437` (the `<Group>` with `Panel#commander-chat` + conditional `Separator`+`Panel#commander-detail`, and the `{viewerCollapsed && <CommanderViewerRail …/>}` sibling). **This is what I extend.**
- `ui/src/components/commander/useCommanderViewerCollapsed.ts` (whole file) — the localStorage hook TEMPLATE.
- `ui/src/components/commander/viewer/CommanderViewerPanel.tsx`: `CommanderViewerRail` (the `w-9 … py-2` rail + `COMMANDER_PANEL_CARD`) + `CommanderViewerDetail` — the panel/rail TEMPLATE.
- `ui/src/components/commander/commanderChrome.ts` — `COMMANDER_PANEL_CARD`.
- `ui/src/lib/useBreakpoint.ts` — `isWide` (`WIDE_MIN = 1536`), `useDrawerSessions`.
- `ui/src/context/LiveUpdatesProvider.tsx` — `useLiveUpdates()`; it already invalidates react-query on `heartbeat.run.*` etc. (so reusing the live-runs query key gives live updates).
- The existing **live-runs query**: grep `live-runs` in `ui/src` to find the api client + query key (e.g. `agentsApi`/`queryKeys`) the Commander page already calls (`GET /companies/:cid/live-runs`). **Reuse that exact query key** so the Running card inherits invalidation.
- `ui/src/components/ui/card.tsx` + `ui/src/components/ui/popover` — card/popover primitives.

---

## Task 1: localStorage hooks — cockpit collapse + prefs (TDD)

**Files:**
- Create: `ui/src/components/commander/useCommanderCockpitCollapsed.ts`
- Create: `ui/src/components/commander/useCommanderCockpitPrefs.ts`
- Create: `ui/src/components/commander/useCommanderCockpit.test.ts`

- [ ] **Step 1: Failing tests**
```ts
// ui/src/components/commander/useCommanderCockpit.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { cockpitCollapsedKey, useCommanderCockpitCollapsed } from "./useCommanderCockpitCollapsed";
import { cockpitPrefsKey, useCommanderCockpitPrefs, DEFAULT_COCKPIT_PREFS } from "./useCommanderCockpitPrefs";

describe("useCommanderCockpitCollapsed", () => {
  beforeEach(() => localStorage.clear());
  it("key + default semi (collapsed=true)", () => {
    expect(cockpitCollapsedKey()).toBe("aoa:commander:cockpit-collapsed");
    const { result } = renderHook(() => useCommanderCockpitCollapsed());
    expect(result.current[0]).toBe(true);
  });
  it("persists", () => {
    const { result } = renderHook(() => useCommanderCockpitCollapsed());
    act(() => result.current[1](false));
    expect(localStorage.getItem("aoa:commander:cockpit-collapsed")).toBe("false");
  });
});

describe("useCommanderCockpitPrefs", () => {
  beforeEach(() => localStorage.clear());
  it("key + default (Running on)", () => {
    expect(cockpitPrefsKey()).toBe("aoa:commander:cockpit-prefs");
    const { result } = renderHook(() => useCommanderCockpitPrefs());
    expect(result.current[0].hidden).toEqual(DEFAULT_COCKPIT_PREFS.hidden);
  });
  it("toggling a card hidden persists", () => {
    const { result } = renderHook(() => useCommanderCockpitPrefs());
    act(() => result.current[1]({ ...result.current[0], hidden: ["running"] }));
    expect(JSON.parse(localStorage.getItem("aoa:commander:cockpit-prefs")!).hidden).toEqual(["running"]);
  });
});
```

- [ ] **Step 2: Implement the collapse hook** (copy `useCommanderViewerCollapsed.ts`, rename key → `aoa:commander:cockpit-collapsed`, default `true` = semi-rail). Export `cockpitCollapsedKey()` + `useCommanderCockpitCollapsed()`.

- [ ] **Step 3: Implement the prefs store**
```ts
// ui/src/components/commander/useCommanderCockpitPrefs.ts
import { useCallback, useEffect, useState } from "react";

export function cockpitPrefsKey(): string {
  return "aoa:commander:cockpit-prefs";
}

/** Per-user-per-browser cockpit prefs. `hidden` = card ids the user turned off
 *  (overrides show-only-active for those). `order` = explicit card order (ids);
 *  empty = registry default order. 3c extends with `pinned`. */
export interface CockpitPrefs {
  hidden: string[];
  order: string[];
}
export const DEFAULT_COCKPIT_PREFS: CockpitPrefs = { hidden: [], order: [] };

function loadPrefs(): CockpitPrefs {
  try {
    const v = localStorage.getItem(cockpitPrefsKey());
    if (!v) return DEFAULT_COCKPIT_PREFS;
    const p = JSON.parse(v) as Partial<CockpitPrefs>;
    return { hidden: Array.isArray(p.hidden) ? p.hidden : [], order: Array.isArray(p.order) ? p.order : [] };
  } catch {
    return DEFAULT_COCKPIT_PREFS;
  }
}

export function useCommanderCockpitPrefs(): readonly [CockpitPrefs, (next: CockpitPrefs) => void] {
  const [prefs, setState] = useState<CockpitPrefs>(() => loadPrefs());
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === cockpitPrefsKey()) setState(loadPrefs());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const setPrefs = useCallback((next: CockpitPrefs) => {
    setState(next);
    try { localStorage.setItem(cockpitPrefsKey(), JSON.stringify(next)); } catch { /* ignore */ }
  }, []);
  return [prefs, setPrefs] as const;
}
```

- [ ] **Step 4: Run → PASS. Commit.**
```bash
git add ui/src/components/commander/useCommanderCockpitCollapsed.ts ui/src/components/commander/useCommanderCockpitPrefs.ts ui/src/components/commander/useCommanderCockpit.test.ts
git commit -m "feat(commander): cockpit collapse + prefs localStorage hooks (Phase 3a)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Card registry + show-only-active model + the ▶ Running card (TDD for the pure bits)

**Files:**
- Create: `ui/src/components/commander/cockpit/cockpitCardModel.ts` (pure: registry types + visible-cards selection)
- Create: `ui/src/components/commander/cockpit/cockpitCardModel.test.ts`
- Create: `ui/src/components/commander/cockpit/CockpitRunningCard.tsx`

- [ ] **Step 1: Pure model + failing test.** The model decides which cards render given the registry, prefs, and per-card "active" (has data) flags. Rule: a card renders if **not hidden by prefs** AND (**active** OR explicitly kept — for 3a, show-only-active: hidden-when-empty). Order = prefs.order first, then registry default order.
```ts
// cockpitCardModel.ts
export interface CockpitCardDef {
  id: string;
  title: string;
  /** lucide icon name handled by the component; kept out of the pure model */
  defaultOn: boolean;
}
export interface CockpitVisibilityInput {
  registry: CockpitCardDef[];
  hidden: string[];          // prefs.hidden
  order: string[];           // prefs.order
  active: Record<string, boolean>; // cardId -> has data
}
/** Cards to render, in order. show-only-active: drop empty cards (unless a future pin). */
export function selectVisibleCards(input: CockpitVisibilityInput): CockpitCardDef[] {
  const { registry, hidden, order, active } = input;
  const byId = new Map(registry.map((c) => [c.id, c]));
  const ordered = [
    ...order.map((id) => byId.get(id)).filter((c): c is CockpitCardDef => !!c),
    ...registry.filter((c) => !order.includes(c.id)),
  ];
  return ordered.filter((c) => !hidden.includes(c.id) && c.defaultOn && active[c.id] === true);
}
```
Test: empty `active` → no cards; `active.running=true` → running shown; `hidden:["running"]` → hidden even when active; `order` reorders.

- [ ] **Step 2: Implement + run → PASS.**

- [ ] **Step 3: The Running card.** Reuse the EXISTING live-runs query (verified by Codex): key `queryKeys.liveRuns(companyId)` (= `["live-runs", companyId]`, `ui/src/lib/queryKeys.ts:125`) + fn `heartbeatsApi.liveRunsForCompany(companyId)` (`ui/src/api/heartbeats.ts`). The response is `LiveRunForIssue[]` with `{ id, status, startedAt, createdAt, agentId, agentName, issueId?, source }` — **there is NO `issueTitle`** (Codex #3), so render from `agentName` + `status` (do NOT reference a title). **`refetchInterval: 5000`** is required (Codex #1): `LiveUpdatesProvider` invalidates this key on `heartbeat.run.*` + `issue.status_changed` but NOT on `internal_agent.run.status`, so crew/internal runs need the poll — this is the same fallback the existing live-runs consumers use. The card self-reports emptiness via `onActiveChange` (parent's show-only-active).
```tsx
// CockpitRunningCard.tsx
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { heartbeatsApi, type LiveRunForIssue } from "../../../api/heartbeats"; // confirm relative path
import { queryKeys } from "../../../lib/queryKeys";
import { Play } from "lucide-react";

export function CockpitRunningCard({ companyId, onActiveChange }: { companyId: string; onActiveChange: (active: boolean) => void }) {
  const { data } = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    enabled: !!companyId,
    refetchInterval: 5000, // crew runs aren't covered by LiveUpdates invalidation (Codex #1)
  });
  // /live-runs backfills terminal runs to a min count; keep only in-flight ones for "Running now".
  const runs = ((data ?? []) as LiveRunForIssue[]).filter((r) => r.status === "running" || r.status === "queued");
  useEffect(() => { onActiveChange(runs.length > 0); }, [runs.length, onActiveChange]);
  if (runs.length === 0) return null;
  return (
    <section className="rounded-lg border border-border bg-background p-2" data-testid="cockpit-card-running">
      <header className="mb-1 flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
        <Play className="size-3.5" aria-hidden /> Running now
        <span className="ml-auto tabular-nums">{runs.length}</span>
      </header>
      <ul className="space-y-0.5">
        {runs.map((r) => (
          <li key={r.id} className="flex items-center gap-1 truncate rounded px-1 py-1 text-xs hover:bg-muted/50">
            <span className="truncate font-medium">{r.agentName ?? "Agent"}</span>
            <span className="ml-auto shrink-0 text-[10px] uppercase text-muted-foreground">{r.status}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
```
(Confirm the exact `heartbeats` import path + the `running`/`queued` status strings against `ui/src/api/heartbeats.ts` when wiring.) No commit yet — committed with Task 3.

---

## Task 3: Cockpit panel + semi-rail components (+ ⚙ config)

**Files:**
- Create: `ui/src/components/commander/cockpit/CommanderCockpitPanel.tsx` (exports `CommanderCockpitPanel`, `CommanderCockpitRail`, `COCKPIT_REGISTRY`)

- [ ] **Step 1: The registry** (3a has one card; 3b/3c push more):
```ts
import { CockpitRunningCard } from "./CockpitRunningCard";
import type { CockpitCardDef } from "./cockpitCardModel";
export const COCKPIT_REGISTRY: (CockpitCardDef & { render: (p: { companyId: string; onActiveChange: (a: boolean) => void }) => JSX.Element })[] = [
  { id: "running", title: "Running now", defaultOn: true, render: (p) => <CockpitRunningCard {...p} /> },
];
```

- [ ] **Step 2: `CommanderCockpitPanel` (full state).** Header (title + item count + ⚙ config popover + a collapse-to-rail button) over the cards. It owns the per-card `active` map (cards call `onActiveChange`) and uses `selectVisibleCards`. When no card is active → an "All clear" empty state. Uses `COMMANDER_PANEL_CARD` like `CommanderViewerDetail`; `data-testid="commander-cockpit-panel"`.
```tsx
export function CommanderCockpitPanel({ companyId, onCollapse }: { companyId: string; onCollapse: () => void }) {
  const [prefs, setPrefs] = useCommanderCockpitPrefs();
  const [active, setActive] = useState<Record<string, boolean>>({});
  const onActiveChange = useCallback((id: string, a: boolean) =>
    setActive((m) => (m[id] === a ? m : { ...m, [id]: a })), []);
  const visible = selectVisibleCards({ registry: COCKPIT_REGISTRY, hidden: prefs.hidden, order: prefs.order, active });
  return (
    <div data-testid="commander-cockpit-panel" className={cn("relative flex h-full min-w-0 flex-1 flex-col", COMMANDER_PANEL_CARD)}>
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2 text-xs font-medium">
        <span>Cockpit</span>
        <div className="ml-auto flex items-center gap-0.5">
          <CockpitConfigPopover prefs={prefs} setPrefs={setPrefs} registry={COCKPIT_REGISTRY} />
          <button type="button" aria-label="Collapse cockpit" title="Collapse cockpit" onClick={onCollapse}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground">
            <ChevronsRight className="size-3.5" aria-hidden />
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {/* All registry cards mount (so each can report active), but each returns null when empty.
            The "All clear" state shows when nothing is visible. */}
        {COCKPIT_REGISTRY.filter((c) => !prefs.hidden.includes(c.id) && c.defaultOn).map((c) => (
          <div key={c.id} className="mb-2 last:mb-0">{c.render({ companyId, onActiveChange: (a) => onActiveChange(c.id, a) })}</div>
        ))}
        {visible.length === 0 && (
          <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
            All clear — nothing needs you right now.
          </div>
        )}
      </div>
    </div>
  );
}
```
(Note: cards mount to self-report `active`; they render `null` when empty, so only active ones show — show-only-active. `selectVisibleCards` drives the "All clear" decision. `CockpitConfigPopover` = a small popover listing registry cards with a show/hide checkbox writing `prefs.hidden`.)

- [ ] **Step 3: `CommanderCockpitRail` (semi state).** Mirror `CommanderViewerRail` (`w-9 … py-2` + `COMMANDER_PANEL_CARD`); an expand button + a badge of the action count (3a: total running; 3b refines to ⚡"need you"). Pulse-on-new can reuse the pill badge styling (defer the pulse to 3b — static badge in 3a). `data-testid="commander-cockpit-rail"`.
```tsx
export function CommanderCockpitRail({ badge, onExpand }: { badge: number; onExpand: () => void }) {
  return (
    <div data-testid="commander-cockpit-rail" className={cn("flex h-full w-9 shrink-0 flex-col items-center gap-1 py-2", COMMANDER_PANEL_CARD)}>
      <button type="button" aria-label="Expand cockpit" title="Expand cockpit" onClick={onExpand}
        className="relative flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground">
        <LayoutDashboard className="size-3.5" aria-hidden />
        {badge > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-brand px-1 text-[10px] font-semibold text-white">{badge}</span>
        )}
      </button>
    </div>
  );
}
```
(For 3a the rail badge can be 0/static; the live count wires in 3b. Keep the prop so 3b just feeds it.)

- [ ] **Step 4: Commit** (Tasks 2+3 together — they're one cohesive UI unit):
```bash
git add ui/src/components/commander/cockpit/
git commit -m "feat(commander): cockpit panel + rail + Running card + card registry (Phase 3a)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Compose the cockpit into the Commander group (4th region + responsive cap)

**Files:**
- Modify: `ui/src/components/InternalAgentPanel.tsx`
- Modify: `ui/src/components/commander/viewer/index.ts` barrel? NO — import cockpit from its own path.

- [ ] **Step 1: Imports + hooks.** Add:
```ts
import { useBreakpoint } from "../lib/useBreakpoint"; // already imported — confirm
import { useCommanderCockpitCollapsed } from "./commander/useCommanderCockpitCollapsed";
import { CommanderCockpitPanel, CommanderCockpitRail } from "./commander/cockpit/CommanderCockpitPanel";
```
After `useCommanderViewerCollapsed` (`:426`):
```ts
const [cockpitCollapsed, setCockpitCollapsed] = useCommanderCockpitCollapsed();
const { isWide } = useBreakpoint();
```

- [ ] **Step 2: Responsive cap — make expand handlers cap-aware.** Replace Phase 1's `expandViewer` (`:428`) and add `expandCockpit`; below ultrawide, expanding one collapses the other (chat protected; "last expanded wins"; viewer auto-open also yields the cockpit):
```ts
const expandViewer = useCallback(() => {
  setViewerCollapsed(false);
  if (!isWide) setCockpitCollapsed(true);
  viewer.expand();
}, [setViewerCollapsed, setCockpitCollapsed, isWide, viewer]);
const collapseViewer = useCallback(() => { setViewerCollapsed(true); viewer.collapse(); }, [setViewerCollapsed, viewer]);
const expandCockpit = useCallback(() => {
  setCockpitCollapsed(false);
  if (!isWide) setViewerCollapsed(true);
}, [setCockpitCollapsed, setViewerCollapsed, isWide]);
const collapseCockpit = useCallback(() => setCockpitCollapsed(true), [setCockpitCollapsed]);
```
The existing auto-open bridge effect (`:434`) stays as-is (it calls `setViewerCollapsed(false)`; to also yield the cockpit below wide, route it through the cap): change it to
```ts
useEffect(() => {
  if (viewer.state.expanded && viewerCollapsed) {
    setViewerCollapsed(false);
    if (!isWide) setCockpitCollapsed(true);
  }
}, [viewer.state.expanded, viewerCollapsed, isWide, setViewerCollapsed, setCockpitCollapsed]);
```

- [ ] **Step 2b: Resize-cap effect** (Codex #2 — the handlers alone don't catch a wide→narrow viewport resize, so both could stay open and starve the chat). Add ONE effect; viewer wins (design arbitration → collapse the cockpit):
```ts
// Enforce the one-right-panel cap when the viewport crosses below ultrawide with
// both expanded. Loop-free: once cockpit collapses the guard fails. React batches
// the expand handlers' paired setStates, so this fires only on a genuine resize.
useEffect(() => {
  if (!isWide && !viewerCollapsed && !cockpitCollapsed) setCockpitCollapsed(true);
}, [isWide, viewerCollapsed, cockpitCollapsed, setCockpitCollapsed]);
```

- [ ] **Step 3: Extend the layout panelIds** (`:421-425`):
```ts
panelIds: ["commander-chat", "commander-detail", "commander-cockpit"],
```

- [ ] **Step 4: Add the cockpit to the desktop return** (`:1395-1437`). After the detail `Panel` block (still inside `<Group>`), add a conditional cockpit `Separator`+`Panel`; after the `{viewerCollapsed && <CommanderViewerRail …/>}` sibling, add the cockpit rail sibling. Exact target:
```tsx
      </Group>  // existing closing
```
becomes — INSIDE the Group, after the `{!viewerCollapsed && (<>…detail…</>)}` block, append:
```tsx
        {!cockpitCollapsed && (
          <>
            <Separator
              id="commander-cockpit-sep"
              className="w-2 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-brand/50 active:bg-brand/60"
            />
            <Panel id="commander-cockpit" defaultSize="28%" minSize="20%" maxSize="40%" className="flex h-full min-w-0 overflow-hidden">
              <CommanderCockpitPanel companyId={companyId} onCollapse={collapseCockpit} />
            </Panel>
          </>
        )}
```
and after `{viewerCollapsed && <CommanderViewerRail … />}` (the existing sibling), add:
```tsx
      {cockpitCollapsed && <CommanderCockpitRail badge={0} onExpand={expandCockpit} />}
```
(3a feeds `badge={0}`; 3b computes the real count. The outer wrapper's `gap-2` spaces chat-group↔rails; with both viewer + cockpit collapsed there are two rails after the Group — they sit side by side with the uniform 8px gap.)

- [ ] **Step 5:** `cd ui ; pnpm tsc -b` clean. Commit:
```bash
git add ui/src/components/InternalAgentPanel.tsx
git commit -m "feat(commander): mount cockpit as 4th resizable region + responsive one-panel cap (Phase 3a)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Component test + full verification

**Files:**
- Create: `ui/src/components/commander/cockpit/CommanderCockpitPanel.test.tsx`

- [ ] **Step 1: Component test** — mock the live-runs query; assert (a) with runs → the Running card renders (`commander-cockpit-panel` shows `cockpit-card-running`); (b) with no runs → "All clear" empty state; (c) the ⚙ config can hide the card (toggle → card gone). Mock `react-resizable-panels` is NOT needed (the panel component renders standalone, outside the Group).

- [ ] **Step 2: Static + unit**
  - `cd ui ; pnpm vitest run src/components/commander/` → green (the 2 new hook tests + model test + panel test + all prior).
  - `cd ui ; pnpm tsc -b` → clean.

- [ ] **Step 3: Live verify (real browser, pgvector)** — capture + read screenshots: (1) desktop default — chat + viewer rail + **cockpit semi-rail** (two rails right of the chat, uniform gaps); (2) expand the cockpit (click the rail) → cockpit panel with the "All clear" empty state (no running agent seeded); (3) on a non-ultrawide width, expand the viewer → confirm the cockpit auto-collapses to its rail (responsive cap), and vice-versa; (4) mobile (480px) — confirm the page isn't broken (cockpit desktop-only this slice; mobile tab-bar is 3c). Also run the existing viewer e2e (`commander-viewer.spec.ts` + `commander-viewer-persistence.spec.ts`) → must stay green (no regression from the 4th panel / cap changes).

- [ ] **Step 4:** Tear down throwaway DB/specs; clean tree (only 3a commits). Do NOT `finishing-a-development-branch` (3b/3c remain).

---

## Self-review (run after drafting; fix inline)

- **Scope:** thin slice honored — shell + 1 card + localStorage prefs; NO `/cockpit` endpoint, NO schema, NO `cockpitScope`, NO other cards/interactions (3b), NO pins/opt-in/session-zone (3c). "Hidden" state, drag-reorder, mobile tab-bar, pulse, "Brief me" explicitly deferred.
- **Mirrors proven patterns:** collapse + prefs hooks copy `useCommanderViewerCollapsed`; panel/rail copy `CommanderViewerDetail`/`Rail` + `COMMANDER_PANEL_CARD`; the 4th Panel mirrors Phase 1's conditional detail Panel exactly (same `panelIds`-conditional pattern Codex already cleared for Phase 1).
- **Responsive cap correctness:** below `isWide`, expanding viewer collapses cockpit and vice-versa; auto-open routes through the cap; a **resize-cap effect** (Task 4 Step 2b) catches a wide→narrow viewport change (Codex #2); above wide both may open. Chat `minSize 40%` protects it regardless. Verify in the live gate (Step 3.3).
- **Live:** the Running card reuses the existing `/live-runs` key (heartbeat-event invalidation) **+ a 5s `refetchInterval`** covering crew runs that `internal_agent.run.status` doesn't invalidate (Codex #1). No new subscription/provider code. The row renders `agentName` + `status` only — `/live-runs` has no `issueTitle` (Codex #3).
- **show-only-active:** cards self-report `active` via `onActiveChange`; empty cards render `null`; `selectVisibleCards` drives "All clear". prefs.hidden overrides.
- **Type consistency:** `CockpitPrefs {hidden, order}` used by the prefs hook (T1), `selectVisibleCards` (T2), the panel + config popover (T3); `COCKPIT_REGISTRY` shape (T3) matches `CockpitCardDef` (T2); collapse hook signature matches the viewer's.
- **No regression surface:** only InternalAgentPanel's desktop return + hooks change (Phase 1 viewer logic preserved; mobile branch untouched — cockpit is desktop-only this slice). The existing viewer e2e is the regression gate.
