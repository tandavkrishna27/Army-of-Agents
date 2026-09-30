# Per-Company Settings Redesign — Cleanup Implementation Plan (Phase F polish)

> **For agentic workers:** REQUIRED SUB-SKILL: Use **superpowers:subagent-driven-development** (recommended) or **superpowers:executing-plans** to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the Phase F per-company Settings redesign (already merged via `86cc8b2..cc52cd8`) based on the cumulative-review findings. Three issues from the final review (I1: missing collapse toggle on the SecondarySidebar; I2: double-padding gap around the secondary aside; redundant "Settings" header inside the aside) plus a deferred user request (GitHub PAT card needs a UI surface — Phase F dropped it). Skip I3 (section-aware breadcrumbs) because Phase G will remove the BreadcrumbBar entirely.

**Architecture:** UI-only polish on top of Phase F. No schema, no API, no routing changes. Modifies the bespoke `<aside>` in `SettingsLayout.tsx` (add collapse state + toggle, drop redundant "Settings" header), updates `Layout.tsx` to skip `<main>` padding for the `/settings` route (parallel to the existing `/workspaces/` exception), creates a new `GitHubSection.tsx` that wraps the existing `GitHubIntegrationCard.tsx` (preserved in Phase F for this purpose), wires it into `SETTINGS_SECTIONS` in Operations group with an amber `→ migrating to plugins` pill marker. Adds 2 small tests for the `/settings/commander` and `/settings/internal-agent` redirect chain (M1 from cumulative review).

**Tech Stack:** React 18 + Vite + Tailwind. lucide-react (`Github`, `PanelLeftClose`, `PanelLeftOpen`). Existing primitives — no new components. localStorage for collapse persistence. vitest + @testing-library/react.

**Spec:** Cumulative review from 2026-05-09 (Task 7 in `2026-05-09-per-company-settings-redesign.md`'s "Final cumulative code review"). User's explicit calls: (a) keep the BreadcrumbBar global removal as a separate Phase G effort; (b) GitHub PAT placement → option (c) own section in Operations group with amber pill; (c) one cleanup commit covers I1 + I2 + GitHub section + drop SecondarySidebar header.

**Branch:** `feat/ui-overhaul`. Base SHA: `cc52cd8` (Phase F final).

---

## Files

| Action | Path | What changes |
|--------|------|--------------|
| Modify | `ui/src/components/settings/SettingsLayout.tsx` | Add `collapsed` state (persisted to `localStorage["aoa.settings-secondary-collapsed"]`); width transitions (200px ↔ 48px); toggle button on the aside/main border using existing `SidebarCollapseToggle`; hide labels + group labels in collapsed mode; show tooltips on icon-hover via `<Tooltip>`; **drop the `h-14 px-4` "Settings" header div (lines 60-62) entirely** — the breadcrumb bar already shows "Settings" and the aside now starts straight into nav |
| Modify | `ui/src/components/Layout.tsx` | Update line 254's no-padding-on-main exclusion to also cover `/settings`. Pattern parity with existing `/workspaces/` exclusion |
| Create | `ui/src/components/settings/sections/GitHubSection.tsx` | Thin wrapper that renders the existing `GitHubIntegrationCard` with section-header chrome + amber `pill` marker indicating "migrating to plugins". Section header: eyebrow `"Settings · Operations"` + h2 `"GitHub"` + description |
| Modify | `ui/src/pages/SettingsPage.tsx` | Add `"github"` to the `SettingsSectionId` union, `VALID_SECTIONS` array, and switch case → `<GitHubSection />` |
| Modify | `ui/src/components/settings/SettingsLayout.tsx` (same file as I1) | Add `{ id: "github", label: "GitHub", icon: Github, tone: "transitional" }` to `SETTINGS_SECTIONS` Operations group items. Add a new tone variant for the amber pill marker (or render the marker inline in the nav button) |
| Modify | `ui/src/__tests__/SettingsPage-redesign.test.tsx` | Add 3 tests: (a) GitHub section renders with the PAT card; (b) `/settings/commander` redirects to `?tab=commander`; (c) `/settings/internal-agent` redirects to `?tab=commander`. Update existing tests if they assert the now-removed "Settings" header text |

**Total:** 4 modified, 1 created.

---

## Verification rules (apply to every task)

1. **TDD order** — failing test first, see it fail with the right error, implement, see it pass, commit.
2. **Per-task scoped tests** before commit; broader UI suite (`pnpm vitest run --dir src/__tests__` from `ui/`) at end of each task.
3. **Conventional commits**: `feat(ui):`, `refactor(ui):`, `test(ui):`, `chore(ui):`.
4. **Typecheck after each task** — `pnpm exec tsc --noEmit` from `ui/`.
5. **Reuse existing primitives**: `SidebarCollapseToggle` (already used by `Sidebar.tsx`), `Tooltip` from `@/components/ui/tooltip`, the existing `GitHubIntegrationCard.tsx` (preserved file from Phase F). Don't recreate or fork.
6. **localStorage key** for the secondary collapse: `"aoa.settings-secondary-collapsed"`. Distinct from primary's `"aoa:sidebar-collapsed"` (already in use).
7. **Mobile drawer behavior preserved.** The collapse toggle is hidden on mobile (parity with the primary sidebar's external toggle).
8. **No schema/API/routing changes.** Pure UI polish.
9. **Don't touch `BreadcrumbBar.tsx`** — that's Phase G. The "Settings" header drop in Task 1 is in SettingsLayout's aside, NOT BreadcrumbBar.

---

## Task 1: SettingsLayout collapse toggle + drop redundant header + Layout padding skip

**Files:**
- Modify: `ui/src/components/settings/SettingsLayout.tsx`
- Modify: `ui/src/components/Layout.tsx`
- Modify: `ui/src/__tests__/SettingsPage-redesign.test.tsx`

This task delivers I1 + I2 + the redundant-header drop in one commit. The cleanup is tightly coupled — they all touch the visual chrome of the SecondarySidebar and adjacent layout.

### Step 1: Add the failing test in `SettingsPage-redesign.test.tsx`

Append three new tests inside the existing `describe("SettingsPage redesign — Phase F shell", ...)` block:

```tsx
  it("does NOT render the redundant 'Settings' header inside the secondary aside", async () => {
    renderSettings();
    // The aside should start straight into nav. The "Settings" h2 div was at h-14 px-4 with text-foreground class.
    // After the cleanup, no element should have role="presentation" with that exact "Settings" text inside the aside.
    // Simpler check: the aside's first child should be the nav (not a header div).
    // Use getAllByText since "Settings" still appears in the breadcrumb (top of page) — we just want to verify
    // it doesn't ALSO appear inside the secondary aside as a redundant header.
    // Instead, look for the aside element and verify its first child is the <nav>.
    const aside = document.querySelector("aside.w-\\[200px\\], aside.w-\\[48px\\]");
    expect(aside).not.toBeNull();
    const firstChild = aside!.firstElementChild;
    expect(firstChild?.tagName.toLowerCase()).toBe("nav");
  });

  it("renders the SecondarySidebar collapse toggle button", async () => {
    renderSettings();
    expect(await screen.findByLabelText(/collapse settings nav|expand settings nav/i)).toBeInTheDocument();
  });

  it("toggles the SecondarySidebar between expanded (200px) and collapsed (48px)", async () => {
    const user = userEvent.setup();
    renderSettings();
    const toggle = await screen.findByLabelText(/collapse settings nav/i);

    // Initially expanded — aside has w-[200px]
    let aside = document.querySelector("aside") as HTMLElement;
    expect(aside.className).toContain("w-[200px]");

    // Click toggle → collapsed
    await user.click(toggle);
    aside = document.querySelector("aside") as HTMLElement;
    expect(aside.className).toContain("w-[48px]");

    // Toggle now reads "Expand"
    expect(screen.getByLabelText(/expand settings nav/i)).toBeInTheDocument();
  });
```

You'll need `userEvent` imported at the top:

```tsx
import userEvent from "@testing-library/user-event";
```

### Step 2: Run test to verify it fails

```
pnpm vitest run src/__tests__/SettingsPage-redesign.test.tsx -t "redundant 'Settings' header|SecondarySidebar collapse toggle|toggles the SecondarySidebar"
```

(from the `ui/` directory)

Expected: 3 tests FAIL because (a) the aside's first child is the `h-14 px-4 "Settings"` header div, (b) no toggle button exists, (c) the aside is always at `w-[200px]`.

### Step 3: Replace `SettingsLayout.tsx`

Replace the entire body. Notes on the changes vs. current state:

- **Drop** the `h-14 px-4` "Settings" header div (current lines 60-62)
- **Add** `collapsed` state with localStorage persistence (key: `aoa.settings-secondary-collapsed`)
- **Add** width transition: `w-[200px]` ↔ `w-[48px]`
- **Add** `SidebarCollapseToggle` import and render (positioned via `sidebarWidth` prop relative to the parent)
- **Hide labels + group titles** when collapsed; show only icons + brand-red glow dot for active
- **Show Tooltip** on hover when collapsed (using the existing `Tooltip` from `@/components/ui/tooltip`)
- **Mobile pill row stays unchanged**

Use this exact body:

```tsx
import { useEffect, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { useSidebar } from "@/context/SidebarContext";
import { Building, Shield, KeyRound, DollarSign, Plug, Puzzle, Store, Archive, Github } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SidebarCollapseToggle } from "@/components/SidebarCollapseToggle";

const SECONDARY_COLLAPSED_KEY = "aoa.settings-secondary-collapsed";

export type SettingsSectionId =
  | "general" | "commander" | "llm" | "budget" | "mcp" | "github"
  | "plugins" | "marketplace" | "archive";

interface SettingsItem {
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
  tone?: "danger" | "transitional";
}

interface SettingsGroup {
  group: string;
  items: readonly SettingsItem[];
}

export const SETTINGS_SECTIONS: readonly SettingsGroup[] = [
  { group: "Company",    items: [
    { id: "general",     label: "General",            icon: Building },
  ]},
  { group: "Operations", items: [
    { id: "commander",   label: "Commander",          icon: Shield },
    { id: "llm",         label: "LLM providers",      icon: KeyRound },
    { id: "budget",      label: "Budget & caps",      icon: DollarSign },
    { id: "mcp",         label: "MCP API keys",       icon: Plug },
    { id: "github",      label: "GitHub",             icon: Github, tone: "transitional" },
  ]},
  { group: "Extensions", items: [
    { id: "plugins",     label: "Plugins",            icon: Puzzle },
    { id: "marketplace", label: "Marketplace prefs",  icon: Store },
  ]},
  { group: "Danger",     items: [
    { id: "archive",     label: "Archive company",    icon: Archive, tone: "danger" },
  ]},
];

interface SettingsLayoutProps {
  activeSection: SettingsSectionId;
  onSectionChange: (id: SettingsSectionId) => void;
  children: ReactNode;
}

export function SettingsLayout({ activeSection, onSectionChange, children }: SettingsLayoutProps) {
  const { setCollapsed: setPrimaryCollapsed, isMobile } = useSidebar();

  // Decision #98 — auto-collapse PRIMARY sidebar on entry to give SECONDARY the prominent role.
  useEffect(() => {
    if (!isMobile) setPrimaryCollapsed(true);
  }, [isMobile, setPrimaryCollapsed]);

  // Secondary sidebar collapse state, persisted to localStorage.
  const [secondaryCollapsed, setSecondaryCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SECONDARY_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const toggleSecondary = () => {
    setSecondaryCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(SECONDARY_COLLAPSED_KEY, String(next)); } catch { /* noop */ }
      return next;
    });
  };

  const secondaryWidth = secondaryCollapsed ? 48 : 200;

  return (
    <div className="relative flex h-full min-h-0 flex-col md:flex-row">
      {/* SecondarySidebar — desktop only. NO redundant "Settings" header. */}
      <aside
        className={cn(
          "hidden md:flex shrink-0 flex-col bg-card/30 border-r border-border transition-[width] duration-180",
          secondaryCollapsed ? "w-[48px]" : "w-[200px]",
        )}
      >
        <nav
          className={cn(
            "flex-1 overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none] py-3",
            secondaryCollapsed ? "px-1" : "px-2",
          )}
        >
          {SETTINGS_SECTIONS.map((group, gi) => (
            <div key={group.group} className={cn(gi > 0 && (secondaryCollapsed ? "mt-2 pt-2 border-t border-border-soft mx-1" : "mt-3"))}>
              {!secondaryCollapsed && (
                <div className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/60">
                  {group.group}
                </div>
              )}
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = activeSection === item.id;
                const isDanger = item.tone === "danger";
                const isTransitional = item.tone === "transitional";
                const button = (
                  <button
                    type="button"
                    onClick={() => onSectionChange(item.id)}
                    className={cn(
                      "relative w-full flex items-center rounded-md transition-colors",
                      secondaryCollapsed
                        ? "h-9 justify-center"
                        : "h-[30px] gap-2.5 px-2.5 text-[13px] font-medium",
                      active
                        ? "bg-brand/[0.08] text-[hsl(15_60%_75%)]"
                        : "text-foreground/[0.78] hover:bg-white/[0.04] hover:text-foreground",
                    )}
                  >
                    <Icon className={cn("size-4 shrink-0", isDanger && "text-red-400/80")} />
                    {!secondaryCollapsed && (
                      <>
                        <span className="flex-1 text-left truncate">{item.label}</span>
                        {isTransitional && (
                          <span className="ml-auto px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider rounded-sm bg-amber-500/15 text-amber-400/80 border border-amber-500/30">
                            →plugins
                          </span>
                        )}
                      </>
                    )}
                    {active && (
                      <span aria-hidden className={cn(
                        "pointer-events-none absolute size-[5px] rounded-full bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]",
                        secondaryCollapsed ? "right-1.5 top-1.5" : "right-2.5 top-1/2 -translate-y-1/2",
                      )} />
                    )}
                  </button>
                );
                if (!secondaryCollapsed) return <div key={item.id}>{button}</div>;
                return (
                  <Tooltip key={item.id}>
                    <TooltipTrigger asChild>{button}</TooltipTrigger>
                    <TooltipContent side="right" sideOffset={8}>
                      {item.label}
                      {isTransitional && " — migrating to plugins"}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>

      {/* External collapse toggle — hidden on mobile (parity with primary sidebar) */}
      {!isMobile && (
        <SidebarCollapseToggle
          collapsed={secondaryCollapsed}
          onToggle={toggleSecondary}
          sidebarWidth={secondaryWidth}
          className="hidden md:inline-flex"
          aria-label={secondaryCollapsed ? "Expand settings nav" : "Collapse settings nav"}
        />
      )}

      {/* Mobile sub-nav — horizontal scrollable pill row (unchanged from prior) */}
      <div className="md:hidden border-b border-border-soft py-2 px-3 flex gap-2 overflow-x-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        {SETTINGS_SECTIONS.flatMap((g) => g.items).map((item) => {
          const Icon = item.icon;
          const active = activeSection === item.id;
          const isDanger = item.tone === "danger";
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSectionChange(item.id)}
              className={cn(
                "shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] font-medium border whitespace-nowrap",
                active
                  ? "bg-brand/[0.12] border-brand/40 text-[hsl(15_60%_75%)]"
                  : "bg-card border-border text-muted-foreground",
                isDanger && !active && "text-red-400/80"
              )}
            >
              <Icon className="size-3.5" />
              {item.label}
            </button>
          );
        })}
      </div>

      {/* Main content panel */}
      <main className="flex-1 min-w-0 overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        {children}
      </main>
    </div>
  );
}
```

**Note on `SidebarCollapseToggle`'s `aria-label` prop:** verify by reading `ui/src/components/SidebarCollapseToggle.tsx` first. If the component doesn't accept `aria-label` as a prop, it sets its own based on `collapsed`. In that case, the existing aria-label probably reads "Collapse sidebar" / "Expand sidebar" — which the test's regex `/collapse settings nav|expand settings nav/i` would NOT match. Decide one of two fixes:
- (a) Update the test regex to match whatever the component sets (e.g. `/collapse sidebar|expand sidebar/i`). The tradeoff: less specific (could match the primary sidebar's toggle if both are present).
- (b) Pass an explicit `aria-label` prop on `SidebarCollapseToggle` if the component supports it; otherwise add prop support in a one-line tweak to the component (acceptable scope creep — it's a generic accessibility improvement).

If `SidebarCollapseToggle` already accepts an `aria-label` override, use it. Otherwise update the test regex.

### Step 4: Update `Layout.tsx` to skip padding for `/settings`

In `ui/src/components/Layout.tsx`, find the line that gates the `<main>` padding (around line 254):

```tsx
!location.pathname.includes("/workspaces/") && "p-4 md:p-6",
```

Replace with:

```tsx
!location.pathname.match(/\/(workspaces\/|settings(\?|$|\/))/) && "p-4 md:p-6",
```

This regex matches either:
- `/workspaces/` (existing exclusion)
- `/settings` followed by `?` (query string), end of string, or `/` (sub-path)

So `/companyPrefix/settings`, `/companyPrefix/settings?tab=commander`, `/companyPrefix/settings/anything` all skip the `p-4 md:p-6` padding. Standalone `settings` strings inside other paths (e.g. `/foo/settings-thing`) won't match.

### Step 5: Run the tests

```
pnpm vitest run src/__tests__/SettingsPage-redesign.test.tsx
```

Expected: all 14 prior tests + 3 new tests pass = 17 total.

If the "no redundant Settings header" test fails because of how the test queries the aside (e.g., the selector for `w-[200px]` doesn't escape correctly in JSDOM), adjust the selector:

```tsx
const aside = document.querySelector("aside.flex.shrink-0.flex-col");
```

…or use the Testing Library's `screen.getByRole("complementary")` if the aside has an implicit role.

### Step 6: Run broader UI suite

```
pnpm vitest run --dir src/__tests__
```

Expected: 904 + 3 = 907 tests pass. (Plus possibly minor adjustments if any other test asserted the old "Settings" header text inside the aside — there shouldn't be any since Phase F's tests didn't.)

### Step 7: Typecheck

```
pnpm exec tsc --noEmit
```

Expected: clean. The new `tone: "transitional"` on the GitHub item should typecheck fine because the `tone` prop type was widened in this task.

### Step 8: Commit

```bash
git add ui/src/components/settings/SettingsLayout.tsx ui/src/components/Layout.tsx ui/src/__tests__/SettingsPage-redesign.test.tsx
git commit -m "refactor(ui): SettingsLayout collapse toggle + drop padding gap + drop header

Phase F polish (cumulative review fixes):

- I1: Adds collapse toggle to the SecondarySidebar in SettingsLayout.
  200px ↔ 48px transition, persisted to localStorage. Icons-only mode
  with tooltips on hover. Brand-red glow dot active state at top-right
  of the active icon (parity with primary sidebar collapsed mode).
- I2: Layout.tsx skips the p-4 md:p-6 padding for the /settings route
  (parallel to the existing /workspaces/ exclusion). The Secondary
  sidebar now sits flush with the viewport edge (parity with
  InstanceSettingsPage hosted by LobbyShell).
- Drops the redundant 'Settings' header inside the secondary aside.
  The breadcrumb bar already shows 'Settings' — the aside starts
  straight into nav.

Adds 3 tests covering the redundant-header drop, collapse toggle
presence, and 200px↔48px width transition."
```

---

## Task 2: GitHubSection + register in SETTINGS_SECTIONS + redirect tests

**Files:**
- Create: `ui/src/components/settings/sections/GitHubSection.tsx`
- Modify: `ui/src/pages/SettingsPage.tsx`
- Modify: `ui/src/__tests__/SettingsPage-redesign.test.tsx`

The `SETTINGS_SECTIONS` constant in `SettingsLayout.tsx` was already updated in Task 1 to include the `github` item (so the navigation row appears). This task adds the section component itself and wires the SettingsPage switch to render it. Plus 2 redirect tests for the M1 follow-up.

### Step 1: Add 3 failing tests in `SettingsPage-redesign.test.tsx`

Append:

```tsx
  it("GitHub section: renders the GitHubIntegrationCard", async () => {
    renderSettings("/P4/settings?tab=github");
    expect(await screen.findByText(/GitHub/i)).toBeInTheDocument();
    // The GitHubIntegrationCard renders specific copy about the PAT
    expect(screen.getByText(/personal access token|configured|connect|Github user/i)).toBeInTheDocument();
  });

  it("/settings/commander route redirects to /settings?tab=commander", async () => {
    // The MemoryRouter starts at the legacy URL; the redirect should land us on the new query-param URL.
    // Need to test through the App routes, not just SettingsPage in isolation.
    // Use a TestRoutes stub if a full App render is too heavy.
    // ... see Step 3 for the test render helper that hits the App routes.
  });

  it("/settings/internal-agent route redirects to /settings?tab=commander", async () => {
    // Same pattern as above — verify the legacy /settings/internal-agent → /settings?tab=commander chain.
  });
```

The redirect tests need a different render helper than `renderSettings` (which mounts SettingsPage directly without going through the route definitions). Add a new helper:

```tsx
function renderViaAppRoutes(initialPath: string) {
  // Minimal route subset that mirrors the App.tsx routes for /settings/* + /:companyPrefix/*
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <DialogProvider>
          <SidebarProvider>
            <Routes>
              <Route path=":companyPrefix">
                <Route path="settings/commander" element={<Navigate to="../settings?tab=commander" replace />} />
                <Route path="settings/internal-agent" element={<Navigate to="../settings?tab=commander" replace />} />
                <Route path="settings" element={<SettingsPage />} />
              </Route>
            </Routes>
          </SidebarProvider>
        </DialogProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
```

Then for the redirect tests:

```tsx
  it("/settings/commander route redirects to /settings?tab=commander", async () => {
    renderViaAppRoutes("/P4/settings/commander");
    // After redirect, Commander sub-tabs should render.
    expect(await screen.findByRole("tab", { name: /Execution & Model/i })).toBeInTheDocument();
  });

  it("/settings/internal-agent route redirects to /settings?tab=commander", async () => {
    renderViaAppRoutes("/P4/settings/internal-agent");
    expect(await screen.findByRole("tab", { name: /Execution & Model/i })).toBeInTheDocument();
  });
```

You'll need to import `Navigate, Route, Routes` from `react-router-dom` (or `@/lib/router`).

### Step 2: Run tests to verify they fail

```
pnpm vitest run src/__tests__/SettingsPage-redesign.test.tsx -t "GitHub|redirects"
```

Expected: GitHub test fails (the SettingsPage shell falls back to General when `?tab=github` is unknown — wait, after Task 1 this is a known section, so the General fallback won't trigger. The test will hit the stub default until Task 2 wires the GitHubSection). Both redirect tests fail because there's no `<GitHubSection />` rendered yet AND the routes need to be tested through the redirect chain.

### Step 3: Create `GitHubSection.tsx`

```tsx
// ui/src/components/settings/sections/GitHubSection.tsx
import { GitHubIntegrationCard } from "@/components/GitHubIntegrationCard";

export function GitHubSection() {
  return (
    <div>
      <div className="px-8 pt-6 pb-3 border-b border-border">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60 font-semibold">
              Settings · Operations
            </div>
            <h2 className="text-[1.4rem] font-bold tracking-tight mt-1">
              GitHub<span className="text-brand">.</span>
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              GitHub Personal Access Token used for workspace pull-request creation.
            </p>
          </div>
          <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded-md bg-amber-500/15 text-amber-400/80 border border-amber-500/30 whitespace-nowrap shrink-0">
            → migrating to plugins
          </span>
        </div>
      </div>
      <div className="p-8 max-w-[680px]">
        <GitHubIntegrationCard />
      </div>
    </div>
  );
}
```

### Step 4: Wire in `SettingsPage.tsx`

Update the `SettingsSectionId` import and switch:

```tsx
import { GitHubSection } from "@/components/settings/sections/GitHubSection";

// In the switch:
case "github":      return <GitHubSection />;
```

Also add `"github"` to `VALID_SECTIONS`:

```tsx
const VALID_SECTIONS: readonly SettingsSectionId[] = [
  "general", "commander", "llm", "budget", "mcp", "github",
  "plugins", "marketplace", "archive",
];
```

(Order doesn't matter for the array since the type guard just checks membership, but keeping Operations group ids together is nice for readability.)

### Step 5: Run tests

```
pnpm vitest run src/__tests__/SettingsPage-redesign.test.tsx
```

Expected: all 17+3 = 20 tests pass.

If the GitHub PAT card test fails because `GitHubIntegrationCard` makes an API call that isn't mocked, add a mock at the top of the test file:

```tsx
vi.mock("@/api/github-integration", () => ({
  githubIntegrationApi: {
    status: vi.fn().mockResolvedValue({ configured: false }),
    setPat: vi.fn(),
    deletePat: vi.fn(),
  },
}));
```

(Verify the API surface by reading `ui/src/api/github-integration.ts` first.)

### Step 6: Run broader UI suite

```
pnpm vitest run --dir src/__tests__
```

Expected: 907 + 3 = 910 tests pass.

### Step 7: Typecheck

```
pnpm exec tsc --noEmit
```

Expected: clean.

### Step 8: Visual smoke (optional but recommended)

Start dev server, navigate to `/<company>/settings?tab=github`. Verify:
- The GitHub section renders with eyebrow "Settings · Operations" + h2 "GitHub" + amber "→ migrating to plugins" pill on the right
- Below the header: the existing GitHubIntegrationCard (PAT input + Connect button) renders
- The SecondarySidebar shows "GitHub" in the Operations group with a tiny `→plugins` chip on the right of the row
- Click the collapse toggle → sidebar shrinks to 48px, GitHub icon shows the chip-via-tooltip ("GitHub — migrating to plugins")
- `/settings/commander` URL → lands on `/settings?tab=commander` with Commander section + 4 sub-tabs

### Step 9: Commit

```bash
git add ui/src/components/settings/sections/GitHubSection.tsx ui/src/pages/SettingsPage.tsx ui/src/__tests__/SettingsPage-redesign.test.tsx
git commit -m "feat(ui): GitHub section in Settings + redirect tests

Phase F polish (cumulative review M1 follow-up + user-requested
GitHub PAT placement).

Adds a transitional 'GitHub' section in Operations group, marked
with an amber '→ plugins' pill (in both the nav row and the section
header) to signal that the GitHub PAT card will move into the
plugin system in a future effort. The section wraps the existing
GitHubIntegrationCard with the standard section-header chrome.

Adds 3 tests:
- GitHub section renders the GitHubIntegrationCard
- /settings/commander redirects to /settings?tab=commander
- /settings/internal-agent redirects to /settings?tab=commander"
```

---

## Self-Review

**1. Spec coverage:**

| User decision / cumulative-review issue | Task that implements it |
|---|---|
| I1 — collapse toggle on SecondarySidebar | Task 1 (Step 3) |
| I2 — drop padding gap around Settings | Task 1 (Step 4) |
| Drop redundant "Settings" header in aside | Task 1 (Step 3, the header div is removed) |
| GitHub PAT in own Operations section (option c) | Task 2 (Steps 3-4) |
| Amber "→ migrating to plugins" pill | Task 2 (Step 3, in section header AND in Task 1's nav-row tone="transitional") |
| M1 — `/settings/commander` and `/settings/internal-agent` redirect tests | Task 2 (Step 1) |
| Skip I3 — section-aware breadcrumbs | (Intentionally skipped — Phase G removes the BreadcrumbBar entirely) |
| BreadcrumbBar removal | (Intentionally deferred to Phase G — separate plan) |

**2. Placeholder scan:** No `TBD`, `TODO`, or vague steps. Every code block is concrete. Test deviations (like adjusting the regex if `SidebarCollapseToggle` doesn't accept `aria-label`) are explicitly called out with both branches of the decision.

**3. Type consistency:**
- `SettingsSectionId` extended with `"github"` — both in the type union AND `VALID_SECTIONS` array AND the switch case.
- `SettingsItem.tone` extended from `"danger"` → `"danger" | "transitional"` — used to drive the amber pill rendering.
- `localStorage` key `aoa.settings-secondary-collapsed` is namespaced (parallel to `aoa:sidebar-collapsed` for primary).

**4. Risks / decisions called out:**
- **`SidebarCollapseToggle` aria-label:** the test regex assumes the toggle has a "settings" word in its label. If the component doesn't accept an `aria-label` override, the test regex must adapt OR the component gets a one-line prop addition. Both paths are documented in Task 1 Step 3.
- **Mobile pill row:** unchanged. The new GitHub item gets a pill in the mobile sub-nav too (since the loop iterates `SETTINGS_SECTIONS.flatMap((g) => g.items)`).
- **Mobile swipe gesture for primary sidebar:** unchanged. The Secondary sidebar's collapse toggle is hidden on mobile (`!isMobile` gate). On mobile, only the horizontal pill row is the secondary nav.
- **GitHubIntegrationCard reachability:** Phase F preserved this file. Verified at `ui/src/components/GitHubIntegrationCard.tsx`. Task 2's wrapper imports it at `@/components/GitHubIntegrationCard`.

---

## Execution

Plan complete. Per superpowers:writing-plans:

**1. Subagent-Driven (recommended)** — fresh subagent per task with two-stage review (spec compliance → code quality) between tasks. 2 tasks → 2 implementation cycles + reviews.

**2. Inline Execution** — execute tasks in this session.

After cleanup is approved + pushed, the user's stated next phase is **Phase G — global BreadcrumbBar removal**. That's a separate plan (not covered here): remove BreadcrumbBar; move search button to top of in-company sidebar above Home; move dark/light mode toggle to in-company sidebar footer; replace mobile sidebar-toggle (currently in BreadcrumbBar); audit `setBreadcrumbs` calls across all in-company pages; ensure each page has its own h1.
