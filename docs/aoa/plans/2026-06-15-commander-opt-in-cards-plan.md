# Commander Cockpit — Opt-in Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add the **opt-in card mechanism** (cards that are OFF by default and the user turns ON) plus the first three opt-in cockpit cards — **Goals at risk**, **Budget pulse** (founder/lead-gated), and **Done today** — all reading existing data via the batched `/cockpit` endpoint.

**Architecture:** Extend `CockpitPrefs` with an `enabled: string[]` set (backward-compatible) and relax `mountableCards` so a card mounts when `!hidden && (defaultOn || enabled.includes(id))`. The config popover gains an "Optional" section listing `defaultOn:false` cards as unchecked toggles. Three new presentational cards + three new `/cockpit` slices (server-side), each scoped: Goals-at-risk is company-scoped (goals have no dept RBAC today); Budget pulse is gated to founder/lead and `null` otherwise; Done-today is founder→company-wide / else→own-assigned. Each card returns `null` when empty (mirrors existing cards), so enabling an empty card shows nothing — same as the default cards.

**Tech Stack:** React + react-query (UI prefs, cards), Express + Drizzle (the 3 read queries). No schema change.

**Scope (v1):**
- IN: the enable mechanism (prefs `enabled` + popover "Optional" section); Goals-at-risk card (status='at_risk'); Budget pulse card (founder/lead, limit=`company.budgetMonthlyCents`, spend=`cost_events` month sum, open incidents); Done-today card (tasks with `completedAt` today).
- OUT → follow-ups: the other opt-in cards (Proactive findings, Teammates' activity, Quick capture); done-today including artifacts/activity_log + per-department lead scoping; budget fallback to `budget_policies` when no `budgetMonthlyCents`; company/user timezone for "today" (v1 uses server-local midnight, consistent with the existing `endOfToday`).

**Verified anchors (read before editing):**
- Prefs/registry: `ui/src/components/commander/useCommanderCockpitPrefs.ts` (`CockpitPrefs {hidden, order}`, key `aoa:commander:cockpit-prefs`, load/normalize at ~:16-41); `ui/src/components/commander/cockpit/cockpitCardModel.ts` (`CockpitCardDef {id,title,defaultOn}` :4-9, `mountableCards` :30-36 **requires defaultOn**, `selectVisibleCards` :40-43, `orderCards`); `CommanderCockpitPanel.tsx` (`COCKPIT_REGISTRY` ~:65, `CockpitConfigPopover` :154-202, render loop calls `mountableCards(...)` :274, `active` map :242, `visible`/All-clear :247-253).
- Cockpit engine: `server/src/services/cockpit.ts` (`get()` :306, the `Promise.all` :320-423, the `return {...}` :498-516, `endOfToday()` :52-56, `inArray`/`and`/`eq`/`desc`/`sql` imported :27); `cockpit-scope.ts` (`CockpitScope {userId,role,isFounder,leadDepartmentIds}`, `resolveCockpitScope`); `packages/shared/src/cockpit.ts` (`CockpitData` :63) + root export `packages/shared/src/index.ts` :1003-1014.
- Sources: `goals` (`status` incl. `at_risk`, `id/title/level/status/ownerAgentId`, company-scoped, `packages/db/src/schema/goals.ts`); `companies.budgetMonthlyCents` (reliable limit), `cost_events.costCents`/`occurredAt` (spend), `budget_incidents` (`status='open'`); `issues.completedAt` (`packages/db/src/schema/issues.ts:67`). Budget month window = UTC calendar month (mirror `budgets.ts:14-19`).
- Open routes: goal → `onOpenFullPage('/goals/'+id)`; task → `onOpenTask(id,title)` (both already threaded in `CockpitInteractions`).

---

## Task 1: Shared types + `CockpitData` fan-out

**Files:** `packages/shared/src/cockpit.ts`, `packages/shared/src/index.ts`.

- [ ] **Step 1:** Add + export from root:
```ts
export interface CockpitGoalsAtRiskItem {
  id: string;
  title: string;
  level: string;
  ownerAgentId: string | null;
}
export interface CockpitBudgetPulseItem {
  limitCents: number;
  spentCents: number;
  percentUsed: number;        // 0 when limitCents === 0 (guarded)
  openIncidentCount: number;
}
export interface CockpitDoneTodayItem {
  id: string;
  identifier: string | null;
  title: string;
}
```
Add to `CockpitData`: `goalsAtRisk: CockpitGoalsAtRiskItem[]`, `budgetPulse: CockpitBudgetPulseItem | null`, `doneToday: CockpitDoneTodayItem[]`. Export the 3 new symbols from `packages/shared/src/index.ts` (the `from "./cockpit.js"` block ~:1003-1014).
- [ ] **Step 2: Required-field fan-out** (these are non-optional on `CockpitData` — omitting any breaks typecheck/tests, same as the `pinned`/`approvals` pattern). Add to every `CockpitData` literal: `goalsAtRisk: [], budgetPulse: null, doneToday: []`:
  - `EMPTY_DATA` in `ui/src/components/commander/cockpit/CommanderCockpitPanel.tsx`.
  - the `cockpitApi.get` mock + every `satisfies CockpitData` literal in `ui/src/components/commander/cockpit/cockpitCards.test.tsx`, and `CommanderCockpitPanel.test.tsx`.
  - the server `cockpitService.get()` return (done in Task 2) + any `CockpitData` literal in `server/src/__tests__/cockpit-approvals.test.ts`.
  - **`server/src/__tests__/cockpit-route.test.ts`** — the cockpit response fixture (~:36-42) (Codex #3). It isn't typed `CockpitData` so typecheck won't catch it, but the route-contract fixture goes stale; bring it to the full current shape (it should already carry `approvals`/`pinned`) + add `goalsAtRisk: [], budgetPulse: null, doneToday: []`. Grep the repo for `goalsAtRisk`/`budgetPulse`/`doneToday` after editing to confirm no other literal is missed.
- [ ] Shared typecheck clean. Commit.

---

## Task 2: Backend — three `/cockpit` slices

**Files:** `server/src/services/cockpit.ts`; test `server/src/__tests__/cockpit-optin.test.ts`.

- [ ] **Step 1: `startOfToday` helper** (mirror `endOfToday` :52-56, server-local):
```ts
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function utcMonthWindow(): { start: Date; end: Date } {
  const n = new Date();
  return {
    start: new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)),
    end: new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1)),
  };
}
```

- [ ] **Step 2: Three resolver functions** (add near `cockpitPinned`):
```ts
async function cockpitGoalsAtRisk(db: Db, companyId: string): Promise<CockpitGoalsAtRiskItem[]> {
  const rows = await db
    .select({ id: goals.id, title: goals.title, level: goals.level, ownerAgentId: goals.ownerAgentId })
    .from(goals)
    .where(and(eq(goals.companyId, companyId), eq(goals.status, "at_risk")))
    .orderBy(desc(goals.updatedAt))
    .limit(20);
  return rows;
}

async function cockpitBudgetPulse(db: Db, companyId: string, scope: CockpitScope): Promise<CockpitBudgetPulseItem | null> {
  // Founder-only v1 (Codex #5): budget is sensitive and the company-wide figure is
  // broader than a dept lead should see. Dept-scoped lead budget is a follow-up.
  // (Matches the Approvals card's founder-only precedent.)
  if (!scope.isFounder) return null;
  const [company] = await db.select({ limitCents: companies.budgetMonthlyCents }).from(companies).where(eq(companies.id, companyId));
  const limitCents = company?.limitCents ?? 0;
  if (limitCents === 0) return null; // no budget configured → nothing to pulse
  const { start, end } = utcMonthWindow();
  const [{ spent }] = await db
    .select({ spent: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
    .from(costEvents)
    .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, start), lt(costEvents.occurredAt, end)));
  const [{ incidents }] = await db
    .select({ incidents: sql<number>`count(*)::int` })
    .from(budgetIncidents)
    .where(and(eq(budgetIncidents.companyId, companyId), eq(budgetIncidents.status, "open")));
  const spentCents = Number(spent);
  return { limitCents, spentCents, percentUsed: Math.round((spentCents / limitCents) * 100), openIncidentCount: Number(incidents) };
}

async function cockpitDoneToday(db: Db, companyId: string, scope: CockpitScope): Promise<CockpitDoneTodayItem[]> {
  const start = startOfToday();
  // Bounded to today on BOTH ends (Codex #2): lower = today's midnight, upper = endOfToday
  // (defends against future/clock-skewed completedAt). lte + endOfToday already imported.
  const conds = [eq(issues.companyId, companyId), gte(issues.completedAt, start), lte(issues.completedAt, endOfToday())];
  if (!scope.isFounder) conds.push(eq(issues.assigneeUserId, scope.userId)); // founder→company-wide; else→own
  const rows = await db
    .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
    .from(issues)
    .where(and(...conds))
    .orderBy(desc(issues.completedAt))
    .limit(20);
  return rows;
}
```
Imports to confirm/add at top of cockpit.ts: `goals`, `companies`, `costEvents`, `budgetIncidents` from `@armyofagents/db`; `gte`, `lt` from `drizzle-orm` (verify which are already imported).
- [ ] **Step 3:** Add the 3 calls to the `Promise.all` in `get()` and the 3 fields to the `return {...}` (`goalsAtRisk`, `budgetPulse`, `doneToday`).
- [ ] **Step 4a: Fix existing DB stubs (Codex #1 BLOCKER).** The new `cockpitGoalsAtRisk`/`cockpitDoneToday` queries chain `.orderBy(...).limit(20)`, but the sequence-mock `buildSelectStub` in `server/src/__tests__/cockpit-service.test.ts` (~:59-60) and `server/src/__tests__/cockpit-approvals.test.ts` (~:65-66) make `.orderBy()` terminal → `.limit is not a function`. Update BOTH stubs: `.orderBy()` returns the chainable stub (or itself) and add a terminal `.limit()` that resolves to the next sequence rows (keep the stub thenable so plain `.where()`-terminal and `.orderBy()`-terminal paths still resolve). Add sequence rows for the 3 new selects (goalsAtRisk, budgetPulse company+costEvents+incidents, doneToday) so these suites stay green.
- [ ] **Step 4b: Unit tests** (`cockpit-optin.test.ts`, sequence-mock db like `cockpit-approvals.test.ts`): goalsAtRisk maps shape; budgetPulse → **`null` for any non-founder** (member AND team_lead — founder-only v1), computes `percentUsed` for founder, `null` when `limitCents=0`; doneToday → company-wide for founder vs own (`assigneeUserId`) for non-founder, and bounded to today. Commit.

---

## Task 3: Frontend — enable mechanism + three cards

**Files:** `useCommanderCockpitPrefs.ts`, `cockpitCardModel.ts`, `CommanderCockpitPanel.tsx`, new `CockpitGoalsAtRiskCard.tsx` / `CockpitBudgetPulseCard.tsx` / `CockpitDoneTodayCard.tsx`; tests.

- [ ] **Step 1: Prefs `enabled` (backward-compatible).** In `useCommanderCockpitPrefs.ts`: add `enabled: string[]` to `CockpitPrefs`; `DEFAULT_COCKPIT_PREFS = { hidden: [], order: [], enabled: [] }`; in the load path NORMALIZE old persisted prefs: `{ hidden: p.hidden ?? [], order: p.order ?? [], enabled: p.enabled ?? [] }` (old localStorage has no `enabled` → must default to `[]`, never undefined).
- [ ] **Step 2: `mountableCards` opt-in (OPTIONAL param — don't break existing callers).** In `cockpitCardModel.ts` add an `enabled: string[] = []` param (default `[]`): `return orderCards(registry, order).filter((c) => !hidden.includes(c.id) && (c.defaultOn || enabled.includes(c.id)));`. Add an optional `enabled?: string[]` to `CockpitVisibilityInput`; in `selectVisibleCards` pass `enabled ?? []` into `mountableCards`. **Verified call sites:** `CommanderCockpitPanel.tsx` render loop `mountableCards(COCKPIT_REGISTRY, prefs.hidden, prefs.order)` (:274 → add `prefs.enabled`) and `selectVisibleCards({registry, hidden, order, active})` (:242 → add `enabled: prefs.enabled`). **`cockpitCardModel.test.ts` calls `selectVisibleCards` 5× without `enabled` (:9,14,20,27,38)** — the optional default keeps them green; add ONE new case there: an opt-in card (`defaultOn:false`) is excluded unless its id is in `enabled`.
- [ ] **Step 3: Config popover "Optional" section.** In `CockpitConfigPopover`, split the registry: `defaultOn` cards under the existing "Show cards" (toggle `hidden`); `!defaultOn` cards under a new "Optional" header — checkbox `checked={prefs.enabled.includes(card.id)}`, onChange toggles membership in `prefs.enabled` (`setPrefs({...prefs, enabled: next})`).
- [ ] **Step 4: Three cards** (presentational, return null when empty, reuse the `CockpitReviewCard` chrome + `humanizeStatus` style where relevant):
  - `CockpitGoalsAtRiskCard({ items, onOpenFullPage })` — rows: title + a small "at risk" amber chip; click → `onOpenFullPage('/goals/'+item.id)`. `data-testid="cockpit-card-goalsAtRisk"`.
  - `CockpitBudgetPulseCard({ pulse })` — null when `!pulse`; shows `$spent / $limit` (cents/100), a `percentUsed%` bar (amber ≥ warn, red ≥ 100), and `openIncidentCount` if > 0. `data-testid="cockpit-card-budgetPulse"`. Pure display (no open action v1).
  - `CockpitDoneTodayCard({ items, onOpenTask })` — rows: identifier? + title; click → `onOpenTask(item.id, item.title)`. `data-testid="cockpit-card-doneToday"`.
- [ ] **Step 5: Registry entries** (`defaultOn: false`):
```tsx
{ id: "goalsAtRisk", title: "Goals at risk", defaultOn: false, isActive: (d) => d.goalsAtRisk.length > 0,
  render: ({ data, onOpenFullPage }) => <CockpitGoalsAtRiskCard items={data.goalsAtRisk} onOpenFullPage={onOpenFullPage} /> },
{ id: "budgetPulse", title: "Budget pulse", defaultOn: false, isActive: (d) => d.budgetPulse !== null,
  render: ({ data }) => <CockpitBudgetPulseCard pulse={data.budgetPulse} /> },
{ id: "doneToday", title: "Done today", defaultOn: false, isActive: (d) => d.doneToday.length > 0,
  render: ({ data, onOpenTask }) => <CockpitDoneTodayCard items={data.doneToday} onOpenTask={onOpenTask} /> },
```
- [ ] **Step 6:** `cd ui ; pnpm tsc -b` clean. Commit.

---

## Task 4: Tests + verification

- [ ] **Component tests** (`cockpitOptinCards.test.tsx`): each card renders its data / returns null when empty; goals click → `onOpenFullPage('/goals/'+id)`; doneToday click → `onOpenTask`; budget shows percent + incidents. A prefs/popover test: an opt-in card does NOT mount by default, mounts after its id is added to `enabled`; `mountableCards` honors `enabled`; backward-compat (prefs without `enabled` → no crash, treated as `[]`).
- [ ] **Static + unit:** `(cd server && pnpm vitest run cockpit && pnpm typecheck)`; `(cd ui && pnpm vitest run src/components/commander/ && pnpm tsc -b)`; `pnpm --filter @armyofagents/shared typecheck`.
- [ ] **Live (reuse the running Docker pgvector at 127.0.0.1:5433 / company "Pinned Demo Co"):** via tsx-against-real-PG (mirror the Pinned slice's integration script): set one seeded goal `status='at_risk'`; insert a `cost_events` row; mark a task `completedAt=now`; call `cockpitService.get(companyId, {actorId:"local-board", source:"local_implicit"})` → assert `goalsAtRisk` has the goal, `budgetPulse` = `{limitCents:50000, spentCents:<row>, percentUsed, openIncidentCount}`, `doneToday` has the task. Then in the browser (http://127.0.0.1:3100 → Pinned Demo Co → Commander → cockpit → ⚙ config popover): the 3 cards appear in the **Optional** section, are OFF by default; enable each → it appears; screenshot. Confirm a member scope gets `budgetPulse:null` (unit-covered).
- [ ] **Teardown the tsx script; clean tree; do NOT finish the branch.**

---

## Self-review + Codex review (both applied)

**Codex review (read-only vs real code) — 5 findings, all resolved:**
1. BLOCKER — existing cockpit test stubs make `.orderBy()` terminal; `.orderBy().limit(20)` would throw → update both stubs (Task 2 Step 4a).
2. done-today not upper-bounded → `lte(completedAt, endOfToday())` (Task 2 Step 2).
3. fan-out missed `cockpit-route.test.ts` fixture → added (Task 1 Step 2).
4. `selectVisibleCards` `enabled` would break 5 model-test calls → made the param optional (default `[]`) + add a case (Task 3 Step 2).
5. NICE — team_lead seeing company-wide budget is broader than dept scope → **budget pulse is founder-only v1** (Task 2 Step 2); dept-scoped lead budget deferred.
Codex verified all schema/column/import claims (goals/`at_risk`, `companies.budgetMonthlyCents`, `costEvents`/`budgetIncidents` exports + fields, `issues.completedAt`/`assigneeUserId`, drizzle imports — cockpit currently has `and,desc,eq,inArray,lte,sql`, so add `gte,lt`).

- **Enable mechanism:** `enabled` is backward-compatible (old prefs normalize to `[]`); `mountableCards`'s `enabled` is an OPTIONAL param (default `[]`) so existing callers/tests don't break; threaded at both panel call sites (render :274 + selectVisibleCards :242); opt-in cards (`defaultOn:false`) never mount unless enabled; default cards unaffected.
- **RBAC:** Budget pulse is **founder-only** in the resolver (returns `null` for everyone else) — server-side, not just hidden client-side (verified the `/overview` route itself isn't role-gated). Goals-at-risk is company-scoped (goals have no dept RBAC today — consistent with the rest of the app). Done-today: founder→company / else→own (`assigneeUserId`); lead-dept scoping is a documented follow-up.
- **Type/fan-out consistency:** the 3 new `CockpitData` fields are non-optional → every literal updated (EMPTY_DATA + server return + all test fixtures); same discipline as `pinned`/`approvals`.
- **Empty/show-only-active:** each card returns null when empty; `isActive` predicates feed the active map + All-clear; budget `isActive` = `budgetPulse !== null`.
- **Reuse:** card chrome from CockpitReviewCard; the config popover extended (not rewritten); no new endpoint (all via `/cockpit`); no schema change.
- **Bug-watch:** old localStorage prefs lacking `enabled` must not crash (`.includes` on undefined) — the load normalizer covers it; budget `percentUsed` guards divide-by-zero (returns null when limit=0); `cost_events` sum uses UTC month (matches the budgets service) while done-today uses server-local midnight (matches existing `endOfToday`) — intentional, documented.
