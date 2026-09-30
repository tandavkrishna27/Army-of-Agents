# Home Widget Board — Plan 2: New-data widgets

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add the four remaining Home widgets — `Budget`, `Approvals & questions`, `My tasks`, `Agents working now` — each reusing an **existing** authed endpoint, and place them on the board via a role-aware default. No new server code, no migration.

**Architecture:** Pure UI. Four new self-contained widget components (same pattern as Plan 1), each owning its own react-query hook against an existing api client. Extend `WidgetKey` + the registry, and make `getDefaultLayout(role)` role-aware (founders get the full 8-widget board incl. Budget/Approvals; members get an execution-weighted subset). Widgets render `null` while loading/empty (like Plan 1's), so they degrade gracefully. Data stays team-visible (product decision 2026-07-29 — the existing `/dashboard`, `/costs`, `/budgets` endpoints are already `assertCompanyAccess`-only; role-awareness is arrangement-only, not data-gating).

**Tech Stack:** React 19 + Vite + Tailwind, TanStack react-query, Vitest + @testing-library/react. No backend changes.

---

## Roadmap position (plan 2 of 4)
Plan 1 (foundation) ✅ done. **Plan 2 (this) — the 4 new-data widgets.** Plan 3 — grid-library spike + fixed-size tiles + `home_board_layouts` persistence + edit mode (drag/resize/add/remove) + responsive + a11y. Plan 4 — comprehensive widget testing. All land on `claude/home-page-widgets-a927af`; single PR at the end.

## Reused endpoints (all exist; verified)
| Widget | Data | Client call | Shape |
|---|---|---|---|
| `agents-now` | live run count | `useLiveAgentCount()` | `number` |
| `budget` | month spend vs budget | `dashboardApi.summary(companyId)` → `.costs` | `{ monthSpendCents, monthBudgetCents, monthUtilizationPercent }` |
| `approvals` | pending approvals + agent questions | `dashboardApi.summary().pendingApprovals` (number) + `workQuestionsApi.list(companyId, { scope: "mine", status: "open" })` (`WorkQuestion[]`) | — |
| `my-tasks` | tasks assigned to me | `issuesApi.list(companyId, { assigneeUserId: "me" })` (server resolves `"me"` for board actors) | `Issue[]` |

`dashboardApi`/`homeApi` live in `ui/src/api/dashboard.ts`; `workQuestionsApi` in `ui/src/api/work-questions.ts`; `issuesApi` in `ui/src/api/issues.ts`; `useLiveAgentCount` in `ui/src/hooks/useLiveAgentCount.ts`. `DashboardSummary` type in `@armyofagents/shared`. Budget + Approvals share one `queryKeys.dashboard(companyId)` query (deduped).

---

## File structure
**Create:** `ui/src/components/home/widgets/{AgentsNowWidget,BudgetWidget,ApprovalsWidget,MyTasksWidget}.tsx` + a `ui/src/components/home/money.ts` (cents→display helper) + tests `ui/src/__tests__/home/{AgentsNowWidget,BudgetWidget,ApprovalsWidget,MyTasksWidget}.test.tsx`.
**Modify:** `ui/src/components/home/widgets/types.ts` (extend `WidgetKey`), `.../registry.ts` (+4 entries), `ui/src/components/home/defaultLayout.ts` (role-aware), `ui/src/__tests__/home/{defaultLayout,HomeBoard}.test.tsx`, and `ui/src/__tests__/Dashboard.test.tsx` (mock the new deps + assert the new widgets — the board composition legitimately changes in Plan 2).

---

## Task 1: Extend `WidgetKey`

**Files:** Modify `ui/src/components/home/widgets/types.ts`.

- [ ] **Step 1:** Replace the `WidgetKey` union (and drop the "Plan 2 extends" comment):
```ts
export type WidgetKey =
  | "action-queue"
  | "suggestions"
  | "objectives"
  | "activity-feed"
  | "agents-now"
  | "budget"
  | "approvals"
  | "my-tasks";
```
- [ ] **Step 2:** `pnpm typecheck` — expect errors ONLY in `registry.ts`/`defaultLayout.ts` (the `Record<WidgetKey, ...>` now missing keys). That's expected; Tasks 6–7 fix them. Do not commit yet (commit with Task 6 once the map is complete), OR commit types alone and accept a transient red typecheck until Task 6. Prefer: implement Tasks 2–6 before the next full typecheck.

---

## Task 2: `AgentsNowWidget`

**Files:** Create `ui/src/components/home/widgets/AgentsNowWidget.tsx`, `ui/src/__tests__/home/AgentsNowWidget.test.tsx`.

- [ ] **Step 1: Failing test**
```tsx
import { screen } from "@testing-library/react";
import { renderWithProviders, mockCompanyContext } from "../test-utils";
import { AgentsNowWidget } from "../../components/home/widgets/AgentsNowWidget";

vi.mock("../../context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("../../hooks/useLiveAgentCount", () => ({ useLiveAgentCount: () => 3 }));

describe("AgentsNowWidget", () => {
  it("shows the live agent count", () => {
    renderWithProviders(<AgentsNowWidget companyId="co-1" role="founder" />);
    expect(screen.getByText("Agents working now")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2:** Run → FAIL. `pnpm --filter @armyofagents/ui exec vitest run src/__tests__/home/AgentsNowWidget.test.tsx`

- [ ] **Step 3: Implement**
```tsx
import { Cpu } from "lucide-react";
import { Link } from "@/lib/router";
import { useLiveAgentCount } from "../../../hooks/useLiveAgentCount";
import type { WidgetProps } from "./types";

export function AgentsNowWidget(_props: WidgetProps) {
  const count = useLiveAgentCount();
  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Agents working now</h2>
      <Link to="/agents" className="flex items-center gap-3 rounded-md border border-border px-4 py-3 text-inherit no-underline transition-colors hover:bg-accent/50">
        <Cpu className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-2xl font-semibold leading-none tabular-nums">{count}</span>
        {count > 0 && <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />}
        <span className="text-sm text-muted-foreground">{count === 1 ? "agent" : "agents"} working now</span>
      </Link>
    </div>
  );
}
```
- [ ] **Step 4:** Run → PASS. **Step 5:** Commit `feat(home): AgentsNowWidget`.

---

## Task 3: `money.ts` + `BudgetWidget`

**Files:** Create `ui/src/components/home/money.ts`, `ui/src/components/home/widgets/BudgetWidget.tsx`, `ui/src/__tests__/home/BudgetWidget.test.tsx`.

- [ ] **Step 1: Failing test** (money helper + widget in one file is fine; test the widget)
```tsx
import { screen } from "@testing-library/react";
import { renderWithProviders, mockCompanyContext } from "../test-utils";
import { BudgetWidget } from "../../components/home/widgets/BudgetWidget";

const { dashboardApiMock } = vi.hoisted(() => ({ dashboardApiMock: { summary: vi.fn() } }));
vi.mock("../../context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("../../api/dashboard", () => ({ dashboardApi: dashboardApiMock, homeApi: { summary: vi.fn() } }));

describe("BudgetWidget", () => {
  beforeEach(() => {
    dashboardApiMock.summary.mockResolvedValue({ costs: { monthSpendCents: 41200, monthBudgetCents: 200000, monthUtilizationPercent: 21 }, pendingApprovals: 0 });
  });
  it("renders month spend vs budget", async () => {
    renderWithProviders(<BudgetWidget companyId="co-1" role="founder" />);
    expect(await screen.findByText(/\$412/)).toBeInTheDocument();
    expect(screen.getByText(/of \$2,000/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: `money.ts`**
```ts
/** Cents → "$1,234" (whole dollars) for compact widget display. */
export function formatDollars(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Math.round(cents / 100));
}
```

- [ ] **Step 4: `BudgetWidget.tsx`**
```tsx
import { useQuery } from "@tanstack/react-query";
import { CircleDollarSign } from "lucide-react";
import { Link } from "@/lib/router";
import { dashboardApi } from "../../../api/dashboard";
import { queryKeys } from "../../../lib/queryKeys";
import { formatDollars } from "../money";
import type { WidgetProps } from "./types";

export function BudgetWidget({ companyId }: WidgetProps) {
  const { data } = useQuery({ queryKey: queryKeys.dashboard(companyId), queryFn: () => dashboardApi.summary(companyId), enabled: !!companyId });
  if (!data) return null;
  const { monthSpendCents, monthBudgetCents, monthUtilizationPercent } = data.costs;
  const pct = Math.min(100, Math.max(0, Math.round(monthUtilizationPercent))); // server-computed; clamp only the bar width
  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Budget</h2>
      <Link to="/budget" className="block rounded-md border border-border px-4 py-3 text-inherit no-underline transition-colors hover:bg-accent/50">
        <div className="flex items-center gap-2">
          <CircleDollarSign className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-2xl font-semibold tabular-nums">{formatDollars(monthSpendCents)}</span>
          <span className="text-sm text-muted-foreground">of {formatDollars(monthBudgetCents)} this month</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
        </div>
      </Link>
    </div>
  );
}
```
Uses the server-provided `monthUtilizationPercent` (not a client recompute), and `CircleDollarSign` (verified present in `lucide-react@^0.574.0`; `Coin` is NOT exported). Add a test case for zero/missing budget data (renders `null`).

- [ ] **Step 5:** Run → PASS. **Step 6:** Commit `feat(home): BudgetWidget (reuse dashboard summary)`.

---

## Task 4: `ApprovalsWidget`

**Files:** Create `ui/src/components/home/widgets/ApprovalsWidget.tsx`, `ui/src/__tests__/home/ApprovalsWidget.test.tsx`.

- [ ] **Step 1: Failing test**
```tsx
import { screen } from "@testing-library/react";
import { renderWithProviders, mockCompanyContext } from "../test-utils";
import { ApprovalsWidget } from "../../components/home/widgets/ApprovalsWidget";

const { dashboardApiMock, wqApiMock } = vi.hoisted(() => ({ dashboardApiMock: { summary: vi.fn() }, wqApiMock: { list: vi.fn() } }));
vi.mock("../../context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("../../api/dashboard", () => ({ dashboardApi: dashboardApiMock, homeApi: { summary: vi.fn() } }));
vi.mock("../../api/work-questions", () => ({ workQuestionsApi: wqApiMock }));

describe("ApprovalsWidget", () => {
  beforeEach(() => {
    dashboardApiMock.summary.mockResolvedValue({ pendingApprovals: 1, costs: { monthSpendCents: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 } });
    wqApiMock.list.mockResolvedValue([{ id: "q1" }, { id: "q2" }]);
  });
  it("sums approvals + questions waiting", async () => {
    renderWithProviders(<ApprovalsWidget companyId="co-1" role="founder" />);
    expect(await screen.findByText("3")).toBeInTheDocument(); // 1 approval + 2 questions
    expect(screen.getByText(/waiting on you/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Implement**
```tsx
import { useQuery } from "@tanstack/react-query";
import { CheckSquare } from "lucide-react";
import { Link } from "@/lib/router";
import { dashboardApi } from "../../../api/dashboard";
import { workQuestionsApi } from "../../../api/work-questions";
import { queryKeys } from "../../../lib/queryKeys";
import type { WidgetProps } from "./types";

export function ApprovalsWidget({ companyId }: WidgetProps) {
  const { data: dash } = useQuery({ queryKey: queryKeys.dashboard(companyId), queryFn: () => dashboardApi.summary(companyId), enabled: !!companyId });
  const { data: questions } = useQuery({
    queryKey: ["work-questions", companyId, "mine-open"],
    queryFn: () => workQuestionsApi.list(companyId, { scope: "mine", status: "open" }),
    enabled: !!companyId,
  });
  const approvals = dash?.pendingApprovals ?? 0;
  const qCount = questions?.length ?? 0;
  const total = approvals + qCount;
  if (!dash || !questions) return null; // require BOTH — questions=[] is truthy, so && would render a misleading partial total on a one-sided failure
  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Approvals &amp; questions</h2>
      <Link to="/inbox" className="flex items-center gap-3 rounded-md border border-border px-4 py-3 text-inherit no-underline transition-colors hover:bg-accent/50">
        <CheckSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-2xl font-semibold tabular-nums">{total}</span>
        <span className="text-sm text-muted-foreground">
          waiting on you{total > 0 ? ` (${approvals} approval${approvals === 1 ? "" : "s"}, ${qCount} question${qCount === 1 ? "" : "s"})` : ""}
        </span>
      </Link>
    </div>
  );
}
```
Verify `workQuestionsApi.list(companyId, { scope, status })` signature against `ui/src/api/work-questions.ts` and adjust the filter object to match exactly. Verify `CheckSquare` resolves in lucide-react (else `CheckCircle2`).

- [ ] **Step 4:** Run → PASS. **Step 5:** Commit `feat(home): ApprovalsWidget (approvals + open questions)`.

---

## Task 5: `MyTasksWidget`

**Files:** Create `ui/src/components/home/widgets/MyTasksWidget.tsx`, `ui/src/__tests__/home/MyTasksWidget.test.tsx`.

- [ ] **Step 1: Failing test**
```tsx
import { screen } from "@testing-library/react";
import { renderWithProviders, mockCompanyContext } from "../test-utils";
import { MyTasksWidget } from "../../components/home/widgets/MyTasksWidget";

const { issuesApiMock } = vi.hoisted(() => ({ issuesApiMock: { list: vi.fn() } }));
vi.mock("../../context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("../../api/issues", () => ({ issuesApi: issuesApiMock }));

describe("MyTasksWidget", () => {
  beforeEach(() => {
    issuesApiMock.list.mockResolvedValue([
      { id: "t1", title: "Draft launch post", status: "in_progress", priority: "high" },
      { id: "t2", title: "Review crew output", status: "todo", priority: "medium" },
      { id: "t3", title: "Done thing", status: "done", priority: "low" },
    ]);
  });
  it("lists my non-terminal tasks with status", async () => {
    renderWithProviders(<MyTasksWidget companyId="co-1" role="team_member" />);
    expect(await screen.findByText("Draft launch post")).toBeInTheDocument();
    expect(screen.getByText("Review crew output")).toBeInTheDocument();
    // terminal tasks excluded
    expect(screen.queryByText("Done thing")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Implement**
```tsx
import { useQuery } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";
import type { Issue } from "@armyofagents/shared";
import { Link } from "@/lib/router";
import { issuesApi } from "../../../api/issues";
import { queryKeys } from "../../../lib/queryKeys";
import type { WidgetProps } from "./types";

const TERMINAL = new Set(["done", "cancelled"]);

export function MyTasksWidget({ companyId }: WidgetProps) {
  const { data } = useQuery({
    queryKey: queryKeys.issues.listAssignedToMe(companyId),
    queryFn: () => issuesApi.list(companyId, { assigneeUserId: "me" }),
    enabled: !!companyId,
  });
  const tasks = (data ?? []).filter((t: Issue) => !TERMINAL.has(t.status)).slice(0, 5);
  if (!data || tasks.length === 0) return null;
  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold text-muted-foreground">My tasks</h2>
      <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
        {tasks.map((t: Issue) => (
          <Link key={t.id} to={`/issues/${t.id}`} className="flex items-center gap-3 px-4 py-2.5 text-sm text-inherit no-underline transition-colors hover:bg-accent/50">
            <ListChecks className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{t.title}</span>
            <span className="shrink-0 text-xs capitalize text-muted-foreground">{t.status.replace(/_/g, " ")}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
```
Verify `Issue` is exported from `@armyofagents/shared` and has `status`/`title`/`id`. Verify `issuesApi.list(companyId, { assigneeUserId: "me" })` matches the client signature in `ui/src/api/issues.ts`.

- [ ] **Step 4:** Run → PASS. **Step 5:** Commit `feat(home): MyTasksWidget (issues assigned to me)`.

---

## Task 6: Register the 4 widgets

**Files:** Modify `ui/src/components/home/widgets/registry.ts`.

- [ ] **Step 1:** Add imports + 4 entries to `widgetRegistry`:
```ts
import { AgentsNowWidget } from "./AgentsNowWidget";
import { BudgetWidget } from "./BudgetWidget";
import { ApprovalsWidget } from "./ApprovalsWidget";
import { MyTasksWidget } from "./MyTasksWidget";
// ...inside widgetRegistry:
  "agents-now": { key: "agents-now", title: "Agents working now", Component: AgentsNowWidget },
  budget: { key: "budget", title: "Budget", Component: BudgetWidget },
  approvals: { key: "approvals", title: "Approvals & questions", Component: ApprovalsWidget },
  "my-tasks": { key: "my-tasks", title: "My tasks", Component: MyTasksWidget },
```
- [ ] **Step 2:** Update `ui/src/__tests__/home/registry.test.ts` — the "registers the four" assertion becomes eight keys: `["action-queue","activity-feed","agents-now","approvals","budget","my-tasks","objectives","suggestions"]`, and `listWidgets()` length 8.
- [ ] **Step 3:** Run registry test → PASS. `pnpm typecheck` → now clean (the `Record<WidgetKey,...>` is complete). **Step 4:** Commit `feat(home): register the 4 new-data widgets`.

---

## Task 7: Role-aware default layout

Design §6. Founder default = full board; member default = execution-weighted (no Budget/Approvals — arrangement only; a member can add them once Plan 3's tray ships).

**Files:** Modify `ui/src/components/home/defaultLayout.ts`, `ui/src/__tests__/home/defaultLayout.test.ts`.

- [ ] **Step 1:** Replace the single `DEFAULT_ORDER` with role-aware lists:
```ts
const FOUNDER: WidgetKey[] = ["action-queue", "approvals", "agents-now", "activity-feed", "objectives", "suggestions", "my-tasks", "budget"];
const MEMBER: WidgetKey[] = ["my-tasks", "action-queue", "objectives", "activity-feed", "suggestions", "agents-now"];

// Only team_member gets the execution board; founder, team_lead, null, and
// instance-admin (null role) all get the oversight board.
export function getDefaultLayout(role: UserRole | null): WidgetKey[] {
  return role === "team_member" ? MEMBER : FOUNDER;
}
```
- [ ] **Step 2:** Update `defaultLayout.test.ts`: every returned key is registered (loop over `widgetRegistry`); founder default includes `"budget"` and `"approvals"`; **`team_lead` and `null` also get the founder board** (assert `getDefaultLayout("team_lead")` deep-equals `getDefaultLayout("founder")`); member default excludes both and starts with `"my-tasks"`.
- [ ] **Step 3:** Run → PASS. **Step 4:** Commit `feat(home): role-aware default board (founder vs member)`.

---

## Task 8: Update the board tests for 8 widgets

The board now composes 8 widgets. `Dashboard.test.tsx` renders them via `HomeBoard`, so it must mock the new widgets' data deps (dashboard summary, work-questions; issues + live-agent-count are already mocked there) — this is a legitimate evolution of the guardrail, since Plan 2 intentionally changes Home's composition.

**Files:** Modify `ui/src/__tests__/Dashboard.test.tsx`, `ui/src/__tests__/home/HomeBoard.test.tsx`.

- [ ] **Step 1: `Dashboard.test.tsx`** — extend the existing mocks:
  - Change the `../api/dashboard` mock from `{ homeApi: {...} }` to also export `dashboardApi`: `{ homeApi: { summary: vi.fn().mockResolvedValue(mockHomeSummary) }, dashboardApi: { summary: vi.fn().mockResolvedValue({ costs: { monthSpendCents: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 }, pendingApprovals: 0 }) } }`.
  - Add `vi.mock("../api/work-questions", () => ({ workQuestionsApi: { list: vi.fn().mockResolvedValue([]) } }));`.
  - (`../api/issues` `list` → `[]` and `useLiveAgentCount` → 2 are already mocked.)
  - Add ONE new assertion to the first test: after suggestions render, assert a new widget header is present, e.g. `expect(screen.getByText("Agents working now")).toBeInTheDocument();` (founder default includes it; `useLiveAgentCount` mocked → 2 so it renders).
  - The existing 11 assertions must still pass unchanged.
- [ ] **Step 2:** Run `pnpm --filter @armyofagents/ui exec vitest run src/__tests__/Dashboard.test.tsx` → all pass (11 + the new assertion). If an unmocked-dependency error appears, add the missing mock (do not weaken existing assertions).
- [ ] **Step 3: `HomeBoard.test.tsx`** — extend the populated-data test to mock the new deps: `dashboardApi.summary` (costs + `pendingApprovals`), `workQuestionsApi.list` (→ `[]` or a couple), `issuesApi.list` (→ **at least one non-terminal task** so `My tasks` renders), and `useLiveAgentCount` (→ a number). The query-backed widgets render after a tick, so make the test **async** and `await screen.findByText(...)` for the last async widget (e.g. a My-tasks title) BEFORE asserting the 8-heading order. Assert the founder board renders all 8 headers in `getDefaultLayout("founder")` order; add a member-role case asserting Budget/Approvals are absent and `My tasks` leads.
- [ ] **Step 4:** Run → PASS. **Step 5:** Commit `test(home): board tests cover the 8-widget composition`.

---

## Task 9: Final verification

- [ ] Widget-test edge cases (add to each widget's test, not just happy path): Budget missing/zero data → `null`; Approvals one-sided failure (dash resolves, questions rejects) → `null` (no partial total); My tasks empty → `null`, all-cancelled → `null`, and the 5-item cap; Agents zero → renders "0".
- [ ] `pnpm typecheck` → clean.
- [ ] `pnpm build` → succeeds (canonical; runs prebuild then `pnpm -r build`).
- [ ] `pnpm --filter @armyofagents/ui exec vitest run src/__tests__/home src/__tests__/Dashboard.test.tsx` → all pass.
- [ ] Full UI suite via canonical runner (from repo root, cwd=root): `pnpm test:run` scoped to ui, OR `pnpm exec vitest run ui/src/__tests__` — confirm no other UI test regressed. (Avoid `pnpm --filter ui exec vitest run` for the whole suite — it doubles cwd and trips the `onboarding-dark-bootstrap` path test; that's a runner artifact, not a regression.)
- [ ] Preview check: open `/{companyPrefix}/home` as founder — confirm the new widgets render with real data and links work; as a member (if seedable) confirm Budget/Approvals are absent from the default and `My tasks` leads.

---

## Self-review notes (author)
- **Scope:** UI-only. No new server routes, no migration. Reuses `dashboardApi`/`workQuestionsApi`/`issuesApi`/`useLiveAgentCount`. Budget+Approvals share one `queryKeys.dashboard` query (deduped).
- **Data visibility:** team-visible per the 2026-07-29 decision (the reused endpoints are `assertCompanyAccess`-only today). Role-awareness is arrangement-only (default layout), not data-gating; `requiresFounder` is intentionally NOT set.
- **Graceful degrade:** every widget returns `null` while loading/empty, so an unmocked/erroring dependency never crashes the board (also why the guardrail stays stable).
- **Guardrail evolution:** `Dashboard.test.tsx` gains mocks + one assertion because Plan 2 deliberately changes Home's composition; the original 11 behavior assertions remain intact.
- **Deferred to Plan 3:** fixed-size tiles/compact peeks (these render as stacked sections for now), the add-widget tray (so members can't yet add Budget/Approvals), resize, drag, persistence.
- **Open items for implementer to verify against live code:** the exact `lucide-react` icon names (`Coin`/`CheckSquare`/`ListChecks` → fall back to `CircleDollarSign`/`CheckCircle2` if unexported), the `workQuestionsApi.list` filter object shape, the `Issue` type export + fields, and `dashboardApi.summary` field names (`costs.monthSpendCents` etc.).
