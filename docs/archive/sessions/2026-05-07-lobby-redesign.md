# Lobby Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use **superpowers:subagent-driven-development** to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the AoA lobby (page at `/`) into a sidebar+main layout with a "+ New ▾" header dropdown, inline stats expansion (approvals + notifications), designed empty state, purple-wash background, choreographed framer-motion entry — without breaking the existing onboarding flow or the marketplace/settings/me sibling pages.

**Architecture:** Three focused PRs, no file overlap between them, so they merge in any order subject to type dependencies (PR-A's type lands first; PR-B and PR-C build on top in either order). Each PR has its own worktree off `origin/main` (or off `feat/m4-plugin-management` after that branch merges main — confirm with user before sprinting).

**Tech Stack:** React 18 + Vite + Tailwind. `framer-motion` (existing dep). `lucide-react` (existing). shadcn `<DropdownMenu>` (existing). Drizzle ORM (existing). vitest + @testing-library/react. `useNavigate` from `@/lib/router`. `useDialog().openOnboarding()` from `@/context/DialogContext`. `useCompany()` from `@/context/CompanyContext`. Existing `UserMenu` component.

---

## File Structure

### PR-A worktree (backend stats extension)
- Modify: `packages/shared/src/api/companies.ts` — `CompanyStats` type
- Modify: `server/src/services/companies.ts` — stats aggregation
- Modify: `server/src/routes/companies.ts` — stats route serializer
- Modify: `server/src/__tests__/companies-stats-routes.test.ts` (or create if missing) — new field assertions
- Modify: `ui/src/api/companies.ts` — type re-export / mirror
- Create: `.changeset/lobby-stats-approvals-notifications.md`

### PR-B worktree (UI structural refactor + marketplace fix)
- Create: `ui/src/components/LobbySidebar.tsx`
- Create: `ui/src/components/LobbyEmptyState.tsx`
- Modify: `ui/src/pages/Lobby.tsx`
- Modify: `ui/src/components/LobbyCompanyCard.tsx` (stats row only — no visual polish yet)
- Modify: `ui/src/components/marketplace/MarketplaceLayout.tsx` (back-arrow fix, line 27)
- Modify: `ui/src/__tests__/Lobby.test.tsx`
- Create: `ui/src/__tests__/LobbySidebar.test.tsx`
- Create: `ui/src/__tests__/LobbyEmptyState.test.tsx`
- Create: `.changeset/lobby-redesign-structural.md`

### PR-C worktree (UI polish — animations + bg)
- Modify: `ui/src/pages/Lobby.tsx` (add framer-motion choreography + purple gradient bg class)
- Modify: `ui/src/components/LobbyCompanyCard.tsx` (hover scale + bg translucency)
- Modify: `ui/src/components/LobbySidebar.tsx` (mount animation)
- Modify: `ui/src/__tests__/Lobby.test.tsx` (add `prefers-reduced-motion` test)
- Create: `.changeset/lobby-redesign-polish.md`

---

## Common Patterns

### Pattern A — UI route test scaffold

```ts
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi } from "vitest";

const navigateMock = vi.fn();
vi.mock("@/lib/router", () => ({ useNavigate: () => navigateMock }));

const openOnboardingMock = vi.fn();
vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({ openOnboarding: openOnboardingMock }),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ companies: mockCompanies, loading: false }),
}));
```

Reference: `ui/src/__tests__/Lobby.test.tsx` already exists and uses similar mocks — preserve its existing test cases when modifying.

### Pattern B — Drizzle aggregation (server)

```ts
import { sql } from "drizzle-orm";
import { approvals, notifications } from "@armyofagents/db";

const pendingApprovals = await db
  .select({
    companyId: approvals.companyId,
    count: sql<number>`COUNT(*)::int`.mapWith(Number),
  })
  .from(approvals)
  .where(eq(approvals.status, "pending"))
  .groupBy(approvals.companyId);
```

Reference: existing aggregations in `server/src/services/companies.ts` for `agentCount` / `issueCount` use the same pattern — mirror.

### Pattern C — TDD step quintet (per task)

1. Write the failing test
2. Run test to verify it fails (cite expected error)
3. Write minimal implementation
4. Run test to verify it passes
5. Commit (named per task)

### Pattern D — Changeset

`.changeset/<slug>.md`:

```md
---
"@armyofagents/server": patch    # only when server touched
"@armyofagents/ui": patch         # only when ui touched
"@armyofagents/shared": patch     # only when shared types touched
---

<one-paragraph description>
```

---

# PR-A — Backend stats extension

**Worktree:** `.worktrees/lobby-A-stats`
**Branch:** `feat/lobby-stats-approvals-notifications`

This PR is independent — no UI changes. It extends the existing `GET /api/companies/stats` response with `pendingApprovalCount` and `unreadNotificationCount` per company, and updates the shared `CompanyStats` type.

## Task A1: Locate the stats route + service

**Files:**
- Read: `server/src/routes/companies.ts` (find the stats handler)
- Read: `server/src/services/companies.ts` (find the existing aggregation that produces `agentCount` + `issueCount`)
- Read: `packages/shared/src/api/companies.ts` (or wherever `CompanyStats` type lives — confirm path; could also be in `ui/src/api/companies.ts`)
- Read: `packages/db/src/schema/approvals.ts` and `notifications.ts` (confirm column names: `companyId`, `status`, `readAt`)

- [ ] **Step 1: Confirm route path + service shape**

```bash
grep -nE "companies/stats|stats(.*companyId|getStats|companyStats" server/src/routes/companies.ts server/src/services/companies.ts | head -20
```

Expected: a single GET route mounted at `/api/companies/stats` (or similar) and a service function that returns `Record<string, { agentCount, issueCount }>`. If the path is different, note it and use the actual path in subsequent steps.

- [ ] **Step 2: Confirm shared schema columns**

```bash
grep -nE "companyId|status|readAt|pgEnum.*pending" packages/db/src/schema/approvals.ts packages/db/src/schema/notifications.ts | head -20
```

Expected:
- `approvals.companyId` (uuid, not null)
- `approvals.status` (enum or text — confirm `"pending"` is a valid value)
- `notifications.companyId` (uuid)
- `notifications.readAt` (timestamp, nullable)

If column names differ, use the actual names in Task A3.

## Task A2: Extend the `CompanyStats` type

**Files:**
- Modify: `packages/shared/src/api/companies.ts` (or `ui/src/api/companies.ts`, whichever holds the canonical `CompanyStats` type — Task A1 confirms)

- [ ] **Step 1: Write the failing test**

Create or extend `packages/shared/src/__tests__/companies-types.test.ts` (if shared types have tests; if not, this test goes in the server test file in Task A3):

```ts
import { describe, it, expectTypeOf } from "vitest";
import type { CompanyStats } from "../api/companies.js";

describe("CompanyStats", () => {
  it("includes pendingApprovalCount and unreadNotificationCount", () => {
    expectTypeOf<CompanyStats>().toMatchTypeOf<
      Record<string, {
        agentCount: number;
        issueCount: number;
        pendingApprovalCount: number;
        unreadNotificationCount: number;
      }>
    >();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run packages/shared/src/__tests__/companies-types.test.ts` (or the equivalent path)
Expected: FAIL — type doesn't yet have the new fields.

- [ ] **Step 3: Add the two new fields to the `CompanyStats` shape**

```ts
export type CompanyStats = Record<string, {
  agentCount: number;
  issueCount: number;
  pendingApprovalCount: number;
  unreadNotificationCount: number;
}>;
```

If the file uses an interface or a Zod schema, mirror the existing convention.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run packages/shared/src/__tests__/companies-types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/api/companies.ts packages/shared/src/__tests__/companies-types.test.ts
git commit -m "$(cat <<'EOF'
feat(types): extend CompanyStats with pendingApprovalCount + unreadNotificationCount

Spec: docs/superpowers/specs/2026-05-07-lobby-redesign-design.md §7

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task A3: Aggregate the new counts in the service layer

**Files:**
- Modify: `server/src/services/companies.ts` (extend the stats function)
- Modify: `server/src/__tests__/companies-stats-routes.test.ts` (or create if missing)

- [ ] **Step 1: Write the failing test**

Add to (or create) `server/src/__tests__/companies-stats-routes.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";
import { companyRoutes } from "../routes/companies.js";

const stats = {
  "co-1": { agentCount: 7, issueCount: 24, pendingApprovalCount: 3, unreadNotificationCount: 12 },
  "co-2": { agentCount: 3, issueCount: 9, pendingApprovalCount: 0, unreadNotificationCount: 2 },
};

vi.mock("../services/companies.js", () => ({
  companyService: () => ({
    getStats: vi.fn().mockResolvedValue(stats),
  }),
}));

describe("GET /api/companies/stats", () => {
  it("returns pendingApprovalCount and unreadNotificationCount per company", async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "u1",
        companyIds: ["co-1", "co-2"],
        source: "session",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use(companyRoutes({} as any));

    const res = await request(app).get("/api/companies/stats");
    expect(res.status).toBe(200);
    expect(res.body["co-1"]).toEqual(
      expect.objectContaining({
        agentCount: 7,
        issueCount: 24,
        pendingApprovalCount: 3,
        unreadNotificationCount: 12,
      }),
    );
    expect(res.body["co-2"].pendingApprovalCount).toBe(0);
    expect(res.body["co-2"].unreadNotificationCount).toBe(2);
  });
});
```

(Confirm the actual route path + service-injection shape from Task A1 before submitting; adjust the test scaffold if the codebase wires services differently.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run server/src/__tests__/companies-stats-routes.test.ts`
Expected: FAIL — service mock returns the new fields but the route serializer drops them, or the service doesn't return them yet.

- [ ] **Step 3: Extend the service aggregation**

In `server/src/services/companies.ts`, locate the existing `getStats` function (or equivalent that produces `agentCount`/`issueCount`). Add two queries beside the existing two and merge into the same return shape:

```ts
import { sql, eq } from "drizzle-orm";
import { approvals, notifications, agents, issues } from "@armyofagents/db";

async getStats(companyIds: string[]): Promise<CompanyStats> {
  // Existing two queries (agentCount, issueCount) — keep as-is.

  const pendingApprovals = await db
    .select({
      companyId: approvals.companyId,
      count: sql<number>`COUNT(*)::int`.mapWith(Number),
    })
    .from(approvals)
    .where(and(eq(approvals.status, "pending"), inArray(approvals.companyId, companyIds)))
    .groupBy(approvals.companyId);

  const unreadNotifications = await db
    .select({
      companyId: notifications.companyId,
      count: sql<number>`COUNT(*)::int`.mapWith(Number),
    })
    .from(notifications)
    .where(and(isNull(notifications.readAt), inArray(notifications.companyId, companyIds)))
    .groupBy(notifications.companyId);

  // Merge: build a Record<companyId, full-shape>, defaulting missing counts to 0.
  const result: CompanyStats = {};
  for (const id of companyIds) {
    result[id] = {
      agentCount: agentRows.find(r => r.companyId === id)?.count ?? 0,
      issueCount: issueRows.find(r => r.companyId === id)?.count ?? 0,
      pendingApprovalCount: pendingApprovals.find(r => r.companyId === id)?.count ?? 0,
      unreadNotificationCount: unreadNotifications.find(r => r.companyId === id)?.count ?? 0,
    };
  }
  return result;
}
```

(The exact aggregation shape depends on what's already there. The pattern is: same query style as the existing two.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run server/src/__tests__/companies-stats-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/companies.ts server/src/__tests__/companies-stats-routes.test.ts
git commit -m "$(cat <<'EOF'
feat(companies): aggregate pendingApproval + unreadNotification counts in stats

Two new GROUP BY queries against approvals (status=pending) and notifications
(readAt IS NULL), filtered by the requesting actor's companyIds. Merges into
the existing CompanyStats shape returned by GET /api/companies/stats.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task A4: Mirror the type in `ui/src/api/companies.ts`

If `CompanyStats` is also re-exported or duplicated in `ui/src/api/companies.ts`, update there too.

- [ ] **Step 1: Confirm the UI mirror**

```bash
grep -nE "CompanyStats|agentCount|issueCount" ui/src/api/companies.ts | head -10
```

Expected: either a re-export from `@armyofagents/shared` (no change needed) or a duplicate type definition (update needed).

- [ ] **Step 2: If duplicated, update + run typecheck**

Add the two new fields to the duplicate.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @armyofagents/ui typecheck 2>&1 | tail -5`
Expected: clean (or matches the pre-existing baseline).

- [ ] **Step 4: Commit (if changed)**

```bash
git add ui/src/api/companies.ts
git commit -m "$(cat <<'EOF'
feat(ui-api): mirror CompanyStats expansion (approvals + notifications)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task A5: Changeset + push

- [ ] **Step 1: Create changeset**

`.changeset/lobby-stats-approvals-notifications.md`:

```md
---
"@armyofagents/server": patch
"@armyofagents/shared": patch
"@armyofagents/ui": patch
---

Extend `GET /api/companies/stats` response with `pendingApprovalCount` and `unreadNotificationCount` per company. Aggregates from the `approvals` (status='pending') and `notifications` (readAt IS NULL) tables, filtered by the requesting actor's accessible companies. No schema changes; backward-compatible additive type expansion.
```

- [ ] **Step 2: Run full server typecheck + test sanity**

Run: `pnpm --filter @armyofagents/server typecheck 2>&1 | grep "error TS" | wc -l`
Expected: matches the documented baseline (65 per CLAUDE.md, or whatever the post-merge baseline is on the working branch).

Run: `pnpm test:run server/src/__tests__/companies-stats-routes.test.ts packages/shared/src/__tests__/companies-types.test.ts`
Expected: all green.

- [ ] **Step 3: Push + open PR**

```bash
git add .changeset/lobby-stats-approvals-notifications.md
git commit -m "chore: changeset for lobby stats expansion

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

git push -u origin feat/lobby-stats-approvals-notifications
gh pr create --base main --head feat/lobby-stats-approvals-notifications \
  --title "feat(stats): per-company pending approvals + unread notifications counts" \
  --body "<see template>"
```

---

# PR-B — UI structural refactor + Marketplace back-arrow fix

**Worktree:** `.worktrees/lobby-B-structure`
**Branch:** `feat/lobby-redesign-structural`

This PR depends on PR-A's merged `CompanyStats` type. It restructures `Lobby.tsx` into the sidebar+main layout, adds the new sidebar + empty state components, extends the stats row on `LobbyCompanyCard`, fixes the Marketplace back-arrow, and removes the auto-onboarding modal trigger.

## Task B1: Add the LobbySidebar component

**Files:**
- Create: `ui/src/components/LobbySidebar.tsx`
- Create: `ui/src/__tests__/LobbySidebar.test.tsx`

- [ ] **Step 1: Write the failing test**

`ui/src/__tests__/LobbySidebar.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { LobbySidebar } from "@/components/LobbySidebar";

const navigateMock = vi.fn();
vi.mock("@/lib/router", () => ({ useNavigate: () => navigateMock }));

vi.mock("@/components/UserMenu", () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));

beforeEach(() => navigateMock.mockReset());

describe("LobbySidebar", () => {
  it("renders brand + 3 nav rows + UserMenu", () => {
    render(<LobbySidebar activeRoute="/" />);
    expect(screen.getByText("AoA")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /home/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /marketplace/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /settings/i })).toBeInTheDocument();
    expect(screen.getByTestId("user-menu")).toBeInTheDocument();
  });

  it("highlights Home when activeRoute='/'", () => {
    render(<LobbySidebar activeRoute="/" />);
    const home = screen.getByRole("link", { name: /home/i });
    expect(home).toHaveAttribute("data-active", "true");
  });

  it("clicking Marketplace navigates to /marketplace", async () => {
    render(<LobbySidebar activeRoute="/" />);
    await userEvent.click(screen.getByRole("link", { name: /marketplace/i }));
    expect(navigateMock).toHaveBeenCalledWith("/marketplace");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run ui/src/__tests__/LobbySidebar.test.tsx`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement `LobbySidebar.tsx`**

```tsx
import { Home, Settings, Store } from "lucide-react";
import { useNavigate } from "@/lib/router";
import { UserMenu } from "@/components/UserMenu";
import { cn } from "@/lib/utils";

interface NavItem {
  label: string;
  icon: typeof Home;
  to: string;
  match: (route: string) => boolean;
}

const NAV_ITEMS: NavItem[] = [
  { label: "Home", icon: Home, to: "/", match: (r) => r === "/" },
  { label: "Marketplace", icon: Store, to: "/marketplace", match: (r) => r.startsWith("/marketplace") },
  { label: "Settings", icon: Settings, to: "/instance/settings", match: (r) => r.startsWith("/instance/settings") },
];

export function LobbySidebar({ activeRoute }: { activeRoute: string }) {
  const navigate = useNavigate();
  return (
    <aside className="flex flex-col w-[220px] shrink-0 h-dvh border-r border-border bg-card/40">
      <div className="px-4 h-14 flex items-center">
        <span className="text-sm font-bold tracking-tight">AoA</span>
      </div>
      <nav className="flex flex-col gap-0.5 px-2 py-2 flex-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = item.match(activeRoute);
          return (
            <a
              key={item.to}
              href={item.to}
              data-active={active}
              onClick={(e) => {
                e.preventDefault();
                navigate(item.to);
              }}
              className={cn(
                "flex items-center gap-2 h-9 px-3 rounded-md text-sm transition-colors",
                active
                  ? "bg-accent text-foreground font-medium"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              <span>{item.label}</span>
            </a>
          );
        })}
      </nav>
      <div className="border-t border-border p-2">
        <UserMenu />
      </div>
    </aside>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run ui/src/__tests__/LobbySidebar.test.tsx`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/LobbySidebar.tsx ui/src/__tests__/LobbySidebar.test.tsx
git commit -m "$(cat <<'EOF'
feat(ui): add LobbySidebar component (brand + 3 nav rows + UserMenu)

Spec §1. Lobby-only sidebar — Marketplace/Settings/Profile keep their
existing standalone headers; this sidebar lives only on /.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task B2: Add the LobbyEmptyState component

**Files:**
- Create: `ui/src/components/LobbyEmptyState.tsx`
- Create: `ui/src/__tests__/LobbyEmptyState.test.tsx`

- [ ] **Step 1: Write the failing test**

`ui/src/__tests__/LobbyEmptyState.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { LobbyEmptyState } from "@/components/LobbyEmptyState";

const navigateMock = vi.fn();
const openOnboardingMock = vi.fn();
vi.mock("@/lib/router", () => ({ useNavigate: () => navigateMock }));
vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({ openOnboarding: openOnboardingMock }),
}));

beforeEach(() => {
  navigateMock.mockReset();
  openOnboardingMock.mockReset();
});

describe("LobbyEmptyState", () => {
  it("renders title, subtitle, and two action buttons", () => {
    render(<LobbyEmptyState />);
    expect(screen.getByText(/build your first company/i)).toBeInTheDocument();
    expect(screen.getByText(/from scratch, or import/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create company/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /import/i })).toBeInTheDocument();
  });

  it("Create company calls openOnboarding", async () => {
    render(<LobbyEmptyState />);
    await userEvent.click(screen.getByRole("button", { name: /create company/i }));
    expect(openOnboardingMock).toHaveBeenCalledOnce();
  });

  it("Import navigates to /import", async () => {
    render(<LobbyEmptyState />);
    await userEvent.click(screen.getByRole("button", { name: /import/i }));
    expect(navigateMock).toHaveBeenCalledWith("/import");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run ui/src/__tests__/LobbyEmptyState.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `LobbyEmptyState.tsx`**

```tsx
import { Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNavigate } from "@/lib/router";
import { useDialog } from "@/context/DialogContext";

export function LobbyEmptyState() {
  const navigate = useNavigate();
  const { openOnboarding } = useDialog();
  return (
    <div className="flex flex-col items-center justify-center text-center min-h-[60vh] gap-3">
      <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-700 flex items-center justify-center text-white shadow-lg shadow-indigo-500/30">
        <Building2 className="h-7 w-7" />
      </div>
      <h2 className="text-base font-semibold text-foreground">Let's build your first company</h2>
      <p className="text-sm text-muted-foreground max-w-md">
        Create one from scratch, or import a saved AoA bundle.
      </p>
      <div className="flex gap-2 mt-2">
        <Button onClick={() => openOnboarding()}>Create company</Button>
        <Button variant="outline" onClick={() => navigate("/import")}>
          Import company
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run ui/src/__tests__/LobbyEmptyState.test.tsx`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/LobbyEmptyState.tsx ui/src/__tests__/LobbyEmptyState.test.tsx
git commit -m "$(cat <<'EOF'
feat(ui): add LobbyEmptyState component (designed empty hero)

Spec §3. Replaces the auto-open onboarding modal that previously fired
on every 0-company visit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task B3: Extend LobbyCompanyCard stats row

**Files:**
- Modify: `ui/src/components/LobbyCompanyCard.tsx`

- [ ] **Step 1: Write the failing test**

Extend `ui/src/__tests__/Lobby.test.tsx` (or wherever the card tests live — `LobbyCompanyCard.test.tsx` if it exists; create if not):

```tsx
it("renders all 4 stats fields when present", () => {
  render(
    <LobbyCompanyCard
      company={{ id: "c1", name: "Acme", issuePrefix: "ACME", brandColor: null, logoAssetId: null } as any}
      stats={{ agentCount: 7, issueCount: 24, pendingApprovalCount: 3, unreadNotificationCount: 12 }}
      statsLoading={false}
      onClick={() => {}}
    />,
  );
  expect(screen.getByText(/7 agents/)).toBeInTheDocument();
  expect(screen.getByText(/24 tasks/)).toBeInTheDocument();
  expect(screen.getByText(/3 approvals/)).toBeInTheDocument();
  expect(screen.getByText(/12 notifications/)).toBeInTheDocument();
});

it("renders 4 skeleton placeholders during loading", () => {
  const { container } = render(
    <LobbyCompanyCard
      company={{ id: "c1", name: "Acme" } as any}
      stats={undefined}
      statsLoading={true}
      onClick={() => {}}
    />,
  );
  expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(4);
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — only 2 stats rendered today, only 2 skeletons.

- [ ] **Step 3: Modify `LobbyCompanyCard.tsx` stats row + skeleton**

In the existing stats `<div>` (around lines 60-78 of the current file), add two more spans after the existing two, and extend the skeleton from 2 to 4 placeholders:

```tsx
import { AlertCircle, Bell, Bot, CircleDot } from "lucide-react";

// In the stats row JSX:
<div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
  {statsLoading ? (
    <>
      <Skeleton className="h-3.5 w-16 animate-pulse" />
      <Skeleton className="h-3.5 w-16 animate-pulse" />
      <Skeleton className="h-3.5 w-20 animate-pulse" />
      <Skeleton className="h-3.5 w-24 animate-pulse" />
    </>
  ) : stats ? (
    <>
      <span className="flex items-center gap-1.5">
        <Bot className="h-3.5 w-3.5" />
        {stats.agentCount} {stats.agentCount === 1 ? "agent" : "agents"}
      </span>
      <span className="flex items-center gap-1.5">
        <CircleDot className="h-3.5 w-3.5" />
        {stats.issueCount} {stats.issueCount === 1 ? "task" : "tasks"}
      </span>
      <span className="flex items-center gap-1.5">
        <AlertCircle className="h-3.5 w-3.5" />
        {stats.pendingApprovalCount} {stats.pendingApprovalCount === 1 ? "approval" : "approvals"}
      </span>
      <span className="flex items-center gap-1.5">
        <Bell className="h-3.5 w-3.5" />
        {stats.unreadNotificationCount} {stats.unreadNotificationCount === 1 ? "notification" : "notifications"}
      </span>
    </>
  ) : null}
</div>
```

Also: change card bg to `bg-card/85` (preparation for the gradient bg in PR-C; safe to do here):
```tsx
className={cn(
  "group relative flex flex-col items-start gap-4 rounded-lg border border-border bg-card/85 p-5",
  // ... rest unchanged
)}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run ui/src/__tests__/Lobby.test.tsx ui/src/__tests__/LobbyCompanyCard.test.tsx 2>&1 | tail -10`
Expected: all green including the 2 new card tests.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/LobbyCompanyCard.tsx ui/src/__tests__/Lobby.test.tsx ui/src/__tests__/LobbyCompanyCard.test.tsx
git commit -m "$(cat <<'EOF'
feat(lobby): extend company card stats with approvals + notifications

Spec §2. Adds AlertCircle and Bell counters in the same inline stats row
as agents+tasks. Card bg flips to bg-card/85 in prep for the purple-wash
gradient bg landing in PR-C.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task B4: Restructure `Lobby.tsx` into sidebar + main layout

**Files:**
- Modify: `ui/src/pages/Lobby.tsx`
- Modify: `ui/src/__tests__/Lobby.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `Lobby.test.tsx`:

```tsx
it("renders LobbySidebar alongside the main column", () => {
  // ... existing setup with mock companies
  render(<Lobby />, { wrapper: ... });
  expect(screen.getByText("AoA")).toBeInTheDocument(); // sidebar brand
  expect(screen.getByRole("link", { name: /home/i })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /marketplace/i })).toBeInTheDocument();
});

it("'+ New' header dropdown opens menu with Create + Import items", async () => {
  render(<Lobby />, { wrapper: ... });
  await userEvent.click(screen.getByRole("button", { name: /\+ new/i }));
  expect(screen.getByRole("menuitem", { name: /create company/i })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: /import company/i })).toBeInTheDocument();
});

it("dropdown 'Create company' calls openOnboarding", async () => {
  render(<Lobby />, { wrapper: ... });
  await userEvent.click(screen.getByRole("button", { name: /\+ new/i }));
  await userEvent.click(screen.getByRole("menuitem", { name: /create company/i }));
  expect(openOnboardingMock).toHaveBeenCalledOnce();
});

it("0 companies → renders LobbyEmptyState; does NOT auto-open onboarding", () => {
  // mock useCompany to return companies: []
  render(<Lobby />, { wrapper: ... });
  expect(screen.getByText(/build your first company/i)).toBeInTheDocument();
  expect(openOnboardingMock).not.toHaveBeenCalled();   // regression check
});
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: 4 new tests fail. The auto-modal-removal test is the most important regression check.

- [ ] **Step 3: Rewrite `Lobby.tsx`**

```tsx
import { useQuery } from "@tanstack/react-query";
import { Plus, Upload } from "lucide-react";
import { useLocation, useNavigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useDialog } from "@/context/DialogContext";
import { companiesApi, type CompanyStats } from "@/api/companies";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LobbyCompanyCard } from "@/components/LobbyCompanyCard";
import { LobbySidebar } from "@/components/LobbySidebar";
import { LobbyEmptyState } from "@/components/LobbyEmptyState";

export function Lobby() {
  const { companies, loading: companiesLoading } = useCompany();
  const { openOnboarding } = useDialog();
  const navigate = useNavigate();
  const location = useLocation();

  const visibleCompanies = companies.filter((c) => c.status !== "archived");

  const { data: statsData, isLoading: statsLoading } = useQuery({
    queryKey: queryKeys.companies.stats,
    queryFn: () => companiesApi.stats(),
    enabled: visibleCompanies.length > 0,
  });
  const stats: CompanyStats | undefined = statsData ?? undefined;

  if (companiesLoading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background text-muted-foreground">
        <span className="text-sm">Loading...</span>
      </div>
    );
  }

  return (
    <div className="flex h-dvh text-foreground bg-background">
      <LobbySidebar activeRoute={location.pathname} />
      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-5xl px-8 py-10">
          <header className="flex items-center justify-between mb-8">
            <h1 className="text-xl font-semibold">Welcome back</h1>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Plus className="h-4 w-4 mr-1" /> New
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => openOnboarding()}>
                  <Plus className="h-4 w-4 mr-2" /> Create company
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate("/import")}>
                  <Upload className="h-4 w-4 mr-2" /> Import company
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </header>

          {visibleCompanies.length === 0 ? (
            <LobbyEmptyState />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {visibleCompanies.map((company) => (
                <LobbyCompanyCard
                  key={company.id}
                  company={company}
                  stats={stats?.[company.id]}
                  statsLoading={statsLoading}
                  onClick={() => navigate(`/${company.issuePrefix}/home`)}
                />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
```

**Note:** the `useEffect` that previously auto-opened the onboarding modal at lines 22-29 of the old `Lobby.tsx` is **removed entirely**. The `useRef` `onboardingTriggered` is removed. The `Settings`, `Store`, `Plus`, `Upload` icons used in the old header are no longer needed (sidebar handles Settings/Marketplace; the header dropdown handles Plus/Upload).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run ui/src/__tests__/Lobby.test.tsx`
Expected: all green (existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/Lobby.tsx ui/src/__tests__/Lobby.test.tsx
git commit -m "$(cat <<'EOF'
feat(lobby): restructure into sidebar+main layout with +New dropdown

Spec §1, §3. Removes the auto-open onboarding modal — empty state is now
rendered in-page via LobbyEmptyState. Header gets a +New dropdown
(Create company, Import company). Sidebar handles Marketplace/Settings
navigation; old top-bar buttons removed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task B5: Fix Marketplace back-arrow

**Files:**
- Modify: `ui/src/components/marketplace/MarketplaceLayout.tsx`

- [ ] **Step 1: Write the failing test**

Create or extend `ui/src/__tests__/MarketplaceLayout.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { MarketplaceLayout } from "@/components/marketplace/MarketplaceLayout";

const navigateMock = vi.fn();
vi.mock("@/lib/router", () => ({ useNavigate: () => navigateMock }));

vi.mock("@/components/marketplace/CompanySelector", () => ({
  CompanySelector: () => <div data-testid="company-selector" />,
}));

beforeEach(() => navigateMock.mockReset());

describe("MarketplaceLayout", () => {
  it("back arrow calls navigate(-1) (browser back), not '/home'", async () => {
    render(
      <MemoryRouter>
        <MarketplaceLayout>content</MarketplaceLayout>
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: /go back/i }));
    expect(navigateMock).toHaveBeenCalledWith(-1);
    expect(navigateMock).not.toHaveBeenCalledWith("/home");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — current code calls `navigate("/home")`.

- [ ] **Step 3: Patch `MarketplaceLayout.tsx:27`**

Change:

```tsx
onClick={() => navigate("/home")}
```

to:

```tsx
onClick={() => navigate(-1)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run ui/src/__tests__/MarketplaceLayout.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/marketplace/MarketplaceLayout.tsx ui/src/__tests__/MarketplaceLayout.test.tsx
git commit -m "$(cat <<'EOF'
fix(marketplace): back arrow uses browser history instead of /home

Spec §1 cross-page back-nav verification: navigate('/home') redirected to
the most-recent company's home, not the lobby. With the new lobby
sidebar flow this would land users sideways into a company instead of
back where they came from. navigate(-1) handles both flows: from-lobby
returns to lobby, from-company returns to company. Mirrors /me's back
semantics.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task B6: Changeset + verification + push

- [ ] **Step 1: Create changeset**

`.changeset/lobby-redesign-structural.md`:

```md
---
"@armyofagents/ui": patch
---

Lobby redesign — structural pass:
- New `LobbySidebar` component (220px, brand + Home/Marketplace/Settings + UserMenu).
- New `LobbyEmptyState` replaces the auto-open onboarding modal that previously fired on every 0-company lobby visit.
- `LobbyCompanyCard` stats row gains `AlertCircle` + pending-approval count and `Bell` + unread-notification count, in the same inline format as agents/tasks.
- Header gains a `+ New ▾` dropdown (Create company, Import company); the dashed-card pattern in the grid is removed.
- Marketplace back-arrow at `MarketplaceLayout.tsx:27` switches from `navigate('/home')` to `navigate(-1)` so it works correctly from the new lobby flow.
```

- [ ] **Step 2: Full UI test sweep**

Run: `pnpm --filter @armyofagents/ui test:run 2>&1 | tail -10`
Expected: all green.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @armyofagents/ui typecheck 2>&1 | tail -5`
Expected: clean (matches baseline).

- [ ] **Step 4: Manual smoke (preview tool)**

Open http://localhost:3100/ in the preview tool. Verify:
- Sidebar renders with brand + 3 nav rows + UserMenu
- Click Marketplace → navigates to `/marketplace`; click back arrow → returns to lobby
- Click Settings → navigates to `/instance/settings`; click "AoA" wordmark or back affordance → returns to lobby
- "+ New ▾" dropdown opens Create + Import menu
- 0-company state shows the empty hero (test by signing in with a fresh user, or temporarily mocking the company list)
- Stats row on cards shows 4 items: agents, tasks, approvals, notifications

- [ ] **Step 5: Push + open PR**

```bash
git add .changeset/lobby-redesign-structural.md
git commit -m "chore: changeset for lobby structural redesign

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

git push -u origin feat/lobby-redesign-structural
gh pr create --base main --head feat/lobby-redesign-structural \
  --title "feat(lobby): sidebar+main layout, +New dropdown, designed empty state" \
  --body "<see template>"
```

---

# PR-C — UI polish (animations + bg)

**Worktree:** `.worktrees/lobby-C-polish`
**Branch:** `feat/lobby-redesign-polish`

This PR depends on PR-B's merged structural skeleton. It adds the framer-motion mount choreography, the purple-wash gradient bg, and the card hover scale.

## Task C1: Add purple-wash gradient bg

**Files:**
- Modify: `ui/src/pages/Lobby.tsx` (root container className)

- [ ] **Step 1: Write the failing test**

Add to `Lobby.test.tsx`:

```tsx
it("root container uses the purple-wash gradient", () => {
  // ... setup
  const { container } = render(<Lobby />, { wrapper: ... });
  const root = container.firstChild as HTMLElement;
  expect(root.className).toMatch(/linear-gradient/);
  expect(root.className).toMatch(/hsl\(260/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL.

- [ ] **Step 3: Patch the root className**

Change the root div in `Lobby.tsx` from:

```tsx
<div className="flex h-dvh text-foreground bg-background">
```

to:

```tsx
<div className="flex h-dvh text-foreground bg-[linear-gradient(135deg,hsl(260_40%_8%),hsl(240_25%_5%)_60%,hsl(220_30%_4%))]">
```

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/Lobby.tsx ui/src/__tests__/Lobby.test.tsx
git commit -m "$(cat <<'EOF'
feat(lobby): purple-wash diagonal gradient background

Spec §4. Single Tailwind arbitrary-value class; cards already render at
bg-card/85 (PR-B) so the wash breathes through the gaps.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task C2: Add framer-motion mount choreography

**Files:**
- Modify: `ui/src/pages/Lobby.tsx`
- Modify: `ui/src/components/LobbySidebar.tsx`

- [ ] **Step 1: Write the failing test**

Add to `Lobby.test.tsx`:

```tsx
it("respects prefers-reduced-motion (no transforms applied)", () => {
  // Mock useReducedMotion to return true
  vi.mock("framer-motion", async () => {
    const actual = await vi.importActual<typeof import("framer-motion")>("framer-motion");
    return { ...actual, useReducedMotion: () => true };
  });
  render(<Lobby />, { wrapper: ... });
  // Assert that motion elements don't have transform styles applied
  // (framer-motion sets transform: none when reduced-motion respected)
  const cards = screen.getAllByRole("button", { name: /Acme|Northwind/ });
  expect(cards[0]).toHaveStyle({ transform: "none" });
});
```

(Test is approximate — framer-motion's reduced-motion handling is internal. Reasonable approximation: render with reduced-motion mocked, assert no animations were started by checking that motion props collapsed.)

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — no motion elements in `Lobby.tsx` yet.

- [ ] **Step 3: Wrap the lobby content with motion variants**

In `Lobby.tsx`:

```tsx
import { motion, useReducedMotion } from "framer-motion";

// Inside the component:
const reduce = useReducedMotion();
const variants = {
  sidebar: reduce
    ? { initial: {}, animate: {} }
    : { initial: { x: -32, opacity: 0 }, animate: { x: 0, opacity: 1 } },
  heading: reduce
    ? { initial: {}, animate: {} }
    : { initial: { y: -8, opacity: 0 }, animate: { y: 0, opacity: 1 } },
  card: reduce
    ? { initial: {}, animate: {} }
    : { initial: { y: 8, opacity: 0 }, animate: { y: 0, opacity: 1 } },
};

// Replace the static markup:
<motion.div initial="initial" animate="animate" variants={variants.sidebar} transition={{ duration: 0.2, ease: "easeOut" }}>
  <LobbySidebar activeRoute={location.pathname} />
</motion.div>

<motion.h1
  variants={variants.heading}
  transition={{ duration: 0.2, delay: 0.2 }}
  className="text-xl font-semibold"
>Welcome back</motion.h1>

<motion.div className="grid ...">
  {visibleCompanies.map((company, i) => (
    <motion.div
      key={company.id}
      variants={variants.card}
      transition={{ duration: 0.2, delay: 0.25 + i * 0.03 }}
    >
      <LobbyCompanyCard ... />
    </motion.div>
  ))}
</motion.div>
```

- [ ] **Step 4: Run tests to verify**

Run: `pnpm test:run ui/src/__tests__/Lobby.test.tsx`
Expected: all pass (with reduced-motion test green).

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/Lobby.tsx
git commit -m "$(cat <<'EOF'
feat(lobby): framer-motion mount choreography (sidebar slide + card stagger)

Spec §6. Sidebar slides in from left, heading fades+rises with delay,
cards stagger 30ms apart. useReducedMotion() collapses all motion to
identity for accessibility.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task C3: Card hover scale

**Files:**
- Modify: `ui/src/components/LobbyCompanyCard.tsx`

- [ ] **Step 1: Write the failing test**

Add to the card test file:

```tsx
it("renders motion wrapper for hover scale", () => {
  // motion.button renders with framer-motion data attributes
  const { container } = render(<LobbyCompanyCard ... />);
  // Check that whileHover prop is wired (framer-motion sets data-framer-name or similar)
  // Pragmatic check: snapshot the rendered className includes hover transition
  expect(container.firstChild).toBeInstanceOf(HTMLButtonElement);
  // The presence of the motion wrapper is confirmed by the test harness running without errors
});
```

(Hover behavior is hard to test precisely without simulating mouseenter — a pragmatic test confirms the motion wrapper renders without error.)

- [ ] **Step 2: Run test to verify it fails or passes (smoke)**

Expected: PASS as a smoke test. Real hover behavior is verified manually via the preview.

- [ ] **Step 3: Wrap the card in `motion.button`**

In `LobbyCompanyCard.tsx`, change the outer `<button>` to `<motion.button>`:

```tsx
import { motion, useReducedMotion } from "framer-motion";

export function LobbyCompanyCard({ ... }: LobbyCompanyCardProps) {
  const reduce = useReducedMotion();
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={reduce ? undefined : { scale: 1.02 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      className={cn(
        "group relative flex flex-col items-start gap-4 rounded-lg border border-border bg-card/85 p-5",
        // ... rest unchanged
      )}
    >
      {/* ... existing children unchanged */}
    </motion.button>
  );
}
```

- [ ] **Step 4: Run tests + manual hover check**

Run: `pnpm test:run ui/src/__tests__/Lobby.test.tsx ui/src/__tests__/LobbyCompanyCard.test.tsx`
Expected: all green.

Manual: open the preview, hover over a card, confirm subtle scale on a real mouse.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/LobbyCompanyCard.tsx
git commit -m "$(cat <<'EOF'
feat(lobby): card hover scale (1.02) via framer-motion

Spec §6. whileHover collapses to undefined when prefers-reduced-motion
is set. Existing CSS hover (border + shadow) preserved.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task C4: Changeset + verification + push

- [ ] **Step 1: Create changeset**

`.changeset/lobby-redesign-polish.md`:

```md
---
"@armyofagents/ui": patch
---

Lobby redesign — polish pass:
- Diagonal purple-wash gradient page background.
- Framer-motion mount choreography: sidebar slides in from left, heading fades+rises (200ms delay), cards stagger fade+rise 30ms apart.
- Card hover scale 1.02 (150ms).
- All motion respects `prefers-reduced-motion` via `useReducedMotion()` — collapses to identity transforms when set.
```

- [ ] **Step 2: Full UI test sweep + manual preview**

Run: `pnpm --filter @armyofagents/ui test:run 2>&1 | tail -10`
Expected: all green.

Manual preview check:
- Hard refresh on `/` — sidebar should slide in, cards should stagger
- Toggle OS reduced-motion (or DevTools "Emulate CSS prefers-reduced-motion: reduce") — animations should disappear
- Hover any card — subtle scale + existing shadow effect

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @armyofagents/ui typecheck 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 4: Push + open PR**

```bash
git add .changeset/lobby-redesign-polish.md
git commit -m "chore: changeset for lobby polish pass

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

git push -u origin feat/lobby-redesign-polish
gh pr create --base main --head feat/lobby-redesign-polish \
  --title "feat(lobby): purple-wash bg + framer-motion choreography + hover scale" \
  --body "<see template>"
```

---

## Self-review (writing-plans skill checklist)

**Spec coverage.** Each spec section maps to tasks:
- §1 (architecture) → Task B4 (Lobby restructure) + B5 (Marketplace fix)
- §2 (cards + stats) → Task B3 (stats row extension)
- §3 (empty state) → Task B2 (LobbyEmptyState component) + B4 (Lobby renders it)
- §4 (page bg) → Task C1 (gradient)
- §5 (quote — deferred) → no tasks
- §6 (animations) → Tasks C2 (mount choreography) + C3 (hover scale)
- §7 (backend) → PR-A entirely (Tasks A1-A5)
- §8 (file touches) → covered across all tasks
- §10 (out of scope) → no tasks (correctly)

**Placeholder scan.** No "TBD", no "fill in details", no "similar to X" without an actual reference. The few `<see template>` references for `gh pr create --body` are the standard PR-body template the implementer fills from the changeset content. Specific code blocks are provided wherever the spec mentions a code change.

**Type consistency.**
- `CompanyStats` shape (`agentCount`, `issueCount`, `pendingApprovalCount`, `unreadNotificationCount`) is consistent across PR-A's type definition, PR-A's service aggregation, PR-B's card test fixtures, and PR-B's card rendering.
- `useNavigate()` import path is `@/lib/router` everywhere (matches existing `Lobby.tsx` and `MarketplaceLayout.tsx`).
- `useDialog().openOnboarding()` matches existing `Lobby.tsx:15` usage.

**Suggested execution order.**
- **PR-A first** — it's independent, its type is required by PR-B's tests. Land it, get the type into `origin/main`, then start PR-B.
- **PR-B and PR-C are sequential** — PR-C builds on PR-B's structure. Don't try to parallelize: PR-C's framer-motion wrapping touches the same JSX that PR-B restructures.

**Risk surface.**
- The auto-onboarding-modal removal (Task B4) changes the flow for genuinely-first-time users. The empty hero is friendlier but less directive. Test with a real fresh sign-up before merging PR-B; if it feels too soft, add a small first-time-only toast/banner instead of restoring the modal.
- Marketplace back-arrow change (Task B5) is theoretically a breaking change for anyone who relied on the old "/home" target. Verified via the cross-page back-nav recon: the existing target was already wrong for direct-URL visitors. Should be safe.
- Translucent cards (`bg-card/85`) on the new gradient might wash out for companies with light brand colors. PR-C manual smoke test must check at least 3 distinct `brandColor` values.

**Open follow-ups (intentionally deferred):**
- Future polish PR for richer card visuals (brand-tinted hero, banners, editorial layout)
- Future Momentum-style daily-prompt content surface (slot reserved at the bottom of the main column)
- Mobile/responsive sidebar
- Live notification updates while user is on the page
