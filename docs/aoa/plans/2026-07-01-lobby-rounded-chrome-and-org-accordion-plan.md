# Lobby rounded chrome + New-organization accordion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the lobby-tier chrome a floating rounded-rail look and turn the "+ New organization" CTA into a split button with an inline "Import organization" accordion.

**Architecture:** Pure UI change in three components — `LobbySidebar` (rounded rail + accordion), `SecondarySidebar` (opt-in `floating` prop), and the lobby-tier call site `InstanceSettingsPage` (enables `floating`). No API, schema, or route changes. Import reuses the existing `/import` route.

**Tech Stack:** React + TailwindCSS v4, vitest + @testing-library/react, lucide-react icons.

**Design doc:** `docs/aoa/plans/2026-07-01-lobby-rounded-chrome-and-org-accordion-design.md`

**Note on starting state:** The `feat/lobby-ui` working tree already contains the
validated prototype for Task 1 (rounded rail + toggle offset) and Task 2
(accordion) in `ui/src/components/LobbySidebar.tsx`. Those tasks therefore
**add the tests that lock the behavior** and verify against the existing
implementation. Tasks 3–6 are net-new. If starting from a clean checkout,
re-apply the implementation shown in each task before running its test.

**Test command (from repo root):**
`pnpm --filter @armyofagents/ui test:run -- <path relative to ui/>`
**Typecheck:** `pnpm --filter @armyofagents/ui typecheck`

---

## Task 1: Lock the rounded primary rail

**Files:**
- Implementation (already in tree): `ui/src/components/LobbySidebar.tsx` — aside className + `SidebarCollapseToggle` props
- Test: `ui/src/__tests__/LobbySidebar.test.tsx`

- [ ] **Step 1: Add tests for the rounded-rail classes and preserved behavior**

Append to the `describe("LobbySidebar", ...)` block in `ui/src/__tests__/LobbySidebar.test.tsx`:

```tsx
it("renders the primary rail as a rounded floating island (no right border)", () => {
  const { container } = renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
  const aside = container.querySelector("aside")!;
  expect(aside.className).toContain("rounded-2xl");
  expect(aside.className).toContain("border-border");
  // Floating island uses an all-sides border, not the old flush right border.
  expect(aside.className).not.toContain("border-r");
});

it("drawer mode is full-width and NOT rounded", () => {
  const { container } = renderWithProviders(
    <LobbySidebar onCreateCompany={onCreateCompany} drawer />,
  );
  const aside = container.querySelector("aside")!;
  expect(aside.className).toContain("w-full");
  expect(aside.className).not.toContain("rounded-2xl");
});
```

- [ ] **Step 2: Run the tests — expect PASS (impl already in tree)**

Run: `pnpm --filter @armyofagents/ui test:run -- src/__tests__/LobbySidebar.test.tsx`
Expected: PASS. (If a clean checkout, the rounded-island / drawer tests FAIL first — then apply the aside className from the design doc §"1. LobbySidebar" and re-run to PASS.)

Reference implementation (already present) — the non-drawer aside className:

```tsx
className={cn(
  "relative flex shrink-0 flex-col",
  drawer
    ? "w-full h-dvh"
    : "h-[calc(100dvh-1rem)] my-2 ml-2 overflow-hidden rounded-2xl border border-border bg-card/50 backdrop-blur-sm transition-[width] duration-[180ms]",
  !drawer && (collapsed ? "w-[56px]" : "w-[220px]"),
  !drawer && "lobby-sidebar-enter",
)}
```

And the collapse toggle offset (already present):

```tsx
<SidebarCollapseToggle
  collapsed={collapsed}
  onToggle={() => setCollapsed((c) => !c)}
  sidebarWidth={(collapsed ? 56 : 220) + 8}
  top={17}
  className="hidden md:inline-flex"
/>
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/__tests__/LobbySidebar.test.tsx ui/src/components/LobbySidebar.tsx
git commit -m "feat(lobby): rounded floating primary rail + tests"
```

---

## Task 2: New-organization split button with floating Import menu

**Files:**
- Implementation (already in tree): `ui/src/components/LobbySidebar.tsx` — attached split button + `DropdownMenu`
- Test: `ui/src/__tests__/LobbySidebar.test.tsx`

**Approach note:** Import opens in a floating Radix `DropdownMenu` (no layout
shift, aligned to the chevron), not an inline accordion. Radix's real portal +
pointer events do not run cleanly in jsdom, so tests **mock**
`@/components/ui/dropdown-menu` (render children inline) — the same convention as
`ui/src/__tests__/AgentCard.test.tsx`.

- [ ] **Step 1: Add the dropdown-menu mock near the other `vi.mock` calls**

In `ui/src/__tests__/LobbySidebar.test.tsx`, add alongside the existing mocks
(after the tooltip mock):

```tsx
// Radix DropdownMenu doesn't run cleanly in jsdom (portal + pointer events).
// Render children inline and map onSelect→onClick so items are directly testable.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: any) => <>{children}</>,
  DropdownMenuContent: ({ children }: any) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: any) => (
    <div role="menuitem" onClick={onSelect}>{children}</div>
  ),
}));
```

- [ ] **Step 2: Add split-button behavior tests**

Append to the `describe("LobbySidebar", ...)` block:

```tsx
it("expanded: renders the create button and the More-options trigger", () => {
  renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
  expect(screen.getByRole("button", { name: /^new organization$/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /more organization options/i })).toBeInTheDocument();
});

it("Import organization menuitem navigates to /import", async () => {
  const user = userEvent.setup();
  renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
  await user.click(screen.getByRole("menuitem", { name: /import organization/i }));
  expect(mockNavigate).toHaveBeenCalledWith("/import", undefined);
});

it("primary + New organization still creates in one click (no regression)", async () => {
  const user = userEvent.setup();
  renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
  await user.click(screen.getByRole("button", { name: /^new organization$/i }));
  expect(onCreateCompany).toHaveBeenCalledTimes(1);
});

it("collapsed: no More-options trigger and no import menuitem (create-only)", () => {
  localStorage.setItem("aoa.lobby.sidebar-collapsed", "true");
  renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
  expect(screen.queryByRole("button", { name: /more organization options/i })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: /import organization/i })).toBeNull();
});
```

- [ ] **Step 3: Run the tests — expect PASS (impl already in tree)**

Run: `pnpm --filter @armyofagents/ui test:run -- src/__tests__/LobbySidebar.test.tsx`
Expected: PASS. (Clean checkout: apply the reference implementation below plus the
`DropdownMenu*` imports and the `ChevronDown`/`Upload` icon imports, then re-run.)

Reference implementation (already present) — the expanded-branch CTA:

```tsx
<DropdownMenu>
  {/* Attached split button — primary creates in one click; the
      joined chevron segment opens a floating menu (no layout shift). */}
  <div className="flex">
    <Button
      size="default"
      onClick={create}
      className="flex-1 justify-center gap-1.5 rounded-r-none"
    >
      <Plus />
      New organization
    </Button>
    <DropdownMenuTrigger asChild>
      <Button
        size="default"
        aria-label="More organization options"
        className="rounded-l-none border-l border-l-black/20 px-2 data-[state=open]:[&_svg]:rotate-180"
      >
        <ChevronDown className="size-4 transition-transform" />
      </Button>
    </DropdownMenuTrigger>
  </div>
  <DropdownMenuContent align="end" sideOffset={6} className="min-w-[200px]">
    <DropdownMenuItem onSelect={() => navTo("/import")}>
      <Upload />
      Import organization
    </DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

Required imports at the top of `LobbySidebar.tsx`:

```tsx
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
```
plus `ChevronDown` and `Upload` added to the existing `lucide-react` import. No
local open-state is used (Radix owns it) — the `orgMenuOpen` prototype state is
removed.

- [ ] **Step 4: Commit**

```bash
git add ui/src/__tests__/LobbySidebar.test.tsx ui/src/components/LobbySidebar.tsx
git commit -m "feat(lobby): New-organization split button with floating Import menu"
```

---

## Task 3: SecondarySidebar `floating` prop (net-new)

**Files:**
- Modify: `ui/src/components/SecondarySidebar.tsx`
- Test: `ui/src/components/__tests__/SecondarySidebar.test.tsx`

- [ ] **Step 1: Write failing tests for the floating variant**

Append to `describe("SecondarySidebar", ...)`:

```tsx
it("default (non-floating) keeps the flush right border and no rounding", () => {
  const { container } = render(<SecondarySidebar sections={SECTIONS} />);
  const root = container.querySelector("[role='navigation']")!;
  expect(root.className).toContain("border-r");
  expect(root.className).not.toContain("rounded-2xl");
});

it("floating variant is a rounded island with an all-sides border", () => {
  const { container } = render(<SecondarySidebar sections={SECTIONS} floating />);
  const root = container.querySelector("[role='navigation']")!;
  expect(root.className).toContain("rounded-2xl");
  expect(root.className).not.toContain("border-r");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @armyofagents/ui test:run -- src/components/__tests__/SecondarySidebar.test.tsx`
Expected: FAIL — the floating test errors (unknown prop / no `rounded-2xl`), and the default test may currently pass.

- [ ] **Step 3: Add the `floating` prop and conditional classes**

In `ui/src/components/SecondarySidebar.tsx`, add `floating?: boolean` to `SecondarySidebarProps`:

```tsx
export interface SecondarySidebarProps {
  sections: SecondarySidebarSection[];
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  className?: string;
  /**
   * When true, render as a floating rounded "island" (lobby-tier chrome) instead
   * of the flush right-bordered rail. Opt-in — in-company consumers (TeamLayout,
   * in-company SettingsLayout) leave it false. See design-system §8.
   */
  floating?: boolean;
}
```

Destructure it (`floating = false`) and replace the root `className` cn(...) call:

```tsx
    <div
      className={cn(
        "bg-secondary-sidebar flex flex-col pt-16 pb-3.5",
        "transition-[width] duration-[180ms]",
        floating
          ? "h-[calc(100dvh-1rem)] my-2 ml-2 overflow-hidden rounded-2xl border border-border"
          : "border-r border-border",
        collapsed ? "w-12 px-1" : "w-[200px] px-2",
        className
      )}
      data-collapsed={collapsed}
      role="navigation"
      aria-label="Page navigation"
    >
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @armyofagents/ui test:run -- src/components/__tests__/SecondarySidebar.test.tsx`
Expected: PASS (all existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/SecondarySidebar.tsx ui/src/components/__tests__/SecondarySidebar.test.tsx
git commit -m "feat(lobby): opt-in floating variant for SecondarySidebar"
```

---

## Task 4: Enable floating at the lobby-tier call site

**Files:**
- Modify: `ui/src/pages/InstanceSettingsPage.tsx` — the `<SecondarySidebar .../>` render
- Test: reuse existing `ui/src/__tests__/SettingsPage-redesign.test.tsx` (must stay green)

- [ ] **Step 1: Locate the SecondarySidebar usage**

Run: `grep -n "SecondarySidebar" ui/src/pages/InstanceSettingsPage.tsx`
Expected: one JSX usage (and its import).

- [ ] **Step 2: Add the `floating` prop to that usage**

Add `floating` to the `<SecondarySidebar>` element rendered by `InstanceSettingsPage` (the lobby-tier settings). Example (match the actual props already present):

```tsx
<SecondarySidebar
  sections={sections}
  collapsed={secondaryCollapsed}
  onToggleCollapse={() => setSecondaryCollapsed((c) => !c)}
  floating
/>
```

Do NOT touch `ui/src/components/team/TeamLayout.tsx` or the in-company
`ui/src/components/settings/SettingsLayout.tsx` — they stay flush.

- [ ] **Step 3: Typecheck + run the settings test**

Run: `pnpm --filter @armyofagents/ui typecheck`
Run: `pnpm --filter @armyofagents/ui test:run -- src/__tests__/SettingsPage-redesign.test.tsx`
Expected: typecheck clean; settings test PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/pages/InstanceSettingsPage.tsx
git commit -m "feat(lobby): float the lobby-tier Settings secondary sidebar"
```

---

## Task 5: Document the floating-rail treatment (design-system §8)

**Files:**
- Modify: `docs/architecture/design-system.md` (§8 sidebar section)

- [ ] **Step 1: Add a subsection documenting the lobby-tier floating rail**

Under §8 (near the Lobby-tier shell paragraph, ~line 287), add:

```markdown
#### 8.1.2 Lobby-tier floating rails (2026-07)

The lobby-tier chrome (`LobbyShell` surfaces: Lobby, Marketplace, Settings)
renders its primary rail — and, when present, its secondary sidebar — as a
floating rounded "island": `my-2 ml-2 rounded-2xl border border-border`,
`h-[calc(100dvh-1rem)]`, `overflow-hidden`, and NO drop shadow (per §7 inline UI
carries no shadow — the border + `bg-card/50` sells the float). Main content
stays flush to the window edge ("floating rail only", not full floating panels).

The external collapse toggle is offset by the 8px left gutter
(`sidebarWidth + 8`, `top 17`) so it still straddles the rail/main seam.

Scope: lobby-tier only. The in-company primary `Sidebar` and the in-company
`SecondarySidebar` consumers (`TeamLayout`, in-company `SettingsLayout`) keep the
flush-rail look. `SecondarySidebar` exposes an opt-in `floating` prop (default
false) so only the lobby-tier `InstanceSettingsPage` gets the island treatment.
```

- [ ] **Step 2: Commit**

```bash
git add docs/architecture/design-system.md
git commit -m "docs(design-system): document lobby-tier floating rails (§8.1.2)"
```

---

## Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the UI package**

Run: `pnpm --filter @armyofagents/ui typecheck`
Expected: no errors.

- [ ] **Step 2: Run the full UI test suite**

Run: `pnpm --filter @armyofagents/ui test:run`
Expected: all green (including LobbySidebar + SecondarySidebar + Settings suites).

- [ ] **Step 3: Live-verify on the running instance (port 3280)**

The dev instance auto-HMRs. Using the gstack browse binary
(`~/.claude/skills/gstack/browse/dist/browse`):
- `goto http://127.0.0.1:3280/` → screenshot → confirm rounded rail + attached split button, `console --errors` clean.
- Click the chevron → screenshot → confirm the floating "Import organization" menu overlays the nav (no layout shift) and is aligned to the button.
- `goto http://127.0.0.1:3280/instance/settings` → screenshot → confirm the secondary sidebar is a rounded island and the primary is force-collapsed + rounded.
- Toggle the primary collapse → confirm the toggle sits on the seam and the collapsed rail shows create-only (no chevron).

Expected: all screenshots match the design; zero console errors.

- [ ] **Step 4: Final review commit (if any doc/screenshot notes)**

```bash
git status
# working tree should be clean after Tasks 1-5 commits; nothing to commit here unless notes were added.
```

---

## Self-review notes

- **Spec coverage:** D1 rounded rail → Task 1; D3/D4/D5 accordion + collapsed create-only → Task 2; D6 opt-in secondary floating → Tasks 3+4; docs → Task 5; D2 no-shadow is enforced by simply not adding a shadow class (asserted implicitly — no `shadow-` in the floating classes). Verification → Task 6.
- **Placeholder scan:** none — every code + command step is concrete.
- **Type consistency:** `orgMenuOpen`/`setOrgMenuOpen`, `floating` prop, and the `/import` navigation target are used identically across tasks; navigation assertion `("/import", undefined)` mirrors the existing marketplace/settings test pattern.
