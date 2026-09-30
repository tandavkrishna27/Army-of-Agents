# In-Company Sidebar — Phase E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use **superpowers:subagent-driven-development** (recommended) or **superpowers:executing-plans** to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the locked Phase A–D chrome patterns to the in-company sidebar (`ui/src/components/Sidebar.tsx`): 220px/56px widths, external `SidebarCollapseToggle`, brand-red glow dot active state, hidden scrollbar, header reduced to `[logo + company-name → back-to-lobby]`. Remove Marketplace, Updates, and the bottom `UserMenu` (now lobby-only per Phase A). Drop entity-color icons on system nav rows (Decision A). For dynamic Department/Project sections: keep the existing colored-square treatment for **Departments**, switch **Projects** to a Lucide `Rocket` icon tinted in the entity color (`project.color`).

**Architecture:** UI-only chrome refactor. No schema, no API, no routing changes. Reuses existing primitives: `SidebarCollapseToggle` (already shared, used by `LobbySidebar`), `SidebarSection` (collapsed-mode hairline divider already implemented), `SidebarProjectsByType` (modify project rendering only). Mobile drawer mode (via `useSidebar().isMobile` + the slide-over in `Layout.tsx`) preserved verbatim — external collapse toggle is hidden in drawer mode (parity with `LobbySidebar`'s `drawer` prop).

**Tech Stack:** React 18 + Vite + Tailwind. `lucide-react` (`Rocket`, `PanelLeftClose`/`PanelLeftOpen` already imported by `SidebarCollapseToggle`). React Router (`useNavigate`). Existing `useSidebar()` context (manages `collapsed` + `isMobile` + `sidebarOpen` for mobile drawer). vitest + @testing-library/react.

**Spec:** `.superpowers/company-sidebar-v1.html` mockup (locked Variant L, 2026-05-09). Dropped from in-company sidebar: Marketplace (lobby only), Updates (folded into Marketplace at lobby tier), `UserMenu` avatar (lobby only), entity-color icons on system nav. Department visual stays as colored 14px rounded square (current `SidebarProjectsByType` behavior unchanged for departments). Project visual switches from colored square to `Rocket` tinted in `project.color`. Active-state pattern matches `LobbyNavRow` (design-system §8.2.1): `bg-brand/[0.08] text-[hsl(15_60%_75%)]` row tint + 5px brand-red glow dot at row-right (expanded) or icon-top-right (collapsed).

---

## Files

| Action | Path | What changes |
|--------|------|--------------|
| Modify | `ui/src/components/Sidebar.tsx` | Width 220px/56px; header h-14 (logo + company-name only, click → `/`); render `<SidebarCollapseToggle>` adjacent (skip in mobile drawer mode); drop Marketplace + Updates rows; drop bottom `UserMenu`; drop `entityColor` props on system nav (Discussions/Tasks/Agents/Memory); add `hide-scrollbar` utility class to nav scroll region |
| Modify | `ui/src/components/SidebarNavItem.tsx` | Replace active-state classes (`bg-accent` → `bg-brand/[0.08] text-[hsl(15_60%_75%)]` + brand-red glow dot pseudo-element). Drop `entityColor` prop entirely. Both expanded + collapsed branches updated. |
| Modify | `ui/src/components/SidebarProjectsByType.tsx` | When `type === "project"`, render `<Rocket>` icon (size-4) tinted via inline `style={{ color: project.color ?? "#6366f1" }}` instead of the colored square span. Departments unchanged. Apply same swap to the collapsed-mode rendering at lines 141–174. Active-state classes updated to match new pattern. |
| Modify | `ui/src/components/Layout.tsx` | Remove the `overflow-hidden` + `w-12 / w-60` wrapper around `<Sidebar />` (lines 233–245); the sidebar now manages its own width and the toggle needs to overflow the boundary. Add `relative` to the wrapper for the toggle's `position: absolute` anchor. Mobile slide-over branch unchanged. |
| Modify | `ui/src/__tests__/useSidebarOrder.test.tsx` | No code change expected — verify it still passes (this hook is decoupled). Documented here so reviewers know it was checked. |
| Create | `ui/src/__tests__/Sidebar.test.tsx` | New focused test file. 6 tests: (1) renders without Marketplace row, (2) renders without Updates row, (3) renders without bottom `UserMenu`, (4) header company-name navigates to `/` on click, (5) external `SidebarCollapseToggle` is rendered on desktop and absent in mobile drawer mode, (6) project rows render with `Rocket` icon tinted in `project.color`. |
| Create | `.changeset/in-company-sidebar-phase-e.md` | `patch` bump; one-line summary "Redesign in-company sidebar (Phase E): Phase A–D chrome parity, drop Marketplace/Updates/avatar, Rocket icons for projects." |

**Total:** 4 modified, 2 created, 0 deleted. The `SidebarCollapseToggle` and `SidebarSection` components are unchanged (already correct).

---

## Verification rules (apply to every task)

1. **TDD order** — failing test first, see it fail with the right error, implement, see it pass, commit.
2. **Per-task scoped tests** before commit (`pnpm vitest run src/__tests__/Sidebar.test.tsx` for tasks 1–3); broader UI suite (`pnpm vitest run --dir src/__tests__`) at end of each task.
3. **Conventional commits**: `feat(ui):`, `refactor(ui):`, `test(ui):`, `chore(ui):`.
4. **Typecheck after each task** — `pnpm exec tsc --noEmit` from `ui/`.
5. **Reuse existing primitives**: `SidebarCollapseToggle`, `SidebarSection`, `SidebarProjectsByType` (modify, don't fork). `useSidebar()` context already manages `collapsed`/`isMobile`/`sidebarOpen` — don't introduce new state.
6. **Preserve mobile behavior.** Mobile drawer (slide-over via `Layout.tsx` line 222–231) keeps working. External collapse toggle is hidden when `isMobile` (parity with `LobbySidebar`'s `drawer` prop).
7. **Preserve URL contract.** Every existing route the sidebar navigates to (`/home`, `/inbox`, `/commander`, `/discussions`, `/issues`, `/agents/all`, `/routines`, `/workspaces`, `/projects/:ref/issues`, `/objectives`, `/memory`, `/org`, `/skills`, `/budget`, `/settings`, `/plugins/:id`) must still work. Only Marketplace (`/marketplace`) and Updates (`/marketplace-updates`) are removed from the in-company sidebar — those routes remain reachable via the lobby sidebar (Phase A) and the `Marketplace` page's tab bar respectively.
8. **No backend or API client changes.** No Drizzle schema, no service, no route handler is touched.
9. **Decision A scope.** "Drop entity-color icons" applies to system nav rows (Discussions, Tasks, Agents, Memory). It does **not** apply to user-created entities (Departments, Projects) — those keep color-as-identity (the entire reason this overhaul kept colored squares for departments and tinted Rockets for projects).

---

## Task 1: `Sidebar.tsx` structural rewrite

**Files:**
- Modify: `ui/src/components/Sidebar.tsx`
- Modify: `ui/src/components/Layout.tsx`
- Create: `ui/src/__tests__/Sidebar.test.tsx`

This task does the structural changes only: widths, header, external toggle wiring, removal of dead surfaces (Marketplace, Updates, UserMenu, entityColor props on system nav), hidden scrollbar. Active-state visual pattern is **not** changed in this task — that comes in Task 2 (modifying `SidebarNavItem`).

- [ ] **Step 1: Create the failing test in `ui/src/__tests__/Sidebar.test.tsx`**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Sidebar } from "@/components/Sidebar";
import { SidebarProvider } from "@/context/SidebarContext";
import { CompanyProvider } from "@/context/CompanyContext";
import { DialogProvider } from "@/context/DialogContext";

// Mock APIs the sidebar pulls from
vi.mock("@/api/sidebarBadges", () => ({
  sidebarBadgesApi: {
    get: vi.fn().mockResolvedValue({ inbox: 0, pendingDiscussions: 0, failedRuns: 0 }),
  },
}));
vi.mock("@/api/plugins", () => ({
  pluginsApi: { listUiContributions: vi.fn().mockResolvedValue([]) },
}));
vi.mock("@/api/projects", () => ({
  projectsApi: {
    list: vi.fn().mockResolvedValue([
      { id: "p1", name: "Q4 launch", type: "project", color: "#10b981", archivedAt: null, sortOrder: 0 },
      { id: "d1", name: "Engineering", type: "department", color: "#06b6d4", archivedAt: null, sortOrder: 0 },
    ]),
  },
}));
vi.mock("@/hooks/useLiveAgentCount", () => ({
  useLiveAgentCount: () => 0,
}));
vi.mock("@/hooks/usePendingUpdates", () => ({
  usePendingUpdates: () => ({ data: [] }),
}));
vi.mock("@/components/UserMenu", () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));
vi.mock("@/context/CompanyContext", async () => {
  return {
    CompanyProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useCompany: () => ({
      selectedCompany: { id: "c1", name: "Phase4 Test Co", issuePrefix: "P4", brandColor: "#7c3aed" },
      selectedCompanyId: "c1",
    }),
  };
});

function renderSidebar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/P4/home"]}>
        <DialogProvider>
          <SidebarProvider>
            <Sidebar />
          </SidebarProvider>
        </DialogProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // Force desktop dimensions for these tests
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1280 });
  window.dispatchEvent(new Event("resize"));
});

describe("Sidebar — Phase E chrome", () => {
  it("does not render Marketplace nav item", () => {
    renderSidebar();
    expect(screen.queryByText("Marketplace")).toBeNull();
  });

  it("does not render Updates nav item", () => {
    renderSidebar();
    expect(screen.queryByText(/^Updates/)).toBeNull();
  });

  it("does not render bottom UserMenu", () => {
    renderSidebar();
    expect(screen.queryByTestId("user-menu")).toBeNull();
  });

  it("renders the external SidebarCollapseToggle on desktop", () => {
    renderSidebar();
    expect(screen.getByLabelText(/collapse sidebar/i)).toBeInTheDocument();
  });

  it("header company-name link navigates to lobby (href='/' )", () => {
    renderSidebar();
    const link = screen.getByTitle(/back to all companies/i);
    expect(link).toHaveAttribute("href", "/");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm vitest run src/__tests__/Sidebar.test.tsx
```

Expected: tests "does not render Marketplace nav item", "does not render Updates nav item", and "does not render bottom UserMenu" all FAIL because the current `Sidebar.tsx` renders all three. The collapse-toggle test will also FAIL because the current sidebar uses an internal `ChevronsLeft` button, not the external `SidebarCollapseToggle`. The href test should pass already (current header already uses `href="/"` per `Sidebar.tsx:110`).

- [ ] **Step 3: Update `Sidebar.tsx` — drop Marketplace, Updates, UserMenu, entityColor; resize widths; rewire header; add external toggle**

Replace the entire body of `ui/src/components/Sidebar.tsx` with the structure below. Notes:
- New imports: drop `Store`, `ArrowUpCircle`, `ChevronsLeft`, `Tooltip`/`TooltipContent`/`TooltipTrigger`, `Button`, `UserMenu`, `usePendingUpdates`. Keep `useNavigate`, all section icons, `useQuery`, `useCompany`, `useSidebar`, `cn`, `pluginsApi`, `sidebarBadgesApi`, `useLiveAgentCount`, `BudgetSidebarMarker`, `SidebarSection`, `SidebarNavItem`, `SidebarProjectsByType`.
- Add: `import { SidebarCollapseToggle } from "./SidebarCollapseToggle";`.

```tsx
import {
  Inbox,
  CircleDot,
  Home,
  Users,
  Settings,
  Brain,
  Compass,
  Bot,
  MessageSquare,
  Boxes,
  Repeat,
  Shield,
  Puzzle,
  DollarSign,
  FolderGit2,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarProjectsByType } from "./SidebarProjectsByType";
import { SidebarCollapseToggle } from "./SidebarCollapseToggle";
import { BudgetSidebarMarker } from "./finance/BudgetSidebarMarker";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { sidebarBadgesApi } from "../api/sidebarBadges";
import { pluginsApi } from "../api/plugins";
import { queryKeys } from "../lib/queryKeys";
import { useLiveAgentCount } from "../hooks/useLiveAgentCount";
import { cn } from "@/lib/utils";

export function Sidebar() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { collapsed, toggleCollapse, isMobile } = useSidebar();
  const navigate = useNavigate();
  const { data: sidebarBadges } = useQuery({
    queryKey: queryKeys.sidebarBadges(selectedCompanyId!),
    queryFn: () => sidebarBadgesApi.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const liveRunCount = useLiveAgentCount();
  const { data: pluginContributions } = useQuery({
    queryKey: queryKeys.plugins.uiContributions,
    queryFn: () => pluginsApi.listUiContributions(),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });
  const pluginsWithPages = (pluginContributions ?? []).filter(
    (c) => c.slots.some((s) => s.type === "page"),
  );

  const sidebarWidth = collapsed ? 56 : 220;

  return (
    <>
      <aside
        data-collapsed={collapsed}
        className={cn(
          "h-full min-h-0 flex flex-col border-r border-border bg-background transition-[width] duration-180",
          collapsed ? "w-[56px]" : "w-[220px]",
        )}
      >
        {/* Header — h-14, logo + company-name (click → lobby). No internal collapse toggle. */}
        <div
          className={cn(
            "flex items-center shrink-0 h-14 border-b border-border",
            collapsed ? "justify-center px-0" : "gap-2 px-3",
          )}
        >
          {collapsed ? (
            <a
              href="/"
              onClick={(e) => { e.preventDefault(); navigate("/"); }}
              title="Back to all companies"
              className="flex items-center justify-center size-8 rounded-md hover:bg-accent/50 transition-colors"
            >
              {selectedCompany?.logoAssetId ? (
                <img
                  src={`/api/assets/${selectedCompany.logoAssetId}/content`}
                  alt={selectedCompany.name}
                  className="size-6 rounded object-cover"
                />
              ) : selectedCompany?.brandColor ? (
                <div className="size-5 rounded shrink-0" style={{ backgroundColor: selectedCompany.brandColor }} />
              ) : (
                <div className="size-5 rounded bg-muted shrink-0" />
              )}
            </a>
          ) : (
            <>
              {selectedCompany?.logoAssetId ? (
                <img
                  src={`/api/assets/${selectedCompany.logoAssetId}/content`}
                  alt={selectedCompany.name}
                  className="size-5 rounded object-cover shrink-0"
                />
              ) : selectedCompany?.brandColor ? (
                <div className="size-5 rounded shrink-0" style={{ backgroundColor: selectedCompany.brandColor }} />
              ) : null}
              <a
                href="/"
                onClick={(e) => { e.preventDefault(); navigate("/"); }}
                className="flex-1 text-sm font-semibold text-foreground truncate hover:text-foreground/80 transition-colors"
                title="Back to all companies"
              >
                {selectedCompany?.name ?? "Select company"}
              </a>
            </>
          )}
        </div>

        {/* Nav — hidden scrollbar */}
        <nav
          className={cn(
            "flex-1 min-h-0 overflow-y-auto flex flex-col gap-4 py-2",
            "[&::-webkit-scrollbar]:hidden [scrollbar-width:none]",
            collapsed ? "px-0 items-center" : "px-3",
          )}
        >
          {/* Top nav: Home + Inbox + Commander */}
          <div className={cn("flex flex-col gap-0.5", collapsed && "w-full items-center")}>
            <SidebarNavItem to="/home" label="Home" icon={Home} liveCount={liveRunCount} collapsed={collapsed} />
            <SidebarNavItem
              to="/inbox"
              label="Inbox"
              icon={Inbox}
              badge={sidebarBadges?.inbox}
              badgeTone={sidebarBadges?.failedRuns ? "danger" : "default"}
              alert={(sidebarBadges?.failedRuns ?? 0) > 0}
              collapsed={collapsed}
            />
            <SidebarNavItem to="/commander" label="Commander" icon={Shield} collapsed={collapsed} />
          </div>

          {/* WORK section — entityColor props removed (Decision A) */}
          <SidebarSection label="Work" collapsed={collapsed}>
            <SidebarNavItem to="/discussions" label="Discussions" icon={MessageSquare} badge={sidebarBadges?.pendingDiscussions} collapsed={collapsed} />
            <SidebarNavItem to="/issues" label="Tasks" icon={CircleDot} collapsed={collapsed} />
            <SidebarNavItem to="/agents/all" label="Agents" icon={Bot} collapsed={collapsed} />
            <SidebarNavItem to="/routines" label="Routines" icon={Repeat} collapsed={collapsed} />
            <SidebarNavItem to="/workspaces" label="Workspaces" icon={FolderGit2} collapsed={collapsed} />
          </SidebarSection>

          {/* DEPARTMENTS — colored square (Pattern A, unchanged) */}
          <SidebarProjectsByType type="department" label="Departments" collapsed={collapsed} />

          {/* PROJECTS — Rocket tinted in entity color (Task 3) */}
          <SidebarProjectsByType type="project" label="Projects" collapsed={collapsed} />

          {/* COMPANY section — entityColor on Memory removed (Decision A) */}
          <SidebarSection label="Company" collapsed={collapsed}>
            <SidebarNavItem to="/objectives" label="Objectives" icon={Compass} collapsed={collapsed} />
            <SidebarNavItem to="/memory" label="Memory" icon={Brain} collapsed={collapsed} />
            <SidebarNavItem to="/org" label="Team" icon={Users} collapsed={collapsed} />
            <SidebarNavItem to="/skills" label="Skills" icon={Boxes} collapsed={collapsed} />
            <SidebarNavItem to="/budget" label="Budget" icon={DollarSign} collapsed={collapsed} />
            <BudgetSidebarMarker collapsed={collapsed} />
            <SidebarNavItem to="/settings" label="Settings" icon={Settings} collapsed={collapsed} />
          </SidebarSection>

          {/* PLUGINS — conditional, unchanged */}
          {pluginsWithPages.length > 0 && (
            <SidebarSection label="Plugins" collapsed={collapsed}>
              {pluginsWithPages.map((contribution) => (
                <SidebarNavItem
                  key={contribution.pluginId}
                  to={`/plugins/${contribution.pluginId}`}
                  label={contribution.displayName}
                  icon={Puzzle}
                  collapsed={collapsed}
                />
              ))}
            </SidebarSection>
          )}
        </nav>

        {/* No bottom UserMenu (Phase E — moved to lobby only) */}
      </aside>

      {/* External collapse toggle — hidden in mobile drawer mode (parity with LobbySidebar) */}
      {!isMobile && (
        <SidebarCollapseToggle
          collapsed={collapsed}
          onToggle={toggleCollapse}
          sidebarWidth={sidebarWidth}
          className="hidden md:inline-flex"
        />
      )}
    </>
  );
}
```

- [ ] **Step 4: Update `Layout.tsx` — drop the outer width-controlling wrapper**

In `ui/src/components/Layout.tsx`, replace lines 232–245 (the desktop branch of the sidebar render):

```tsx
      ) : (
        <div className="flex flex-col shrink-0 h-full">
          <div className="flex flex-1 min-h-0">
            <div
              className={cn(
                "overflow-hidden transition-[width] duration-100 ease-out",
                collapsed ? "w-12" : "w-60"
              )}
            >
              <Sidebar />
            </div>
          </div>
        </div>
      )}
```

…with:

```tsx
      ) : (
        <div className="relative flex flex-col shrink-0 h-full">
          <div className="flex flex-1 min-h-0">
            <Sidebar />
          </div>
        </div>
      )}
```

The `relative` is the positioning context for `SidebarCollapseToggle`'s `position: absolute`. The width control moves into `Sidebar.tsx` (set on the `<aside>` directly). The width-transition is preserved on the aside (`transition-[width] duration-180`).

- [ ] **Step 5: Run the failing test from Step 1**

```
pnpm vitest run src/__tests__/Sidebar.test.tsx
```

Expected: All 5 tests now PASS.

- [ ] **Step 6: Run the full UI test suite to catch regressions**

```
pnpm vitest run --dir src/__tests__
```

Expected: All tests pass. If any existing test fails because it expected Marketplace/Updates/UserMenu in the in-company sidebar, update those expectations (but check first whether they're testing `LobbySidebar` instead — if so, no change needed).

- [ ] **Step 7: Typecheck**

```
pnpm exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add ui/src/components/Sidebar.tsx ui/src/components/Layout.tsx ui/src/__tests__/Sidebar.test.tsx
git commit -m "refactor(ui): in-company sidebar Phase E structural rewrite

220px expanded / 56px collapsed widths (matches LobbyShell). External
SidebarCollapseToggle on the boundary, top-aligned with header (h-14,
logo + company-name → lobby). Hidden scrollbar on nav. Removes
Marketplace, Updates, and bottom UserMenu — all live in the lobby
sidebar now per Phase A. Drops entityColor props on system nav rows
(Decision A — system-nav identity comes from icon shape, not color)."
```

---

## Task 2: `SidebarNavItem` active-state pattern + `entityColor` prop removal

**Files:**
- Modify: `ui/src/components/SidebarNavItem.tsx`
- Modify: `ui/src/__tests__/Sidebar.test.tsx` (add active-state assertion)

This task swaps the visual pattern for the active row to match `LobbyNavRow` (design-system §8.2.1): a `bg-brand/[0.08]` row tint, `text-[hsl(15_60%_75%)]` foreground, and a 5px brand-red glow dot positioned at row-right (expanded) or icon-top-right (collapsed). Also removes the `entityColor` prop entirely (no longer used after Task 1's call-site cleanup).

- [ ] **Step 1: Add the failing assertion to `Sidebar.test.tsx`**

Append a new test inside the existing `describe("Sidebar — Phase E chrome", ...)` block:

```tsx
  it("active row uses brand-red glow dot pattern (no bg-accent)", async () => {
    renderSidebar();
    // /P4/home → Home is the active route
    const homeLink = await screen.findByRole("link", { name: /^Home/ });
    expect(homeLink.className).toContain("bg-brand/[0.08]");
    expect(homeLink.className).not.toContain("bg-accent");
  });
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm vitest run src/__tests__/Sidebar.test.tsx -t "brand-red glow dot"
```

Expected: FAIL — current `SidebarNavItem` uses `bg-accent text-foreground` (lines 60–62 and 107–109).

- [ ] **Step 3: Rewrite `SidebarNavItem.tsx`**

Replace the entire body of `ui/src/components/SidebarNavItem.tsx`. Drop the `entityColor` prop from the interface and from both branches. Apply the new active-state classes. Add the brand-red glow dot pseudo-element (via inline span — NavLink's render-prop pattern doesn't allow `::after` wraps cleanly when the className is a function, so use a span like `LobbyNavRow` does).

```tsx
import { Link, NavLink, useLocation } from "@/lib/router";
import { cn } from "../lib/utils";
import { useSidebar } from "../context/SidebarContext";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCompany } from "../context/CompanyContext";
import type { LucideIcon } from "lucide-react";

interface SidebarNavItemProps {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  className?: string;
  badge?: number;
  badgeTone?: "default" | "danger";
  alert?: boolean;
  liveCount?: number;
  collapsed?: boolean;
  /** Skip company-prefix injection — use `to` as the absolute path. */
  noPrefix?: boolean;
}

const ACTIVE_GLOW_DOT = (
  <span
    aria-hidden
    className="pointer-events-none absolute size-[5px] rounded-full bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]"
  />
);

export function SidebarNavItem({
  to,
  label,
  icon: Icon,
  end,
  className,
  badge,
  badgeTone = "default",
  alert = false,
  liveCount,
  collapsed,
  noPrefix = false,
}: SidebarNavItemProps) {
  const { isMobile, setSidebarOpen } = useSidebar();
  const { selectedCompany } = useCompany();
  const prefix = selectedCompany?.issuePrefix ?? "";
  const fullPath = noPrefix ? to : `/${prefix}${to}`;
  const location = useLocation();
  const isActive = end
    ? location.pathname === fullPath
    : location.pathname.startsWith(fullPath);

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to={fullPath}
            onClick={() => { if (isMobile) setSidebarOpen(false); }}
            className={cn(
              "relative flex items-center justify-center size-9 rounded-md transition-colors mx-auto",
              isActive
                ? "bg-brand/[0.08] text-[hsl(15_60%_75%)]"
                : "text-foreground/[0.78] hover:bg-white/[0.04] hover:text-foreground",
              className,
            )}
          >
            <span className="relative shrink-0">
              <Icon className="size-4 transition-colors duration-150" />
              {alert && (
                <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-red-500 shadow-[0_0_0_2px_hsl(var(--background))]" />
              )}
              {!alert && badge != null && badge > 0 && (
                <span
                  className={cn(
                    "absolute -right-0.5 -top-0.5 size-2 rounded-full shadow-[0_0_0_2px_hsl(var(--background))]",
                    badgeTone === "danger" ? "bg-red-500" : "bg-primary",
                  )}
                />
              )}
              {!alert && (badge == null || badge <= 0) && liveCount != null && liveCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-blue-500 shadow-[0_0_0_2px_hsl(var(--background))]" />
              )}
            </span>
            {isActive && (
              <span
                aria-hidden
                className="pointer-events-none absolute right-1.5 top-1.5 size-[5px] rounded-full bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]"
              />
            )}
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {label}
          {badge != null && badge > 0 && ` (${badge})`}
          {liveCount != null && liveCount > 0 && ` - ${liveCount} live`}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <NavLink
      to={noPrefix ? fullPath : to}
      end={end}
      onClick={() => { if (isMobile) setSidebarOpen(false); }}
      className={({ isActive }) =>
        cn(
          "relative flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] font-medium transition-colors",
          isActive
            ? "bg-brand/[0.08] text-[hsl(15_60%_75%)]"
            : "text-foreground/[0.78] hover:bg-white/[0.04] hover:text-foreground",
          className,
        )
      }
    >
      {({ isActive }: { isActive: boolean }) => (
        <>
          <span className="relative shrink-0">
            <Icon className="size-4 transition-colors duration-150" />
            {alert && (
              <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-red-500 shadow-[0_0_0_2px_hsl(var(--background))]" />
            )}
          </span>
          <span className="flex-1 truncate">{label}</span>
          {liveCount != null && liveCount > 0 && (
            <span className="ml-auto flex items-center gap-1.5">
              <span className="relative flex size-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full size-2 bg-blue-500" />
              </span>
              <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">{liveCount} live</span>
            </span>
          )}
          {badge != null && badge > 0 && (
            <span
              className={cn(
                "ml-auto rounded-full px-1.5 py-0.5 text-xs leading-none",
                badgeTone === "danger"
                  ? "bg-red-600/90 text-red-50"
                  : "bg-primary text-primary-foreground",
              )}
            >
              {badge}
            </span>
          )}
          {isActive && (
            <span
              aria-hidden
              className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 size-[5px] rounded-full bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]"
            />
          )}
        </>
      )}
    </NavLink>
  );
}
```

- [ ] **Step 4: Run the active-state test**

```
pnpm vitest run src/__tests__/Sidebar.test.tsx
```

Expected: all 6 tests pass.

- [ ] **Step 5: Run the broader UI suite**

```
pnpm vitest run --dir src/__tests__
```

Expected: clean. The drop of `entityColor` from `SidebarNavItem` is safe — Task 1 already removed all call-site usages from `Sidebar.tsx`. If any other component passes `entityColor` to `SidebarNavItem`, TypeScript will catch it in Step 6.

- [ ] **Step 6: Typecheck**

```
pnpm exec tsc --noEmit
```

Expected: clean. If a type error surfaces, it means another component (not `Sidebar.tsx`) was passing `entityColor`. Search the codebase (`grep -r "entityColor" ui/src`) and remove the prop pass at each site (it's now a no-op).

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/SidebarNavItem.tsx ui/src/__tests__/Sidebar.test.tsx
git commit -m "refactor(ui): SidebarNavItem brand-red glow dot active state

Replaces the bg-accent active treatment with bg-brand/[0.08] row tint
+ brand-red glow dot at row-right (expanded) / icon-top-right
(collapsed), matching LobbyNavRow per design-system §8.2.1. Drops
the entityColor prop entirely (Decision A — system-nav identity
comes from icon shape, not color). Rounded row corners now applied."
```

---

## Task 3: `SidebarProjectsByType` — `Rocket` icon for projects

**Files:**
- Modify: `ui/src/components/SidebarProjectsByType.tsx`
- Modify: `ui/src/__tests__/Sidebar.test.tsx` (add Rocket-on-projects assertion)

Switches the project visual from a colored square to a Lucide `Rocket` icon tinted in `project.color`. Departments are unchanged (still a colored square — Pattern A baseline). Active-state classes upgraded to match Task 2's pattern (consistent throughout the sidebar). Both expanded and collapsed branches.

- [ ] **Step 1: Add the failing assertion to `Sidebar.test.tsx`**

Append inside the existing `describe`:

```tsx
  it("renders project rows with a Rocket icon tinted in project.color", async () => {
    renderSidebar();
    const projectLink = await screen.findByRole("link", { name: /Q4 launch/ });
    // The project icon is an SVG; lucide-react renders <svg class="lucide lucide-rocket">.
    const rocketSvg = projectLink.querySelector("svg.lucide-rocket");
    expect(rocketSvg).not.toBeNull();
    expect(rocketSvg).toHaveAttribute("style", expect.stringContaining("color"));
  });

  it("renders department rows with a colored square (no Rocket)", async () => {
    renderSidebar();
    const deptLink = await screen.findByRole("link", { name: /Engineering/ });
    expect(deptLink.querySelector("svg.lucide-rocket")).toBeNull();
    // The colored square is a 14×14 span with inline backgroundColor
    const square = deptLink.querySelector("span[style*='background']");
    expect(square).not.toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```
pnpm vitest run src/__tests__/Sidebar.test.tsx -t "Rocket"
```

Expected: FAIL — current `SidebarProjectsByType` renders a colored square for **both** types.

- [ ] **Step 3: Modify `SidebarProjectsByType.tsx`**

Add `Rocket` to the lucide imports at line 4:

```tsx
import { ChevronRight, Plus, Rocket } from "lucide-react";
```

Replace the `SortableProjectItem` component body (lines 30–84). Branch on `project.type`:

```tsx
function SortableProjectItem({
  activeProjectRef,
  isMobile,
  project,
  setSidebarOpen,
}: {
  activeProjectRef: string | null;
  isMobile: boolean;
  project: Project;
  setSidebarOpen: (open: boolean) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id });

  const routeRef = projectRouteRef(project);
  const isActive = activeProjectRef === routeRef || activeProjectRef === project.id;
  const tint = project.color ?? "#6366f1";

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 10 : undefined,
      }}
      className={cn(isDragging && "opacity-80")}
      {...attributes}
      {...listeners}
    >
      <NavLink
        to={`/projects/${routeRef}/issues`}
        onClick={() => { if (isMobile) setSidebarOpen(false); }}
        className={cn(
          "relative flex items-center gap-2.5 px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors",
          isActive
            ? "bg-brand/[0.08] text-[hsl(15_60%_75%)]"
            : "text-foreground/[0.78] hover:bg-white/[0.04] hover:text-foreground",
        )}
      >
        {project.type === "project" ? (
          <Rocket className="size-4 shrink-0" style={{ color: tint }} />
        ) : (
          <span className="shrink-0 size-3.5 rounded-sm" style={{ backgroundColor: tint }} />
        )}
        <span className="flex-1 truncate">{project.name}</span>
        {isActive && (
          <span
            aria-hidden
            className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 size-[5px] rounded-full bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]"
          />
        )}
      </NavLink>
    </div>
  );
}
```

Apply the same `Rocket`-vs-square branching to the **collapsed** rendering at lines 141–174. Replace lines 162–165 (the `<span className="h-3.5 w-3.5 rounded-sm shrink-0" ...>`) with:

```tsx
                  {project.type === "project" ? (
                    <Rocket className="size-4 shrink-0" style={{ color: project.color ?? "#6366f1" }} />
                  ) : (
                    <span
                      className="size-3.5 rounded-sm shrink-0"
                      style={{ backgroundColor: project.color ?? "#6366f1" }}
                    />
                  )}
```

And update the collapsed-mode active-state classes at lines 155–160 to match the new pattern:

```tsx
                    className={cn(
                      "relative flex items-center justify-center size-9 rounded-md transition-colors",
                      isActive
                        ? "bg-brand/[0.08]"
                        : "hover:bg-white/[0.04]",
                    )}
```

Add the brand-red glow dot inside the collapsed `NavLink` (after the icon span):

```tsx
                    {isActive && (
                      <span
                        aria-hidden
                        className="pointer-events-none absolute right-1.5 top-1.5 size-[5px] rounded-full bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]"
                      />
                    )}
```

- [ ] **Step 4: Run the new tests**

```
pnpm vitest run src/__tests__/Sidebar.test.tsx
```

Expected: all 8 tests pass.

- [ ] **Step 5: Run the broader UI suite**

```
pnpm vitest run --dir src/__tests__
```

Expected: clean. Watch for `useSidebarOrder.test.tsx` — it should still pass unchanged (it tests the hook, not the rendering).

- [ ] **Step 6: Typecheck**

```
pnpm exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 7: Visual smoke check**

Start the dev server and click through:

```
pnpm --filter ui dev
```

In a browser:
1. Navigate to a company (any).
2. Verify the sidebar header shows logo + name; click name → returns to lobby.
3. Verify external collapse toggle on the right edge of the sidebar; click it → sidebar collapses to 56px.
4. Verify hidden scrollbar (no visible track on the right edge of the nav).
5. Verify a project row shows a colored Rocket; verify a department row shows a colored square.
6. Verify the active row has a brand-red glow dot at the right edge (expanded) or top-right of the icon (collapsed).
7. Verify there's no `Marketplace`, `Updates`, or `UserMenu` row.
8. Mobile: resize the browser to <768px → confirm the slide-over still works and the external toggle is hidden.

- [ ] **Step 8: Add the changeset**

Create `.changeset/in-company-sidebar-phase-e.md`:

```md
---
"@armyofagents/ui": patch
---

In-company sidebar redesign (Phase E): apply locked Phase A–D chrome
patterns (220px/56px widths, external collapse toggle, brand-red glow
dot active state, hidden scrollbar). Marketplace, Updates, and the
account avatar move to the lobby sidebar only. Department rows keep
their colored-square treatment; project rows now use a Lucide Rocket
icon tinted in the project's color.
```

- [ ] **Step 9: Commit**

```bash
git add ui/src/components/SidebarProjectsByType.tsx ui/src/__tests__/Sidebar.test.tsx .changeset/in-company-sidebar-phase-e.md
git commit -m "feat(ui): Rocket icons for project rows in in-company sidebar

Project rows now render a Lucide Rocket icon tinted in project.color
(parity with the Phase E Variant L lock). Departments unchanged —
they keep the colored 14px rounded square (Pattern A). Both expanded
and collapsed renderings updated. Active-state pattern brought in
line with the rest of the sidebar (brand-red glow dot)."
```

---

## Self-Review

**1. Spec coverage:**

| Locked decision (mockup verdict) | Task that implements it |
|---|---|
| 220px expanded / 56px collapsed | Task 1 (Step 3, `<aside>` className) |
| External collapse toggle on boundary | Task 1 (Step 3, `<SidebarCollapseToggle>` after aside) + Step 4 (`Layout.tsx` wrapper drop) |
| Brand-red glow dot active state | Task 2 (Step 3, both expanded + collapsed branches) + Task 3 (Step 3, project rows) |
| Rounded row corners | Task 2 (Step 3, `rounded-md` in className) |
| Entity-color icons dropped | Task 1 (Step 3, no `entityColor=` prop passes) + Task 2 (Step 3, prop removed from interface) |
| No "+ New" button | N/A (current sidebar already has none) |
| Marketplace removed | Task 1 (Step 3, no `Store` import, no row) |
| Updates removed | Task 1 (Step 3, no `ArrowUpCircle` import, no `usePendingUpdates`) |
| Account avatar removed | Task 1 (Step 3, no `UserMenu` import, no bottom row) |
| Hidden scrollbar | Task 1 (Step 3, `[&::-webkit-scrollbar]:hidden [scrollbar-width:none]`) |
| Header h-14, logo + name → lobby | Task 1 (Step 3, header section) |
| Department = colored square | Task 3 (Step 3, branch on `project.type`) |
| Project = Rocket tinted in color | Task 3 (Step 3, branch on `project.type`) |

All 13 locked decisions are covered.

**2. Placeholder scan:** No `TBD`, `TODO`, `implement later`, or generic "add validation" steps. Every code block is concrete. Every command is exact. The mobile drawer behavior is preserved verbatim by `useSidebar().isMobile` gating the toggle render.

**3. Type consistency:**
- `SidebarNavItem` props: `entityColor` removed in Task 2; Task 1 removes all call-site passes — no orphaned references possible.
- `Project.type` is `"department" | "project"` (already in `@armyofagents/shared`) — Task 3's branch is exhaustive.
- `SidebarCollapseToggle` props: `collapsed`, `onToggle`, `sidebarWidth`, `className` — all used correctly in Task 1's call.
- `useSidebar()` returns `isMobile`, `collapsed`, `toggleCollapse` — all consumed correctly.

**4. Risks called out:**
- **Layout.tsx wrapper drop (Task 1 Step 4):** the `overflow-hidden` removal is required for the toggle to extend past the sidebar boundary. The width-transition is preserved on the `<aside>` itself (`transition-[width] duration-180`). The mobile slide-over branch (lines 222–231) is **untouched** — only the desktop branch changes.
- **`useLocation` exact-match for active state (`SidebarNavItem`):** the existing manual `isActive` calculation in collapsed mode preserves the prefix-match behavior (`location.pathname.startsWith(fullPath)`) so deep child routes still highlight the parent row.
- **Project drag-and-drop:** `useSortable` from `@dnd-kit/sortable` wraps the `NavLink`; the `Rocket` swap is inside the `NavLink` so drag handles aren't affected.

---

## Execution

Plan complete. Per superpowers:writing-plans:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review (spec compliance → code quality) between tasks. Best when tasks are independent (they are here).

**2. Inline Execution** — execute tasks in this session via superpowers:executing-plans. Batch with checkpoints for review.

Tell me which to use, and I'll dispatch.
