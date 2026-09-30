# Home Widget Board — Plan 1: Foundation (behavior-preserving componentization)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn today's fixed Home into a registry-driven widget system **without changing behavior or appearance** — each existing Home section becomes a self-contained widget component; a `HomeBoard` host renders them by a role-aware key list; `Dashboard.tsx` keeps its guards, header, quick actions, and status line and delegates the sections to `HomeBoard`. Plus the `progressPercent` fix.

**Architecture:** Pure refactor + one bugfix. Move each section's existing JSX/handlers verbatim into a widget component that owns its data hooks. A `widgetRegistry` maps `widgetKey → { metadata, Component }`. `HomeBoard` renders `getDefaultLayout(role)` by registry lookup, wrapping each widget in an error boundary. **No new dependency, no fixed-size tiles, no compact peeks, no grid math** — those are Plan 3 (they require the grid library, and forcing them here is what a Codex review flagged as clipping/overflow risk). The existing `ui/src/__tests__/Dashboard.test.tsx` regression suite is the preservation guardrail: it must stay green.

**Tech Stack:** React 19 + Vite + TailwindCSS v4, TanStack react-query, Vitest + jsdom + @testing-library/react, Playwright. Server: Express 5 + Drizzle. pnpm monorepo.

---

## What Plan 1 is / isn't

- **Is:** the registry + component architecture + the replace-Home cutover + the `progressPercent` bugfix. Invisible to users; foundational for everything else.
- **Isn't:** fixed-size snap tiles, compact "glance" peeks, resize, drag, persistence, add/remove, the `agents-now`/`budget`/`approvals`/`my-tasks` widgets, per-row activity deep-links. All deferred (Plans 2–3).
- **Guardrail:** `ui/src/__tests__/Dashboard.test.tsx` (11 cases) must pass unchanged after the refactor. It doesn't assert section order or the empty fallback, so also add the targeted `defaultLayout` order test (Task 8) and keep the empty-fallback in `Dashboard` (Task 9). If a change would break it, the change is wrong — behavior must be preserved.

## Roadmap (this plan is #1 of 3)

| Plan | Scope | Ships |
|---|---|---|
| **1 — Foundation (this doc)** | registry + extract the 4 existing sections into widgets + `HomeBoard` + replace Home + `progressPercent` fix | same Home, now registry-driven (no visual change) |
| 2 — New-data widgets | authorized endpoints + `Budget` / `Approvals & questions` / `My tasks` / `Agents working now` widgets | 4 new widgets |
| 3 — Customization | grid-library spike (phase 0), fixed-size tiles + compact peeks, `home_board_layouts` + PATCH route + authz, edit mode (drag/resize/add/remove), persistence, responsive, a11y, per-row drill-ins | the arrangeable tile board |

Design doc: `docs/aoa/plans/2026-07-29-home-widget-board-design.md`. This plan realizes §8.1 (registry, components own hooks), §8.6 (component structure), and §11 (`progressPercent` fix). Everything visual/interactive is Plan 3.

---

## Widgets in this plan (4 — extracted verbatim)

| widgetKey | Component | Owns | Extracted from `Dashboard.tsx` |
|---|---|---|---|
| `action-queue` | `ActionQueueWidget` | `useHomeSummary` + `buildActionGroups` + `ActionQueueGroup` | `113-163` (buildActionGroups), `242-279` (ActionQueueGroup), `766-771` (render) |
| `suggestions` | `SuggestionsWidget` | suggestions query/mutations + `SuggestionCard` + `SuggestedMemoryDialog` + all handlers | `82-111`, `180-240`, `303-544`, suggestion parts of `546-708`, `773-813`, `876-910` |
| `objectives` | `ObjectivesWidget` | `useHomeSummary` | `815-850` (Active Goals) |
| `activity-feed` | `ActivityFeedWidget` | `useHomeSummary` + `formatAction`/`activityEntityName` | `169-178` (helpers), `852-868` (render) |

`Dashboard.tsx` keeps: guards (`710-726`), greeting + status line (`728-758`), the 3 `QuickActionCard`s (`760-764`), `QuickActionCard` (`281-301`), `getGreeting` (`61-66`), and the all-empty fallback logic (folded into `HomeBoard`).

---

## File structure

**Create:**
- `server/src/services/goal-progress.ts` + `server/src/__tests__/goal-progress.test.ts`
- `ui/src/components/home/activityFormat.ts` — moved `formatAction`, `activityEntityName`
- `ui/src/components/home/actionQueue.ts` — moved `buildActionGroups`, `getTotalActionCount`, `ActionGroup`/`ActionGroupItem` types (shared by the widget AND Dashboard's status line)
- `ui/src/components/home/widgets/types.ts` — `WidgetKey`, `WidgetProps`, `WidgetDef`
- `ui/src/components/home/widgets/ActionQueueWidget.tsx`
- `ui/src/components/home/widgets/ActionQueueGroup.tsx`
- `ui/src/components/home/widgets/ObjectivesWidget.tsx`
- `ui/src/components/home/widgets/ActivityFeedWidget.tsx`
- `ui/src/components/home/widgets/SuggestionsWidget.tsx`
- `ui/src/components/home/widgets/registry.ts`
- `ui/src/components/home/WidgetErrorBoundary.tsx`
- `ui/src/components/home/defaultLayout.ts`
- `ui/src/components/home/HomeBoard.tsx`
- Tests: `ui/src/__tests__/home/{registry,defaultLayout,ActionQueueWidget,ObjectivesWidget,ActivityFeedWidget,SuggestionsWidget,HomeBoard}.test.tsx`
- `tests/e2e/home-widget-board.spec.ts`

**Modify:**
- `server/src/services/home.ts` (line 248 → use helper)
- `ui/src/pages/Dashboard.tsx` (delegate section rendering to `HomeBoard`; keep header/status/guards)

**Must stay green (do not rewrite):**
- `ui/src/__tests__/Dashboard.test.tsx`

---

## Task 1: Fix `progressPercent` to exclude cancelled tasks (server)

Design §11. `home.ts:248` uses `done/total` where `total` includes cancelled tasks. `cancelled` is already computed at `home.ts:236` (verified), so this is a one-line swap plus a pure helper.

**Files:** Create `server/src/services/goal-progress.ts`, `server/src/__tests__/goal-progress.test.ts`; Modify `server/src/services/home.ts:248`.

- [ ] **Step 1: Write the failing test** — `server/src/__tests__/goal-progress.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { computeGoalProgressPercent } from "../services/goal-progress.js";

describe("computeGoalProgressPercent", () => {
  it("is 0 with no tasks", () => {
    expect(computeGoalProgressPercent({ total: 0, done: 0, cancelled: 0 })).toBe(0);
  });
  it("excludes cancelled from the denominator (1 done + 1 cancelled = 100%, not 50%)", () => {
    expect(computeGoalProgressPercent({ total: 2, done: 1, cancelled: 1 })).toBe(100);
  });
  it("rounds to nearest integer", () => {
    expect(computeGoalProgressPercent({ total: 3, done: 1, cancelled: 0 })).toBe(33);
  });
  it("is 0 when every task is cancelled", () => {
    expect(computeGoalProgressPercent({ total: 2, done: 0, cancelled: 2 })).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`goal-progress.js` unresolved):
`pnpm --filter @armyofagents/server exec vitest run src/__tests__/goal-progress.test.ts`

- [ ] **Step 3: Implement** — `server/src/services/goal-progress.ts`:
```ts
export interface GoalTaskCounts { total: number; done: number; cancelled: number; }

/** done / (total - cancelled), rounded; 0 when the effective denominator is 0. */
export function computeGoalProgressPercent({ total, done, cancelled }: GoalTaskCounts): number {
  const effectiveTotal = total - cancelled;
  if (effectiveTotal <= 0) return 0;
  return Math.round((done / effectiveTotal) * 100);
}
```

- [ ] **Step 4: Run — expect PASS** (4 tests).

- [ ] **Step 5: Wire into `home.ts`** — add `import { computeGoalProgressPercent } from "./goal-progress.js";` at the top, and replace line 248:
```ts
// was: progressPercent: total > 0 ? Math.round((done / total) * 100) : 0,
progressPercent: computeGoalProgressPercent({ total, done, cancelled }),
```
(`cancelled` is already declared at `home.ts:236` — no other change.)

- [ ] **Step 6: Typecheck + test** — `pnpm --filter @armyofagents/server exec vitest run src/__tests__/goal-progress.test.ts` and `pnpm typecheck`. Expect PASS + clean.

- [ ] **Step 7: Commit**
```bash
git add server/src/services/goal-progress.ts server/src/__tests__/goal-progress.test.ts server/src/services/home.ts
git commit -m "fix(home): exclude cancelled tasks from goal progressPercent denominator"
```

---

## Task 2: Widget types

**Files:** Create `ui/src/components/home/widgets/types.ts` (declarations only — no test).

- [ ] **Step 1: Write the types**
```ts
import type { ComponentType } from "react";
import type { UserRole } from "@armyofagents/shared";

export type WidgetKey = "action-queue" | "suggestions" | "objectives" | "activity-feed";
// Plan 2 extends: | "agents-now" | "budget" | "approvals" | "my-tasks"

/** Props every widget receives. Widgets own their own data hooks internally. */
export interface WidgetProps {
  companyId: string;
  role: UserRole | null;
}

export interface WidgetDef {
  key: WidgetKey;
  title: string;
  requiresFounder?: boolean; // UX-only (future tray). Real authz is server-side.
  Component: ComponentType<WidgetProps>;
}
```
(No `defaultSize`/`allowedSizes` yet — sizes are a Plan 3 concept. Adding them now would be unused surface.)

- [ ] **Step 2: Typecheck** — `pnpm typecheck`. Expect clean.

- [ ] **Step 3: Commit**
```bash
git add ui/src/components/home/widgets/types.ts
git commit -m "feat(home): widget types"
```

---

## Task 3: `ObjectivesWidget` (extract Active Goals — do this one first as the template)

Move the Active Goals block (`Dashboard.tsx:815-850`) verbatim into a component. **Preserve** the Active/At-Risk status pill and per-goal `/goals/:id` links. Add only the design §11 zero-task treatment ("no tasks yet" instead of a 0% bar).

**Files:** Create `ui/src/components/home/widgets/ObjectivesWidget.tsx`, `ui/src/__tests__/home/ObjectivesWidget.test.tsx`.

- [ ] **Step 1: Write the failing test**
```tsx
import { screen } from "@testing-library/react";
import { renderWithProviders, mockCompanyContext } from "../test-utils";
import { ObjectivesWidget } from "../../components/home/widgets/ObjectivesWidget";

vi.mock("../../context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("../../hooks/useHomeSummary", () => ({
  useHomeSummary: () => ({ data: { goalProgress: [
    { id: "g1", title: "Launch v1.1", status: "at_risk", totalTasks: 10, doneTasks: 7, inProgressTasks: 2, blockedTasks: 1, progressPercent: 70 },
    { id: "g2", title: "No tasks goal", status: "active", totalTasks: 0, doneTasks: 0, inProgressTasks: 0, blockedTasks: 0, progressPercent: 0 },
  ] }, isLoading: false }),
}));

describe("ObjectivesWidget", () => {
  it("renders goals with the At Risk pill and task counts", () => {
    renderWithProviders(<ObjectivesWidget companyId="co-1" role="founder" />);
    expect(screen.getByText("Launch v1.1")).toBeInTheDocument();
    expect(screen.getByText("At Risk")).toBeInTheDocument();
    expect(screen.getByText("7/10 tasks")).toBeInTheDocument();
  });
  it("shows 'no tasks yet' instead of a 0% bar for a zero-task goal", () => {
    renderWithProviders(<ObjectivesWidget companyId="co-1" role="founder" />);
    expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module unresolved):
`pnpm --filter @armyofagents/ui exec vitest run src/__tests__/home/ObjectivesWidget.test.tsx`

- [ ] **Step 3: Implement** — `ui/src/components/home/widgets/ObjectivesWidget.tsx`. Move the Active Goals JSX (`Dashboard.tsx:815-850`) verbatim, wrapped in the same section markup, and change only the zero-task branch:
```tsx
import type { GoalProgress } from "@armyofagents/shared";
import { Target } from "lucide-react";
import { Link } from "@/lib/router";
import { useHomeSummary } from "../../../hooks/useHomeSummary";
import type { WidgetProps } from "./types";

export function ObjectivesWidget({ companyId }: WidgetProps) {
  const { data } = useHomeSummary(companyId);
  if (!data || data.goalProgress.length === 0) return null; // matches today: section hidden when empty
  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Active Goals</h2>
      <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
        {data.goalProgress.map((goal: GoalProgress) => (
          <Link key={goal.id} to={`/goals/${goal.id}`} className="flex items-center gap-3 px-4 py-3 text-sm text-inherit no-underline transition-colors hover:bg-accent/50">
            <Target className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{goal.title}</span>
                <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs ${goal.status === "at_risk" ? "bg-amber-500/10 text-amber-600 dark:text-amber-400" : "bg-primary/10 text-primary"}`}>
                  {goal.status === "at_risk" ? "At Risk" : "Active"}
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                {goal.totalTasks > 0 ? (
                  <>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${goal.progressPercent}%` }} />
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{goal.doneTasks}/{goal.totalTasks} tasks</span>
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">no tasks yet</span>
                )}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit**
```bash
git add ui/src/components/home/widgets/ObjectivesWidget.tsx ui/src/__tests__/home/ObjectivesWidget.test.tsx
git commit -m "feat(home): ObjectivesWidget (extract Active Goals, preserve pill + add zero-task state)"
```

---

## Task 4: `ActivityFeedWidget` (extract Today's Activity)

Move `formatAction`/`activityEntityName` (`Dashboard.tsx:169-178`) into `activityFormat.ts`, and the Today's Activity block (`852-868`) into the widget. Preserve behavior exactly (rows are not links today — do not add deep-links; that's Plan 3).

**Files:** Create `ui/src/components/home/activityFormat.ts`, `ui/src/components/home/widgets/ActivityFeedWidget.tsx`, `ui/src/__tests__/home/ActivityFeedWidget.test.tsx`.

- [ ] **Step 1: Failing test**
```tsx
import { screen } from "@testing-library/react";
import { renderWithProviders, mockCompanyContext } from "../test-utils";
import { ActivityFeedWidget } from "../../components/home/widgets/ActivityFeedWidget";

vi.mock("../../context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("../../lib/timeAgo", () => ({ timeAgo: () => "2m ago" }));
vi.mock("../../hooks/useHomeSummary", () => ({
  useHomeSummary: () => ({ data: { recentActivity: [
    { id: "a1", action: "issue.completed", entityType: "issue", entityId: "i1", details: { title: "Draft spec" }, createdAt: "x", actorType: "agent", actorId: "z" },
  ] }, isLoading: false }),
}));

describe("ActivityFeedWidget", () => {
  it("renders activity rows with the issue→task word substitution", () => {
    renderWithProviders(<ActivityFeedWidget companyId="co-1" role="founder" />);
    expect(screen.getByText(/task completed/i)).toBeInTheDocument();
    expect(screen.getByText("Draft spec")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Create `activityFormat.ts`** (moved verbatim from `Dashboard.tsx:169-178`):
```ts
import type { RecentActivityItem } from "@armyofagents/shared";
export function formatAction(item: RecentActivityItem): string {
  return item.action.replace(/[._]/g, " ").replace(/\bissue\b/g, "task");
}
export function activityEntityName(item: RecentActivityItem): string {
  const details = item.details as Record<string, unknown> | null;
  if (details?.title && typeof details.title === "string") return details.title;
  if (details?.name && typeof details.name === "string") return details.name;
  return item.entityType === "issue" ? "task" : item.entityType;
}
```

- [ ] **Step 4: Create the widget** (move `852-868` verbatim):
```tsx
import { Activity } from "lucide-react";
import { useHomeSummary } from "../../../hooks/useHomeSummary";
import { timeAgo } from "../../../lib/timeAgo";
import { formatAction, activityEntityName } from "../activityFormat";
import type { WidgetProps } from "./types";

export function ActivityFeedWidget({ companyId }: WidgetProps) {
  const { data } = useHomeSummary(companyId);
  if (!data || data.recentActivity.length === 0) return null; // matches today
  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Today's Activity</h2>
      <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
        {data.recentActivity.map((item) => (
          <div key={item.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <Activity className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              <span className="text-muted-foreground">{formatAction(item)}</span>{" "}
              <span className="font-medium">{activityEntityName(item)}</span>
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(item.createdAt)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run — expect PASS.**

- [ ] **Step 6: Commit**
```bash
git add ui/src/components/home/activityFormat.ts ui/src/components/home/widgets/ActivityFeedWidget.tsx ui/src/__tests__/home/ActivityFeedWidget.test.tsx
git commit -m "feat(home): ActivityFeedWidget (extract Today's Activity)"
```

---

## Task 5: `ActionQueueWidget` (extract Action Queue — full behavior)

Move `buildActionGroups`, `getTotalActionCount`, `ActionGroup`/`ActionGroupItem` (`Dashboard.tsx:68-80,113-167`) into `actionQueue.ts` (shared with Dashboard's status line — see Task 8), and `ActionQueueGroup` (`242-279`) + the render block (`766-771`) into the widget. **Preserve** the collapsible groups, per-item labels/sublabels, and existing links (`/issues?status=in_review`, `/issues?status=blocked`, `/discussions`, per-task `/issues/:id`).

**Files:** Create `ui/src/components/home/actionQueue.ts`, `ui/src/components/home/widgets/ActionQueueWidget.tsx`, `ui/src/__tests__/home/ActionQueueWidget.test.tsx`.

- [ ] **Step 1: Failing test**
```tsx
import { screen } from "@testing-library/react";
import { renderWithProviders, mockCompanyContext } from "../test-utils";
import { ActionQueueWidget } from "../../components/home/widgets/ActionQueueWidget";

vi.mock("../../context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("../../hooks/useHomeSummary", () => ({
  useHomeSummary: () => ({ data: {
    tasksInReview: 2, blockedTasks: 1, discussionsPendingReview: 0,
    myTasksDueToday: [{ id: "t1", title: "Ship it", status: "in_progress", priority: "high", dueDate: null, assigneeAgentId: null, assigneeUserId: "u1" }],
  }, isLoading: false }),
}));

describe("ActionQueueWidget", () => {
  it("renders the Needs Review, Blocked, and Due Today groups (collapsible)", () => {
    renderWithProviders(<ActionQueueWidget companyId="co-1" role="founder" />);
    expect(screen.getByText("Needs Review")).toBeInTheDocument();
    expect(screen.getByText("Blocked")).toBeInTheDocument();
    expect(screen.getByText("Due Today")).toBeInTheDocument();
    expect(screen.getByText("Ship it")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Create `actionQueue.ts`** — move `ActionGroupItem`, `ActionGroup` (`68-80`), `buildActionGroups` (`113-163`), and `getTotalActionCount` (`165-167`) verbatim. Export all four.

- [ ] **Step 4: Create the widget** — move `ActionQueueGroup` (`242-279`) into this file (or a sibling), then:
```tsx
import { useHomeSummary } from "../../../hooks/useHomeSummary";
import { buildActionGroups } from "../actionQueue";
import { ActionQueueGroup } from "./ActionQueueGroup"; // move the component here
import type { WidgetProps } from "./types";

export function ActionQueueWidget({ companyId }: WidgetProps) {
  const { data } = useHomeSummary(companyId);
  const groups = data ? buildActionGroups(data) : [];
  if (groups.length === 0) return null; // matches today: block hidden when empty
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-muted-foreground">Action Queue</h2>
      {groups.map((group) => <ActionQueueGroup key={group.id} group={group} />)}
    </div>
  );
}
```
Create `ui/src/components/home/widgets/ActionQueueGroup.tsx` with the exact `ActionQueueGroup` component from `Dashboard.tsx:242-279` (imports: `useState` from `react`, `ChevronDown` from `lucide-react`, `Link` from `@/lib/router`, and `import type { ActionGroup } from "../actionQueue"`).

- [ ] **Step 5: Run — expect PASS.**

- [ ] **Step 6: Commit**
```bash
git add ui/src/components/home/actionQueue.ts ui/src/components/home/widgets/ActionQueueWidget.tsx ui/src/components/home/widgets/ActionQueueGroup.tsx ui/src/__tests__/home/ActionQueueWidget.test.tsx
git commit -m "feat(home): ActionQueueWidget (extract Action Queue, preserve groups + links)"
```

---

## Task 6: `SuggestionsWidget` (move the full Suggestions machinery)

This is the largest extraction and is **not** trivial — it moves a self-contained subsystem. Move from `Dashboard.tsx` into `SuggestionsWidget.tsx`, verbatim except the two rebinds noted:

**Move these symbols (exact ranges):**
- `SuggestedMemoryDraft` interface (`82-92`)
- `SUGGESTION_CATEGORY_ICONS` (`94-104`), `MEMORY_LAYER_LABELS` (`106-111`)
- helpers `readString`, `readStringArray`, `readMemoryCategory`, `readMemoryLayer`, `getSuggestionTaskDefaults`, `getSuggestedMemoryDraft`, `getSuggestionAgentMeta`, `getArchiveTargetTitle` (`180-240`)
- `SuggestionCard` (`303-361`), `SuggestedMemoryDialog` (`363-544`)
- from the `Dashboard` component body, the suggestion-only state + logic: `showAllSuggestions`, `exitingSuggestionIds`, `busySuggestionIds`, `archiveConfirm`, `memoryDraft`, the `suggestions`/`detectSuggestions`/`acceptSuggestion`/`dismissSuggestion` queries+mutations, `visibleSuggestions`, `markSuggestionBusy`, `removeSuggestionCard`, `acceptAndRemove`, `handleAccept`, `handleArchiveConfirm`, `handleDismiss`, the founder-gated detect-on-load `useEffect` (`554-708`)
- the render block (`773-813`) and the two dialogs (`876-910`)

**Two rebinds only:**
1. `selectedCompanyId` → the `companyId` prop (the widget no longer reads `useCompany` for it; it still uses `useCompany` if any moved code needs `companies`, but the id comes from props).
2. `isFounder` (was `teamRole === "founder"` from `useTeamAccess`) → `role === "founder"` from the `role` prop. The detect-on-load effect stays gated on `role === "founder"`.

**Keep these imports** (they move with the code): `useDialog`, `useToast`, `useQueryClient`, `suggestionsApi`, `memoryApi`, `goalsApi`, `issuesApi`, `queryKeys`, `Identity`, `Button`, `Dialog*`, `Input`, `Label`, `Select*`, `Textarea`, `ConfirmDialog`, the memory constants/types (`MEMORY_ITEM_CATEGORIES`, `MEMORY_ITEM_LAYERS`, `MemoryItemCategory`, `MemoryItemLayer`), the suggestion icons, `Lightbulb`, `CheckCircle2`. **Do not move `useNavigate`** — the suggestions subsystem doesn't use it (it stays in `Dashboard` for the no-company guard).

**Files:** Create `ui/src/components/home/widgets/SuggestionsWidget.tsx`, `ui/src/__tests__/home/SuggestionsWidget.test.tsx`.

- [ ] **Step 1: Write the failing test** (note `vi.hoisted` for the mock fns — avoids the hoist-closure bug):
```tsx
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, mockCompanyContext, mockDialogContext } from "../test-utils";
import { SuggestionsWidget } from "../../components/home/widgets/SuggestionsWidget";

const { suggestionsApiMock } = vi.hoisted(() => ({
  suggestionsApiMock: { pending: vi.fn(), detect: vi.fn(), accept: vi.fn(), dismiss: vi.fn() },
}));
vi.mock("../../context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("../../context/DialogContext", () => ({ useDialog: () => mockDialogContext }));
vi.mock("../../context/ToastContext", () => ({ useToast: () => ({ pushToast: vi.fn() }) }));
vi.mock("../../api/suggestions", () => ({ suggestionsApi: suggestionsApiMock }));

const s = (over: Record<string, unknown>) => ({ id: "s1", companyId: "co-1", category: "memory_gap", actionType: "flag_risk", actionPayload: {}, title: "T", evidence: "E", status: "pending", expiresAt: null, relatedMemoryItemId: null, createdAt: "x", updatedAt: "x", ...over });

describe("SuggestionsWidget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyContext.selectedCompanyId = "co-1";
    suggestionsApiMock.pending.mockResolvedValue([s({ id: "s-risk", actionType: "flag_risk", title: "Flag launch risk" })]);
    suggestionsApiMock.accept.mockResolvedValue({});
    suggestionsApiMock.dismiss.mockResolvedValue({});
  });

  it("renders pending suggestions with founder actions and dismiss calls the API", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SuggestionsWidget companyId="co-1" role="founder" />);
    expect(await screen.findByText("Flag launch risk")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await vi.waitFor(() => expect(suggestionsApiMock.dismiss).toHaveBeenCalledWith("co-1", "s-risk"));
  });

  it("hides accept/dismiss for non-founders", async () => {
    renderWithProviders(<SuggestionsWidget companyId="co-1" role="team_member" />);
    expect(await screen.findByText("Flag launch risk")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Create the widget** by moving the machinery above. The component:
```tsx
export function SuggestionsWidget({ companyId, role }: WidgetProps) {
  const canAct = role === "founder";
  // …all moved state/queries/mutations/handlers, using `companyId` and `canAct`…
  // render: the Suggestions header + list (SuggestionCard canAct={canAct}) + empty state
  //         + <ConfirmDialog …/> + <SuggestedMemoryDialog …/>
}
```
**Do NOT delete anything from `Dashboard.tsx` in this task** — only *copy* the subsystem into the widget. `Dashboard` keeps rendering its own Suggestions until Task 9, which deletes the originals when it wires `HomeBoard`. This keeps the working tree compiling and green across Tasks 6–8. (Temporary duplicate `SuggestionCard`/`SuggestedMemoryDialog` definitions in two modules are fine.) Note: detection now fires when `HomeBoard` mounts (after the page's loading guard) rather than during summary load — a negligible timing shift the existing suite tolerates (it `waitFor`s the call).

- [ ] **Step 4: Run — expect PASS** (both cases).

- [ ] **Step 5: Commit**
```bash
git add ui/src/components/home/widgets/SuggestionsWidget.tsx ui/src/__tests__/home/SuggestionsWidget.test.tsx
git commit -m "feat(home): SuggestionsWidget (move full suggestions subsystem out of Dashboard)"
```

---

## Task 7: Registry (after the widgets exist)

**Files:** Create `ui/src/components/home/widgets/registry.ts`, `ui/src/__tests__/home/registry.test.ts`.

- [ ] **Step 1: Failing test**
```ts
import { describe, it, expect } from "vitest";
import { widgetRegistry, getWidget, listWidgets } from "../../components/home/widgets/registry";

describe("widgetRegistry", () => {
  it("keys each def by its own key", () => {
    for (const [key, def] of Object.entries(widgetRegistry)) expect(def.key).toBe(key);
  });
  it("returns undefined for an unknown key (no throw)", () => {
    expect(getWidget("nope" as never)).toBeUndefined();
  });
  it("registers the four Plan-1 widgets", () => {
    expect(Object.keys(widgetRegistry).sort()).toEqual(["action-queue", "activity-feed", "objectives", "suggestions"]);
  });
  it("listWidgets returns every def", () => {
    expect(listWidgets()).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**
```ts
import type { WidgetDef, WidgetKey } from "./types";
import { ActionQueueWidget } from "./ActionQueueWidget";
import { SuggestionsWidget } from "./SuggestionsWidget";
import { ObjectivesWidget } from "./ObjectivesWidget";
import { ActivityFeedWidget } from "./ActivityFeedWidget";

export const widgetRegistry: Record<WidgetKey, WidgetDef> = {
  "action-queue": { key: "action-queue", title: "Action queue", Component: ActionQueueWidget },
  suggestions: { key: "suggestions", title: "Suggestions", Component: SuggestionsWidget },
  objectives: { key: "objectives", title: "Objectives", Component: ObjectivesWidget },
  "activity-feed": { key: "activity-feed", title: "Today's activity", Component: ActivityFeedWidget },
};
export function getWidget(key: WidgetKey): WidgetDef | undefined { return widgetRegistry[key]; }
export function listWidgets(): WidgetDef[] { return Object.values(widgetRegistry); }
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit**
```bash
git add ui/src/components/home/widgets/registry.ts ui/src/__tests__/home/registry.test.ts
git commit -m "feat(home): widget registry"
```

---

## Task 8: `WidgetErrorBoundary`, `defaultLayout`, `HomeBoard`

Design §10 (isolated per-widget failure). `HomeBoard` renders `getDefaultLayout(role)` by registry lookup, each widget in an error boundary, keyed by `widgetKey` (stable identity — design §8.3 / Codex).

**Files:** Create `WidgetErrorBoundary.tsx`, `defaultLayout.ts`, `HomeBoard.tsx`, and `defaultLayout.test.ts` + `HomeBoard.test.tsx`.

- [ ] **Step 1: `defaultLayout.ts` failing test**
```ts
import { describe, it, expect } from "vitest";
import { getDefaultLayout } from "../../components/home/defaultLayout";
import { widgetRegistry } from "../../components/home/widgets/registry";

describe("getDefaultLayout", () => {
  it("returns only registered keys for every role", () => {
    for (const role of ["founder", "team_lead", "team_member", null] as const)
      for (const key of getDefaultLayout(role)) expect(widgetRegistry[key]).toBeDefined();
  });
  it("preserves today's section order for every role (behavior-preserving in Plan 1)", () => {
    const expected = ["action-queue", "suggestions", "objectives", "activity-feed"];
    for (const role of ["founder", "team_lead", "team_member", null] as const)
      expect(getDefaultLayout(role)).toEqual(expected);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `defaultLayout.ts`**
```ts
import type { UserRole } from "@armyofagents/shared";
import type { WidgetKey } from "./widgets/types";

// Plan 1 preserves today's exact section order for EVERY role (behavior-preserving —
// today's Home renders the same order for everyone). Role-aware ordering is a Plan 3
// concern, introduced with the customizable board.
const DEFAULT_ORDER: WidgetKey[] = ["action-queue", "suggestions", "objectives", "activity-feed"];

export function getDefaultLayout(_role: UserRole | null): WidgetKey[] {
  return DEFAULT_ORDER;
}
```

- [ ] **Step 4: Implement `WidgetErrorBoundary.tsx`**
```tsx
import { Component, type ReactNode } from "react";

export class WidgetErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed)
      return <div className="rounded-md border border-border p-4 text-sm text-muted-foreground">This widget couldn't load.</div>;
    return this.props.children;
  }
}
```

- [ ] **Step 5: `HomeBoard.test.tsx` failing test**
```tsx
import { screen } from "@testing-library/react";
import { renderWithProviders, mockCompanyContext } from "../test-utils";
import { HomeBoard } from "../../components/home/HomeBoard";

vi.mock("../../context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("../../hooks/useHomeSummary", () => ({ useHomeSummary: () => ({ data: {
  goalProgress: [{ id: "g1", title: "Launch", status: "active", totalTasks: 2, doneTasks: 1, inProgressTasks: 1, blockedTasks: 0, progressPercent: 50 }],
  recentActivity: [], tasksInReview: 0, blockedTasks: 0, discussionsPendingReview: 0, myTasksDueToday: [],
}, isLoading: false }) }));
vi.mock("../../api/suggestions", () => ({ suggestionsApi: { pending: vi.fn().mockResolvedValue([]), detect: vi.fn(), accept: vi.fn(), dismiss: vi.fn() } }));
vi.mock("../../context/DialogContext", () => ({ useDialog: () => ({}) }));
vi.mock("../../context/ToastContext", () => ({ useToast: () => ({ pushToast: vi.fn() }) }));

describe("HomeBoard", () => {
  it("renders the role-ordered widgets that have content", () => {
    renderWithProviders(<HomeBoard companyId="co-1" role="founder" />);
    expect(screen.getByText("Active Goals")).toBeInTheDocument(); // Objectives widget
  });
});
```

- [ ] **Step 6: Implement `HomeBoard.tsx`** — vertical stack in default order (fixed-size tiles are Plan 3):
```tsx
import type { UserRole } from "@armyofagents/shared";
import { getWidget } from "./widgets/registry";
import { getDefaultLayout } from "./defaultLayout";
import { WidgetErrorBoundary } from "./WidgetErrorBoundary";

export function HomeBoard({ companyId, role }: { companyId: string; role: UserRole | null }) {
  return (
    <div className="space-y-6">
      {getDefaultLayout(role).map((key) => {
        const def = getWidget(key);
        if (!def) return null; // unknown key — skip defensively (design §11)
        const Widget = def.Component;
        return (
          // Key includes companyId so a switch remounts the boundary — a widget
          // that errored for one company recovers when you change companies.
          <WidgetErrorBoundary key={`${key}-${companyId}`}>
            <Widget companyId={companyId} role={role} />
          </WidgetErrorBoundary>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 7: Run both tests — expect PASS.**

- [ ] **Step 8: Commit**
```bash
git add ui/src/components/home/WidgetErrorBoundary.tsx ui/src/components/home/defaultLayout.ts ui/src/components/home/HomeBoard.tsx ui/src/__tests__/home/defaultLayout.test.ts ui/src/__tests__/home/HomeBoard.test.tsx
git commit -m "feat(home): HomeBoard host + per-widget error boundary + role default order"
```

---

## Task 9: Wire `HomeBoard` into `Dashboard.tsx` (keep header, status line, guards)

Replace the 4 section blocks (`766-874`) with `<HomeBoard companyId={selectedCompanyId} role={teamRole} />`. **Preserve** everything else. The status line's `totalActions` needs `buildActionGroups` + `getTotalActionCount` (now in `actionQueue.ts`) and a suggestions count — keep a lightweight suggestions `pending` query in Dashboard for the count only (same `queryKeys.suggestions.pending` key → deduped with the widget's query, no extra fetch).

**Files:** Modify `ui/src/pages/Dashboard.tsx`.

- [ ] **Step 1: Edit `Dashboard.tsx`**
  - Add `import { HomeBoard } from "../components/home/HomeBoard";` and `import { buildActionGroups, getTotalActionCount } from "../components/home/actionQueue";`.
  - Keep: `getGreeting`, `QuickActionCard`, the guards (`710-726`), greeting + status computation (`728-758`), the 3 quick-action cards.
  - For the status line, keep a count-only suggestions query:
    ```tsx
    const { data: suggestions = [] } = useQuery({
      queryKey: queryKeys.suggestions.pending(selectedCompanyId!),
      queryFn: () => suggestionsApi.pending(selectedCompanyId!),
      enabled: !!selectedCompanyId,
    });
    const actionGroups = data ? buildActionGroups(data) : [];
    const totalActions = getTotalActionCount(actionGroups, suggestions.length);
    ```
  - Replace the section JSX (`766-874`) with the header + `<HomeBoard companyId={selectedCompanyId} role={teamRole} />`.
  - Delete the now-moved symbols/handlers/dialogs (they live in `SuggestionsWidget`) and remove now-unused imports. Body:
    ```tsx
    return (
      <div className="space-y-6 max-w-3xl">
        {error && <p className="text-sm text-destructive">{error.message}</p>}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{greeting}</h1>
          {data && <p className="mt-1 text-sm text-muted-foreground">{statusLine}</p>}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <QuickActionCard icon={Plus} label="+ New Task" onClick={() => openNewIssue()} />
          <QuickActionCard icon={MessageSquare} label="+ Discussion" onClick={() => openDiscussionCapture()} />
          <QuickActionCard icon={Target} label="+ New Goal" onClick={() => openNewGoal()} />
        </div>
        <HomeBoard companyId={selectedCompanyId} role={teamRole} />
        {/* Preserve today's overall empty fallback (Dashboard.tsx:870-874) — HomeBoard
            can't infer it because widgets self-hide by returning null. */}
        {data && actionGroups.length === 0 && suggestions.length === 0 && data.recentActivity.length === 0 && (
          <div className="rounded-md border border-border p-8 text-center">
            <p className="text-sm text-muted-foreground">Nothing needs your attention right now.</p>
          </div>
        )}
      </div>
    );
    ```
  - Keep the `max-w-3xl` wrapper OR remove it (visual choice; keeping it is the zero-change option — do that for Plan 1).

- [ ] **Step 2: Run the existing regression suite — it MUST stay green**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/__tests__/Dashboard.test.tsx`
Expected: all 11 PASS. If any fail, behavior drifted — fix the widget, not the test. (The suite renders `<Dashboard/>` → `<HomeBoard/>` → widgets, so it now exercises the full extracted tree.)

- [ ] **Step 3: Typecheck** — `pnpm typecheck`. Fix any dangling imports from the extraction.

- [ ] **Step 4: Preview verification** — start the dev server (Browser pane), open `/{companyPrefix}/home`, confirm the page is visually identical to before, links work, suggestion accept/dismiss works founder-only, no console errors. Screenshot for the PR.

- [ ] **Step 5: Commit**
```bash
git add ui/src/pages/Dashboard.tsx
git commit -m "feat(home): render Home sections via HomeBoard (replace inline blocks)"
```

---

## Task 10: Replace-Home smoke e2e

**Files:** Create `tests/e2e/home-widget-board.spec.ts`.

- [ ] **Step 1: Write the spec**
```ts
import { test, expect } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

test.describe("home widget board", () => {
  test.beforeEach(async ({ request }) => { await cleanupTestCompanies(request, /^E2E-HomeBoard-/); });

  test("Home renders header + quick actions after the widget refactor", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-HomeBoard-${Date.now()}`);
    await page.goto(`/${company.issuePrefix}/home`);
    await expect(page.getByText("+ New Task")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible(); // greeting
  });
});
```
(A freshly-seeded company has no goals/activity/suggestions, so those widgets render nothing — assert the always-present header. Content-parity of the widgets themselves is covered by `Dashboard.test.tsx`.)

- [ ] **Step 2: Run** — Linux/macOS `pnpm test:e2e home-widget-board.spec.ts`; Windows `AOA_E2E_FORCE_WINDOWS=1 pnpm test:e2e home-widget-board.spec.ts`. Expect PASS.

- [ ] **Step 3: Commit**
```bash
git add tests/e2e/home-widget-board.spec.ts
git commit -m "test(home): replace-Home smoke e2e"
```

---

## Final verification (repo-canonical commands)

- [ ] **Typecheck the whole repo:** `pnpm typecheck` → no errors.
- [ ] **Full unit/component suite:** `pnpm test:run` → all green (crucially the untouched `Dashboard.test.tsx` (11 cases) + the new `src/__tests__/home/*` + `goal-progress.test.ts`).
- [ ] **Build:** `pnpm build` → succeeds (canonical; runs `prebuild` fetch steps then `pnpm -r build`).
- [ ] **e2e** (Linux CI, or local `AOA_E2E_FORCE_WINDOWS=1 pnpm test:e2e home-widget-board.spec.ts`).
- [ ] **Manual parity check** in the preview: founder and (if seedable) member Home identical to pre-refactor; suggestion accept/dismiss founder-only.

---

## Self-review notes (author)

- **Spec coverage:** design §8.1 (registry; components own their hooks — `HomeBoard` never calls a hook in a loop, it renders `<Component/>` instances), §8.6 (structure), §10 (per-widget error boundary), §11 (progressPercent + zero-task Objectives). Fixed tiles/peeks/persistence/new-data widgets/drill-ins are explicitly Plans 2–3.
- **Behavior preservation:** the guardrail is the untouched `Dashboard.test.tsx` (Task 9 Step 2). Every widget moves existing code; the only intended change is `progressPercent` (Task 1) and the zero-task Objectives label (Task 3).
- **Codex-review fixes folded in:** framing corrected to behavior-preserving (no 104px tiles / no responsive spans / no compact clipping); Suggestions extraction ranges corrected + full symbol list + rebinds; Action-queue/Objectives behavior preserved (groups, links, pill); `vi.hoisted` in the Suggestions test; `useCompany` mocked in widget tests; registry built after widgets; status-line ownership kept in Dashboard via shared `actionQueue.ts` + count-only suggestions query; existing `Dashboard.test.tsx` retained + run; first-run claim removed (the existing suite already covers steady-Home); canonical `pnpm typecheck` / `pnpm test:run` / `pnpm -r build`; `cancelled` already in scope (no conditional); `HomeBoard` keyed by `widgetKey`; error boundary added; unused size/`WidgetRenderContext` surface dropped.
- **Type consistency:** `WidgetProps` = `{ companyId, role }` across all widgets, registry `Component`, and `HomeBoard`; `WidgetKey` union matches registry keys and `getDefaultLayout`.
- **Two intentional visible changes** (everything else is invisible): the `progressPercent` denominator (Task 1) and the zero-task Objectives label "no tasks yet" replacing a 0% bar (Task 3). Both are declared; the rest is a pure move.