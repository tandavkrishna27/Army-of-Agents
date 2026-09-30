# Global Header Redesign — Phase G Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use **superpowers:subagent-driven-development** (recommended) or **superpowers:executing-plans** to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Slim the global `BreadcrumbBar` (currently h-12/h-14, with hamburger + breadcrumb + search + theme toggle + Commander quick-link) down to a focused h-11 strip with: mobile-only hamburger, last-2-breadcrumbs (or single page title), and search button. Theme toggle migrates from the header to **Settings > General > Appearance** as a 3-option Dark / Light / System picker (parity with macOS / Linear / Notion convention). Drop the `entityColor` border-top accent (non-standard chrome). Audit all 40 in-company pages to verify each has its own h1 (since the header no longer carries the page title with the same visual weight). Verify responsiveness at mobile / tablet / desktop breakpoints AND across the prior Phase F Settings work.

**Architecture:** UI-only redesign. No schema, no API, no routing changes. Touches three component areas: `BreadcrumbBar.tsx` (rewrite), `ThemeContext.tsx` (extend binary → tri-state), `GeneralSection.tsx` (add Theme field to existing Appearance sub-section). Plus a page-h1 audit pass that may add/clarify h1 headings on a few in-company pages. The `BreadcrumbContext`/`useBreadcrumbs` API stays unchanged — every existing `setBreadcrumbs([...])` call in 40 pages keeps working; consumer renders less.

**Tech Stack:** React 18 + Vite + Tailwind. lucide-react (`Menu`, `Search`, `Sun`, `Moon`, `Laptop`). `prefers-color-scheme` media query for System theme resolution. localStorage at `aoa.theme` (existing key, value-set widened to include `"system"`). vitest + @testing-library/react. The user's `/qa` skill (gstack) for browser-based responsive smoke check.

**Spec:** `.superpowers/global-header-v1.html` v2 mockup (locked 2026-05-09). 8 ✓ items in the verdict block.

**Branch:** `feat/ui-overhaul`. Base SHA: `043ef44` (Phase F cleanup HEAD).

---

## Files

| Action | Path | What changes |
|--------|------|--------------|
| Modify | `ui/src/components/BreadcrumbBar.tsx` | Rewrite. h-11 (was h-12/h-14). Drop `useTheme` + `useNavigate` imports, drop theme `Sun`/`Moon` button, drop `Bot` Commander button, drop `entityColor` border styling, drop full breadcrumb-trail render path. Keep last-2-breadcrumbs render only (parent dim · current bold with middot separator), single-title fallback for top-level pages. Hamburger gated `md:hidden` (desktop has external `SidebarCollapseToggle` instead) |
| Modify | `ui/src/context/ThemeContext.tsx` | Extend `Theme` type from `"light" \| "dark"` to add `"system"` as a separate `ThemePreference`. Track resolved theme via `prefers-color-scheme` listener when preference is `"system"`. Expose: `theme` (resolved), `preference` (user's choice), `setPreference`, `toggleTheme` (legacy binary toggle — kept for backward compat, deprecated for Phase G consumers) |
| Modify | `ui/src/components/settings/sections/GeneralSection.tsx` | Add a Theme field to the existing Appearance sub-section (sits alongside the existing brand-color + logo fields). 3-button toggle (Dark / Light / System) with lucide icons. Wired to `useTheme().preference` + `setPreference(...)` |
| Audit | `ui/src/pages/*.tsx` | 40 pages call `setBreadcrumbs` today. Audit each: does the page render its own `<h1>` in the body? If yes, no change. If no (page relied on BreadcrumbBar to display its title), add an `<h1>` with the breadcrumb's last entry. Expected: ~3-5 pages need an h1 added. List exact files + actions in Task 3 below |
| Modify | `ui/src/__tests__/BreadcrumbBar.test.tsx` (or create if missing) | Tests for the new behavior: hamburger md:hidden on desktop, mobile shows it; last-2-breadcrumbs render with middot; theme/Commander buttons GONE; only search remains on right; entityColor styling absent |
| Modify | `ui/src/__tests__/SettingsPage-redesign.test.tsx` | Add a test asserting Theme field renders in Settings > General > Appearance with 3 options (Dark / Light / System) |
| Create | `.changeset/global-header-phase-g.md` | `patch` bump describing the user-facing impact |

**Total:** 4 modified, 1 created. Plus per-page h1 audit (modify N pages, where N is determined in Task 3).

---

## Verification rules (apply to every task)

1. **TDD order** — failing test first, see it fail, implement, see pass, commit.
2. **Per-task scoped tests** before commit; broader UI suite (`pnpm vitest run --dir src/__tests__`) at end of each task.
3. **Conventional commits**: `feat(ui):`, `refactor(ui):`, `test(ui):`, `chore(ui):`.
4. **Typecheck after each task** — `pnpm exec tsc --noEmit` from `ui/`.
5. **Reuse existing primitives.** Don't create new components for things that exist (Tooltip, Button, lucide icons).
6. **`useBreadcrumbs` API unchanged.** Every existing `setBreadcrumbs([...])` call must continue to work — this task changes the consumer (`BreadcrumbBar.tsx`), not the producer (40 pages calling `setBreadcrumbs`).
7. **`entityColor` field stays in the context.** Pages still pass it via `setBreadcrumbs(..., { entityColor })`. The new `BreadcrumbBar` just ignores it. No breaking change for the 40 callers.
8. **Theme localStorage key stays at `aoa.theme`.** Migration: existing values `"light"` / `"dark"` continue to work; new value `"system"` allowed. No data migration required (existing users keep their explicit binary choice).
9. **Mobile-first responsive check.** Every change must work at 375px (mobile), 768px (tablet), 1280px+ (desktop). Verify at the end of each task.
10. **Don't touch any of the 9 Settings sections** other than `GeneralSection.tsx` (Phase F locked them). Don't touch `Sidebar.tsx`, `SidebarNavItem.tsx`, `SettingsLayout.tsx`, `SidebarCollapseToggle.tsx` (Phases E + F).

---

## Task 1: BreadcrumbBar slim rewrite

**Files:**
- Modify: `ui/src/components/BreadcrumbBar.tsx`
- Modify: `ui/src/__tests__/BreadcrumbBar.test.tsx` (or create if missing)

The current `BreadcrumbBar.tsx` is ~130 LOC. After this task it should be ≤90 LOC.

### Step 1: Check whether `BreadcrumbBar.test.tsx` exists

```
ls ui/src/__tests__/BreadcrumbBar.test.tsx 2>&1 || echo "missing"
```

If missing, create with the test scaffold below. If exists, append the new tests to the existing describe block.

### Step 2: Add failing tests

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BreadcrumbBar } from "@/components/BreadcrumbBar";
import { BreadcrumbProvider } from "@/context/BreadcrumbContext";
import { SidebarProvider } from "@/context/SidebarContext";
import { ThemeProvider } from "@/context/ThemeContext";

vi.mock("@/context/BreadcrumbContext", async () => {
  const actual = await vi.importActual<typeof import("@/context/BreadcrumbContext")>("@/context/BreadcrumbContext");
  return {
    ...actual,
    useBreadcrumbs: () => ({
      breadcrumbs: [
        { label: "Q4 launch", href: "/P4/projects/q4-launch" },
        { label: "Tasks" },
      ],
      subtitle: undefined,
      entityColor: undefined,
      setBreadcrumbs: vi.fn(),
    }),
  };
});

function renderBar() {
  return render(
    <MemoryRouter>
      <BreadcrumbProvider>
        <SidebarProvider>
          <ThemeProvider>
            <BreadcrumbBar />
          </ThemeProvider>
        </SidebarProvider>
      </BreadcrumbProvider>
    </MemoryRouter>,
  );
}

describe("BreadcrumbBar — Phase G slim", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1280 });
    window.dispatchEvent(new Event("resize"));
  });

  it("renders just the search button on the right (no theme toggle, no Commander button)", () => {
    renderBar();
    expect(screen.getByLabelText(/search/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/dark mode|light mode|switch to/i)).toBeNull();
    expect(screen.queryByLabelText(/commander/i)).toBeNull();
  });

  it("renders last-2-breadcrumbs as a slim trail with middot separator", () => {
    renderBar();
    expect(screen.getByText("Q4 launch")).toBeInTheDocument();
    expect(screen.getByText("Tasks")).toBeInTheDocument();
    // Middot character used as separator
    const container = screen.getByText("Tasks").parentElement;
    expect(container?.textContent).toContain("·");
  });

  it("hides hamburger on desktop (md+)", () => {
    renderBar();
    // The hamburger button is gated md:hidden — present in DOM but hidden via CSS.
    // Test by querying for the exact `md:hidden` class on the menu button's wrapper.
    const menuButton = screen.queryByLabelText(/open sidebar|toggle sidebar/i);
    if (menuButton) {
      expect(menuButton.className).toContain("md:hidden");
    }
    // (Either the button is absent, or it has md:hidden — both are valid implementations.)
  });
});
```

### Step 3: Run tests to verify they fail

```
pnpm vitest run src/__tests__/BreadcrumbBar.test.tsx
```

Expected: FAIL on the first 2 tests. Pass on the third (depends on impl).

### Step 4: Rewrite `BreadcrumbBar.tsx`

Use this exact body:

```tsx
import { Link } from "@/lib/router";
import { Menu, Search } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { Button } from "@/components/ui/button";

export function BreadcrumbBar() {
  const { breadcrumbs } = useBreadcrumbs();
  const { toggleSidebar, isMobile } = useSidebar();

  if (breadcrumbs.length === 0) return null;

  function openSearch() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  }

  // Show last 2 entries: parent (clickable, dim) · current (bold, foreground).
  // Top-level pages have just 1 entry → render single title.
  const lastTwo = breadcrumbs.slice(-2);
  const hasParent = lastTwo.length === 2;
  const parent = hasParent ? lastTwo[0] : null;
  const current = lastTwo[hasParent ? 1 : 0]!;

  return (
    <div className="border-b border-border px-4 md:px-6 h-11 shrink-0 flex items-center min-w-0 overflow-hidden">
      {/* Mobile-only hamburger */}
      <Button
        variant="ghost"
        size="icon-sm"
        className="md:hidden mr-2 shrink-0"
        onClick={toggleSidebar}
        aria-label="Open sidebar"
      >
        <Menu className="h-5 w-5" />
      </Button>

      {/* Breadcrumb / page title */}
      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        {parent && (
          <>
            {parent.href ? (
              <Link
                to={parent.href}
                className="text-[13px] text-muted-foreground hover:text-foreground truncate"
              >
                {parent.label}
              </Link>
            ) : (
              <span className="text-[13px] text-muted-foreground truncate">{parent.label}</span>
            )}
            <span className="text-muted-foreground/60 shrink-0" aria-hidden>·</span>
          </>
        )}
        <h1 className="text-[14px] font-semibold tracking-wide truncate">
          {current.label}
        </h1>
      </div>

      {/* Right side — just search */}
      <div className="ml-auto flex items-center gap-0.5 shrink-0">
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={openSearch}
          aria-label="Search (Cmd+K)"
          title="Search (Cmd+K)"
        >
          <Search className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
```

Notes:
- **Imports dropped:** `useNavigate`, `useTheme`, `Bot`, `Sun`, `Moon`, `Fragment`, all `Breadcrumb*` UI primitives (we render the slim trail manually instead of using the `Breadcrumb` shadcn component).
- **`subtitle` and `entityColor`** read from `useBreadcrumbs()` are no longer used. They remain in the context (40 pages still pass them via `setBreadcrumbs`) — just ignored by the new bar. No breaking change.
- **`isMobile`** is destructured from `useSidebar()` for completeness but not actually used in this version (CSS `md:hidden` does the gating). Keep destructured if a follow-up needs it; otherwise drop.

### Step 5: Run failing tests + verify pass

```
pnpm vitest run src/__tests__/BreadcrumbBar.test.tsx
```

Expected: 3/3 pass.

### Step 6: Run broader UI suite

```
pnpm vitest run --dir src/__tests__
```

Expected: full suite still green. Two flake risks to watch:
- Pages whose tests render the BreadcrumbBar may have asserted the theme button or breadcrumb trail. Update those assertions if any fail.
- The 12 InternalAgentSettings → CommanderSection tests should not depend on BreadcrumbBar (they mock context); should pass unchanged.

### Step 7: Typecheck

```
pnpm exec tsc --noEmit
```

Expected: clean. If a `useTheme` import is now orphaned in another file (unlikely — search the codebase for `useTheme`), remove it.

### Step 8: Commit

```bash
git add ui/src/components/BreadcrumbBar.tsx ui/src/__tests__/BreadcrumbBar.test.tsx
git commit -m "refactor(ui): slim global header to h-11, drop theme + Commander + entityColor

Phase G Task 1 — header redesign per locked decisions:

- Height h-12/h-14 → h-11 (-12 to -16px vertical space).
- Drop theme toggle button (migrates to Settings > General > Appearance
  in Task 2).
- Drop Commander quick-link (already in sidebar nav).
- Drop entityColor border-top accent (non-standard chrome — pages
  express identity through h1 + content).
- Trim breadcrumb to last 2 entries with middot separator (parent dim
  · current bold). Single-entry pages render just the title.
- Hamburger gated md:hidden — desktop uses external SidebarCollapseToggle
  for primary collapse; mobile uses hamburger to open the slide-over.
- useBreadcrumbs API unchanged: 40 calling pages keep working;
  consumer (this file) renders less."
```

---

## Task 2: ThemeContext tri-state + Theme field in Settings > General > Appearance

**Files:**
- Modify: `ui/src/context/ThemeContext.tsx`
- Modify: `ui/src/components/settings/sections/GeneralSection.tsx`
- Modify: `ui/src/__tests__/SettingsPage-redesign.test.tsx`

This task extends `ThemeContext` from binary (`light`/`dark`) to a tri-state preference (`light`/`dark`/`system`) and surfaces the picker in the Settings UI.

### Step 1: Add failing test in `SettingsPage-redesign.test.tsx`

Append a new test:

```tsx
  it("Settings > General > Appearance has a Theme field with 3 options (Dark / Light / System)", async () => {
    renderSettings("/P4/settings?tab=general");
    // The Theme sub-section renders 3 buttons
    expect(await screen.findByRole("button", { name: /^Dark$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Light$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^System$/i })).toBeInTheDocument();
  });
```

### Step 2: Run test to verify it fails

```
pnpm vitest run src/__tests__/SettingsPage-redesign.test.tsx -t "Theme field"
```

Expected: FAIL — GeneralSection has no Theme field yet.

### Step 3: Extend `ThemeContext.tsx`

The existing context has `theme: "light" | "dark"` + `setTheme` + `toggleTheme`. Extend to:

```tsx
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from "react";

type ResolvedTheme = "light" | "dark";
export type ThemePreference = "light" | "dark" | "system";

interface ThemeContextValue {
  /** Resolved theme actually applied to the DOM. */
  theme: ResolvedTheme;
  /** User's preference. May be "system". */
  preference: ThemePreference;
  setPreference: (pref: ThemePreference) => void;
  /** Legacy binary toggle. Now flips between explicit light/dark (skips system). */
  toggleTheme: () => void;
}

const THEME_STORAGE_KEY = "aoa.theme";
const DARK_THEME_COLOR = "#18181b";
const LIGHT_THEME_COLOR = "#ffffff";
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function readPreference(): ThemePreference {
  if (typeof localStorage === "undefined") return "dark";
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch { /* ignore */ }
  // Default fallback — match the existing initial-theme behavior.
  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) {
    return "dark";
  }
  return "dark";
}

function resolveSystem(): ResolvedTheme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  const isDark = resolved === "dark";
  const root = document.documentElement;
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta instanceof HTMLMetaElement) {
    themeColorMeta.setAttribute("content", isDark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readPreference());
  const [systemResolved, setSystemResolved] = useState<ResolvedTheme>(() => resolveSystem());

  const resolved: ResolvedTheme = preference === "system" ? systemResolved : preference;

  // Watch the system preference if user is on "system".
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setSystemResolved(e.matches ? "dark" : "light");
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  // Apply + persist whenever resolved theme changes.
  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  // Persist user preference (NOT resolved) — so System mode is remembered across sessions.
  useEffect(() => {
    try { localStorage.setItem(THEME_STORAGE_KEY, preference); } catch { /* ignore */ }
  }, [preference]);

  const setPreference = useCallback((pref: ThemePreference) => setPreferenceState(pref), []);
  const toggleTheme = useCallback(() => {
    setPreferenceState((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme: resolved, preference, setPreference, toggleTheme }),
    [resolved, preference, setPreference, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}
```

Notes:
- **Backward compat:** `theme` still exists on the returned context (now resolved). Existing call sites that do `theme === "dark" ? ... : ...` keep working.
- **`toggleTheme` legacy** — kept for backward compat. Phase G drops its only call site (BreadcrumbBar's theme button) in Task 1; if no consumers remain after this task, can be removed. Search after the migration:
  ```bash
  grep -rn "toggleTheme" ui/src --include="*.tsx"
  ```
  Should return only the ThemeContext file itself. If so, remove `toggleTheme` from the value (cleanup deferred to follow-up).
- **`setTheme` removed** — replaced by `setPreference`. If any test imports `setTheme`, update.

### Step 4: Add Theme field to `GeneralSection.tsx` Appearance sub-section

Find the existing Appearance sub-section in `ui/src/components/settings/sections/GeneralSection.tsx` (it's where the brand-color picker + logo upload live). Add a new field block AFTER the Logo block, BEFORE the next sub-section's heading:

```tsx
import { useTheme } from "@/context/ThemeContext";
import { Sun, Moon, Laptop } from "lucide-react";

// ... inside the component body, where other useState hooks live, add:
const { preference, setPreference } = useTheme();

// ... in the Appearance sub-section JSX, after the Logo block:
<div className="border-t border-border pt-3">
  <div className="text-sm font-medium">Theme</div>
  <p className="text-[11.5px] text-muted-foreground mt-0.5">
    UI color scheme. "System" follows your OS preference.
  </p>
  <div className="mt-2 flex items-center gap-2 flex-wrap">
    {(
      [
        { value: "dark", label: "Dark", icon: Moon },
        { value: "light", label: "Light", icon: Sun },
        { value: "system", label: "System", icon: Laptop },
      ] as const
    ).map(({ value, label, icon: Icon }) => {
      const active = preference === value;
      return (
        <button
          key={value}
          type="button"
          onClick={() => setPreference(value)}
          aria-pressed={active}
          className={cn(
            "px-3 py-1.5 text-sm rounded-md border inline-flex items-center gap-1.5 transition-colors",
            active
              ? "bg-card-3 border-border text-foreground"
              : "border-border-strong text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
          )}
        >
          <Icon className="size-3.5" />
          {label}
        </button>
      );
    })}
  </div>
</div>
```

(Adapt class names to match other Appearance sub-section field styling. Verify the `cn` import is already in the file.)

### Step 5: Run the failing test

```
pnpm vitest run src/__tests__/SettingsPage-redesign.test.tsx -t "Theme field"
```

Expected: PASS.

### Step 6: Run broader UI suite

```
pnpm vitest run --dir src/__tests__
```

Expected: still green. The existing ThemeContext-using tests (if any beyond the BreadcrumbBar refactor in Task 1) should adapt — `toggleTheme` still exists, `theme` still exists.

### Step 7: Typecheck

```
pnpm exec tsc --noEmit
```

If `setTheme` was used anywhere outside ThemeContext.tsx, replace with `setPreference`. Search:

```bash
grep -rn "setTheme" ui/src --include="*.tsx" --include="*.ts"
```

### Step 8: Commit

```bash
git add ui/src/context/ThemeContext.tsx ui/src/components/settings/sections/GeneralSection.tsx ui/src/__tests__/SettingsPage-redesign.test.tsx
git commit -m "feat(ui): theme picker in Settings > General > Appearance + tri-state ThemeContext

Phase G Task 2 — theme migration from header to Settings:

- ThemeContext extended from binary light/dark to tri-state preference
  (light/dark/system). System mode tracks prefers-color-scheme media
  query. Resolved theme still exposed via useTheme().theme — backward
  compat preserved for any non-Phase-G consumers.
- GeneralSection adds a Theme field to the Appearance sub-section
  (alongside brand color + logo). 3-button picker (Dark / Light /
  System) with lucide icons. aria-pressed state.
- localStorage at aoa.theme stores user preference (light/dark/system),
  not resolved theme — System mode persists across sessions."
```

---

## Task 3: Page h1 audit + responsive smoke check

**Files:**
- Audit + potentially modify: `ui/src/pages/*.tsx` (40 pages)
- Optionally: `.changeset/global-header-phase-g.md`

The new BreadcrumbBar shows the current page title at h-11 with smaller font weight than before. Pages that previously relied on the BreadcrumbBar to be their primary visible title need to render their own `<h1>` in the page body to maintain hierarchy + accessibility.

### Step 1: Enumerate pages

```bash
grep -rln "setBreadcrumbs\|useBreadcrumbs" ui/src/pages --include="*.tsx" | sort
```

Expected: 40 pages.

### Step 2: For each page, check if it renders its own `<h1>`

Open each file and look for `<h1`. Most pages will. Pages that do NOT will need an h1 added.

Quick way to find candidates:

```bash
for f in $(grep -rl "setBreadcrumbs" ui/src/pages --include="*.tsx"); do
  if ! grep -q "<h1" "$f"; then
    echo "MISSING H1: $f"
  fi
done
```

This produces a list. Expected: ~3-5 pages missing h1. Common candidates: `Inbox.tsx`, `MyIssues.tsx`, `Companies.tsx`, possibly `Costs.tsx`, `Org.tsx`. Adjust based on actual output.

### Step 3: Add h1 to missing pages

For each page in the "MISSING H1" list, add an h1 at the top of the rendered page body. Use the pattern established in Phase F sections (e.g. CompanyActivityPage.tsx:108):

```tsx
<h1 className="text-[1.6rem] font-bold tracking-tight">
  {pageTitle}<span className="text-brand">.</span>
</h1>
<p className="mt-1 text-sm text-muted-foreground">{pageDescription}</p>
```

`pageTitle` should match the breadcrumb's current label (whatever the page passes to `setBreadcrumbs(...)`). `pageDescription` is optional but recommended for top-level pages (one short sentence).

### Step 4: Responsive smoke check

After Tasks 1 + 2 + the audit, run a manual smoke check at 3 breakpoints. Either via `/qa` skill (gstack browser automation) or manually in the dev server.

For each breakpoint, verify on these key pages:
- **Home** (top-level page, h1 visible)
- **Settings > General** (theme picker visible, Appearance sub-section)
- **Settings > Commander** (4 sub-tabs render correctly)
- **A nested page** (e.g. project detail — breadcrumb shows "Project name · current page")
- **Marketplace prefs** (mobile pill row works)
- **Activity** (page renders with own h1)

| Breakpoint | What to check |
|---|---|
| **375px (mobile)** | Hamburger visible in header. SecondarySidebar absent (uses pill row). Commander sub-tabs render as nested pill row. No horizontal scroll. |
| **768px (tablet)** | Hamburger gone. SecondarySidebar present at 200px. Settings layout works. Sidebar collapse toggle clickable. |
| **1280px (desktop)** | Full Phase E primary sidebar (220px) + Settings SecondarySidebar (200px) + main content. Breadcrumb shows last 2 entries. No padding gap on Settings. |

### Step 5: If using `/qa` (gstack)

```
/qa
```

The `/qa` skill opens a browser, finds bugs, fixes them, regression-tests. It's defined per CLAUDE.md as: "open browser, find bugs, fix, regression-test". The expected output is a bug list + auto-fixes for issues caught.

### Step 6: Add changeset

Create `.changeset/global-header-phase-g.md`:

```md
---
"@armyofagents/ui": patch
---

Global header redesign (Phase G): slims the BreadcrumbBar from
h-12/h-14 to h-11. Drops the theme toggle, Commander quick-link, and
entityColor border-top accent. Breadcrumb shows the last 2 levels
with a middot separator (single title for top-level pages).
Hamburger menu is mobile-only — desktop uses the external sidebar
collapse toggle.

Theme toggle migrates to Settings > General > Appearance as a
3-option picker (Dark / Light / System). The "System" option follows
the OS preference via prefers-color-scheme media query.
```

### Step 7: Final test sweep

```
pnpm vitest run --dir src/__tests__
pnpm exec tsc --noEmit
```

Both clean.

### Step 8: Commit

```bash
git add ui/src/pages/<files-modified-in-step-3> .changeset/global-header-phase-g.md
git commit -m "chore(ui): page h1 audit + Phase G changeset

Phase G Task 3 — audit + finalize.

Audited 40 pages calling setBreadcrumbs. <N> pages missing h1
gained an explicit h1 in the page body so titling/accessibility
hierarchy is preserved now that the BreadcrumbBar is slimmer.

Pages updated: <list filenames here>

Adds the Phase G changeset describing user-facing impact."
```

---

## Self-Review

**1. Spec coverage:**

| Locked decision (mockup verdict) | Task |
|---|---|
| Header height h-11 | Task 1 |
| Last-2-breadcrumbs with middot | Task 1 |
| Hamburger md:hidden (mobile-only) | Task 1 |
| Search stays in header (right side) | Task 1 |
| Theme toggle → Settings > General > Appearance | Task 2 |
| Theme expansion: Dark / Light / System | Task 2 |
| Drop Commander quick-link button | Task 1 |
| Drop entityColor border-top | Task 1 |
| Mobile preserved (drawer + breadcrumb truncate) | Task 1 (CSS gating) + Task 3 (responsive smoke) |

All 9 locked decisions are mapped.

**2. Placeholder scan:** No `TBD`, `TODO`. Every code block is concrete. The audit step (Task 3) is intentionally exploratory — it's a discovery + remediation task whose specific edits depend on what the audit finds. Acceptable.

**3. Type consistency:**
- `ThemePreference = "light" | "dark" | "system"` (new exported type)
- `ResolvedTheme = "light" | "dark"` (new internal type)
- `useTheme()` return shape: `{ theme, preference, setPreference, toggleTheme }` — fully typed
- `setTheme` removed from public API; if any consumer used it, replace with `setPreference`
- `toggleTheme` kept for backward compat — Task 1 drops its only call site (BreadcrumbBar's theme button) so it should be unused after Task 2; safe to remove in a follow-up

**4. Risks called out:**
- **`setTheme` migration**: Task 2 Step 7 explicitly searches for outside-context callers and updates them. If discovered late, the build breaks — recoverable with one rename per call site.
- **`toggleTheme` orphan**: After Task 1, `toggleTheme` should have zero callers. If true, it can be removed in a tiny follow-up. If false, it stays for compat.
- **Page h1 audit scale**: 40 pages is a lot. Most already have h1 (Phase F sections all do). Audit is mechanical scan; expect ~3-5 fixes.
- **System mode media-query listener**: needs to clean up on unmount (handled in the `useEffect` return).
- **Existing localStorage values**: `"light"` and `"dark"` continue to work (the `readPreference` function accepts them). `"system"` is new. No data migration needed.
- **Tests using `setTheme`**: existing test files may import or call `setTheme`. Search + update.

**5. Out-of-scope (Phase H or future):**
- Removing `entityColor` field from `BreadcrumbContext` entirely (40 pages still set it; ripping out is a 40-file diff). This task just makes the consumer ignore it.
- Removing `subtitle` field similarly. Same reasoning.
- Removing `toggleTheme` from `ThemeContext` (will be unused after Task 1; safe to remove in a follow-up patch).

---

## Execution

Plan complete. Per superpowers:writing-plans:

**1. Subagent-Driven (recommended)** — fresh subagent per task with two-stage review (spec compliance → code quality) between tasks. 3 tasks → 3 implementation cycles + reviews.

**2. Inline Execution** — execute tasks in this session.

After all 3 tasks land, run the visual + responsive smoke check via `/qa` (gstack) per the user's request. The smoke check verifies the entire Phase F + G work end-to-end at mobile / tablet / desktop breakpoints.
