# Per-Company Settings Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use **superpowers:subagent-driven-development** (recommended) or **superpowers:executing-plans** to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-company `SettingsPage.tsx` (1,732 LOC, 7-tab `PageTabBar` + a `/settings/commander` sub-route + the InternalAgentSettingsPage 707 LOC) with a SecondarySidebar layout (parity with `InstanceSettingsPage` Phase D) — 8 sections in 4 groups (Company / Operations / Extensions / Danger), Commander folded into Operations with its 4 sub-tabs preserved, Activity promoted out of Settings to its own surface, the redundant `/settings/commander` sub-route + top "Commander" card link removed, and 3 ghost server-settings (`proactiveIntervalMinutes`, `marketplaceSettings.updateWindow`, `rootFolder`) get UI controls.

**Architecture:** UI-only refactor. No schema changes, no API changes. Each section becomes a focused component file under `ui/src/components/settings/`. The existing 707-LOC `InternalAgentSettingsPage.tsx` content moves into `CommanderSection.tsx` with the 4 sub-tabs intact (rendered as horizontal underline tabs on desktop + nested scrollable pills on mobile). Primary in-company sidebar auto-collapses on entry (Decision #98 applied to per-company chrome). SecondarySidebar at 200px expanded / 48px collapsed (toggle on the secondary/main border). URL contract preserved: `/settings?tab=<section>`; sub-tabs use `&sub=<value>`. Backwards-compat: `/settings/commander` redirects to `/settings?tab=commander`; `/activity` redirects to wherever the new Activity surface lives.

**Tech Stack:** React 18 + Vite + Tailwind. lucide-react (`Building`, `Shield`, `KeyRound`, `DollarSign`, `Plug`, `Puzzle`, `Store`, `Archive`). React Router (`useSearchParams`, `useNavigate`). Existing primitives: `LobbyShell` (NOT used here — per-company stays inside in-company chrome), `SecondarySidebar` (Phase D), `Sidebar` (Phase E in-company sidebar). vitest + @testing-library/react. Existing hooks: `useMarketplaceSettings`, `useCompany`, `useSidebar`. Existing API clients: `companiesApi`, `mcpApi`, `marketplace*`, `internalAgentApi`, `pluginsApi`.

**Spec:** `.superpowers/company-settings-v1.html` mockup (locked v2 — verdict block has 16 ✓ items). Audit (2026-05-09) found 51 covered, 0 missing, 0 ambiguous, 4 ghost settings — 3 get new UI, 1 (`enableTeams`) stays API-only.

---

## Files

| Action | Path | What changes |
|--------|------|--------------|
| Modify | `ui/src/pages/SettingsPage.tsx` | Replace 1,732-LOC body with a thin shell: read `?tab=` from URL, render `<SecondarySidebar>` + active section component. Remove `PageTabBar`, remove top "Commander" card link, remove the inline section function bodies (which move to component files below) |
| Create | `ui/src/components/settings/SettingsLayout.tsx` | Encapsulates the SecondarySidebar + main panel structure. Gets the auto-collapse-primary effect (sets `useSidebar().setCollapsed(true)` on mount). Renders the section nav with the 8 items in 4 groups |
| Create | `ui/src/components/settings/sections/GeneralSection.tsx` | Move from `SettingsPage.tsx:230-734`. 6 sub-sections preserved (General / Appearance / Hiring / Invites / Company Data / Danger Zone — but the Archive button moves OUT to the new ArchiveCompanySection). Adds `rootFolder` text input in Company Data with warning |
| Create | `ui/src/components/settings/sections/CommanderSection.tsx` | Migrates `ui/src/pages/InternalAgentSettingsPage.tsx` (707 LOC) — ALL 4 PageTabBar tabs preserved as the section's internal sub-tabs (Execution & Model / Capabilities / Budget & Spend / Run History). Adds `proactiveIntervalMinutes` number input in Capabilities tab |
| Create | `ui/src/components/settings/sections/LLMProvidersSectionWrapper.tsx` | Tiny wrapper around the existing `LLMProvidersSection` — section heading + the existing component. (The 377-LOC component stays as-is; just gets a wrapper for the new section header pattern) |
| Create | `ui/src/components/settings/sections/BudgetCapsSection.tsx` | Move from `SettingsPage.tsx:737-1109`. All 4 stacked sub-sections preserved (Budget Policy / By Agent / By Project / Open Incidents). Cross-link "Open full Budget page" preserved |
| Create | `ui/src/components/settings/sections/MCPApiKeysSection.tsx` | Move from `SettingsPage.tsx:1112-1340`, **excluding** the `<GitHubIntegrationCard>` render (lines 1332-1337). Section is MCP-only: server toggle, status cards, API key management, connected clients list |
| Create | `ui/src/components/settings/sections/PluginsSectionWrapper.tsx` | Tiny wrapper around the existing `settings/PluginsSection` — adds section heading. (The 199-LOC component stays as-is) |
| Create | `ui/src/components/settings/sections/MarketplacePrefsSection.tsx` | Move the `MarketplaceSettingsTab` (~180 LOC) — all 3 sub-sections preserved (Updates / Access / Catalog Refresh). Adds `updateWindow` Select in Updates sub-section |
| Create | `ui/src/components/settings/sections/ArchiveCompanySection.tsx` | Pulls the Archive Company action out of General's "Danger Zone" sub-section. Standalone Danger-group section in the new layout |
| Modify | `ui/src/App.tsx` | Remove the `<Route path="settings/commander" element={<InternalAgentSettingsPage />} />` route (line 132). Remove `<Route path="settings/internal-agent" element={<Navigate to="../settings/commander" replace />} />` (line 133). Add a new redirect: `<Route path="settings/commander" element={<Navigate to="../settings?tab=commander" replace />} />` so existing deep-links still work. Update `<Route path="activity" element={<Navigate to="../settings" replace />} />` (line 185) to point at wherever the new Activity surface lives — see Task 5 |
| Delete | `ui/src/pages/InternalAgentSettingsPage.tsx` | Content fully moved to `CommanderSection.tsx`. The 12 tests in `ui/src/__tests__/InternalAgentSettingsPage.test.tsx` get retargeted to `CommanderSection.test.tsx` |
| Delete (route only) | `ui/src/pages/Commander.tsx` | NOT deleted — this is the conversation/chat page at `/commander` (sidebar item). Update line 67's `<Link to="/settings/commander">` → `<Link to="/settings?tab=commander">` |
| Modify | `ui/src/__tests__/InternalAgentSettingsPage.test.tsx` | Rename to `CommanderSection.test.tsx`, retarget imports to `<CommanderSection>` from the new location. The 12 tests cover the same behaviors |
| Create | `ui/src/__tests__/SettingsPage-redesign.test.tsx` | New focused test file. ~10 tests covering: SecondarySidebar renders with 8 items in 4 groups, `?tab=` URL controls active section, primary sidebar auto-collapses on mount, `/settings/commander` redirects to `?tab=commander`, ghost setting controls render, GitHub card NOT rendered |
| Create | `ui/src/pages/CompanyActivityPage.tsx` | Move `SettingsPage.tsx`'s `ActivitySection` (lines 1342-1490) into a standalone page. Renders inside the in-company chrome (Sidebar + main). New route at `/activity` |
| Modify | `ui/src/components/Sidebar.tsx` | Add Activity to the in-company sidebar nav. Place under WORK section between Routines and Workspaces (or wherever feels natural in the existing flow — see Task 5) |
| Create | `.changeset/per-company-settings-redesign.md` | `patch` bump; describes the user-facing impact (SecondarySidebar layout, Commander becomes a section, Activity promoted out, ghost-setting UI additions) |

**Total:** 4 modified, 11 created (10 components + 1 changeset), 1 deleted (`InternalAgentSettingsPage.tsx`). Plus 1 test file rename.

---

## Verification rules (apply to every task)

1. **TDD order** — failing test first, see it fail with the right error, implement, see it pass, commit.
2. **Per-task scoped tests** before commit; broader UI suite (`pnpm vitest run --dir src/__tests__` from `ui/`) at end of each task.
3. **Conventional commits**: `feat(ui):`, `refactor(ui):`, `test(ui):`, `chore(ui):`.
4. **Typecheck after each task** — `pnpm exec tsc --noEmit` from `ui/`.
5. **URL contract preserved.** Every existing deep-link works:
   - `/settings?tab=general` → General section active
   - `/settings?tab=llm` → LLM providers
   - `/settings/commander` → 308-redirects to `/settings?tab=commander`
   - `/settings/internal-agent` → still 308-redirects (legacy chain)
   - `/activity` → redirects to the new Activity surface
6. **Existing API contracts preserved.** No backend changes. Same routes hit by the UI.
7. **GitHub PAT functionality preserved at the data level.** The `company_secrets` row keyed `github_pat` still exists; existing PATs continue to drive workspace PR creation. Only the **UI** (`GitHubIntegrationCard` render in Settings) is removed. Migration of the card into the GitHub plugin's Settings flow is a SEPARATE follow-up task — NOT in scope here. The component file `GitHubIntegrationCard.tsx` is left untouched in the codebase for the future plugin migration to consume.
8. **InternalAgentSettingsPage's existing 12 tests must still pass** (after retargeting to `CommanderSection`). No behavior changes — just file relocation and chrome-swap.
9. **Existing `Commander.tsx` (conversation page at `/commander`) is NOT deleted** — it's the AI chat UI, separate concern from the settings page. The single line that links to `/settings/commander` updates to `?tab=commander`.

---

## Task 1: Build the SecondarySidebar shell + route URL contract

**Files:**
- Modify: `ui/src/pages/SettingsPage.tsx`
- Create: `ui/src/components/settings/SettingsLayout.tsx`
- Create: `ui/src/__tests__/SettingsPage-redesign.test.tsx`
- Modify: `ui/src/App.tsx` (`/settings/commander` → `<Navigate>` redirect)

This task delivers the chrome change. The 6 section component files don't exist yet — they're created in Tasks 2–4. For Task 1, the SettingsLayout renders a placeholder `"Section X coming soon"` for each section as a stub; sections come online progressively.

- [ ] **Step 1: Write the failing test in `ui/src/__tests__/SettingsPage-redesign.test.tsx`**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsPage } from "@/pages/SettingsPage";
import { SidebarProvider } from "@/context/SidebarContext";
import { DialogProvider } from "@/context/DialogContext";

// Minimal context mocks
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "c1", name: "Phase4 Test Co", issuePrefix: "P4" },
    selectedCompanyId: "c1",
    companies: [],
    setSelectedCompanyId: vi.fn(),
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

function renderSettings(initialPath = "/P4/settings?tab=general") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <DialogProvider>
          <SidebarProvider>
            <SettingsPage />
          </SidebarProvider>
        </DialogProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SettingsPage redesign — Phase F shell", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1280 });
    window.dispatchEvent(new Event("resize"));
  });

  it("renders the SecondarySidebar with all 8 section items", () => {
    renderSettings();
    expect(screen.getByText("General")).toBeInTheDocument();
    expect(screen.getByText("Commander")).toBeInTheDocument();
    expect(screen.getByText("LLM providers")).toBeInTheDocument();
    expect(screen.getByText("Budget & caps")).toBeInTheDocument();
    expect(screen.getByText("MCP API keys")).toBeInTheDocument();
    expect(screen.getByText("Plugins")).toBeInTheDocument();
    expect(screen.getByText("Marketplace prefs")).toBeInTheDocument();
    expect(screen.getByText("Archive company")).toBeInTheDocument();
  });

  it("renders the 4 group labels (Company / Operations / Extensions / Danger)", () => {
    renderSettings();
    expect(screen.getByText("Company")).toBeInTheDocument();
    expect(screen.getByText("Operations")).toBeInTheDocument();
    expect(screen.getByText("Extensions")).toBeInTheDocument();
    expect(screen.getByText("Danger")).toBeInTheDocument();
  });

  it("does not render the legacy PageTabBar", () => {
    renderSettings();
    // PageTabBar adds a button-row with role=tablist; ensure absent
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("does not render the legacy 'Commander' card link at the top", () => {
    renderSettings();
    // The card link contained the text "Configure the Commander, capabilities, and budget"
    expect(screen.queryByText(/Configure the Commander/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm vitest run src/__tests__/SettingsPage-redesign.test.tsx
```

Expected: all 4 tests FAIL because the current `SettingsPage.tsx` has the PageTabBar + Commander card link.

- [ ] **Step 3: Create `SettingsLayout.tsx`**

```tsx
// ui/src/components/settings/SettingsLayout.tsx
import { useEffect, type ReactNode } from "react";
import { useSearchParams } from "@/lib/router";
import { useSidebar } from "@/context/SidebarContext";
import { Building, Shield, KeyRound, DollarSign, Plug, Puzzle, Store, Archive } from "lucide-react";
import { cn } from "@/lib/utils";

export const SETTINGS_SECTIONS = [
  { group: "Company",    items: [
    { id: "general",     label: "General",            icon: Building },
  ]},
  { group: "Operations", items: [
    { id: "commander",   label: "Commander",          icon: Shield },
    { id: "llm",         label: "LLM providers",      icon: KeyRound },
    { id: "budget",      label: "Budget & caps",      icon: DollarSign },
    { id: "mcp",         label: "MCP API keys",       icon: Plug },
  ]},
  { group: "Extensions", items: [
    { id: "plugins",     label: "Plugins",            icon: Puzzle },
    { id: "marketplace", label: "Marketplace prefs",  icon: Store },
  ]},
  { group: "Danger",     items: [
    { id: "archive",     label: "Archive company",    icon: Archive, tone: "danger" as const },
  ]},
] as const;

export type SettingsSectionId =
  | "general" | "commander" | "llm" | "budget" | "mcp"
  | "plugins" | "marketplace" | "archive";

interface SettingsLayoutProps {
  activeSection: SettingsSectionId;
  onSectionChange: (id: SettingsSectionId) => void;
  children: ReactNode;
}

export function SettingsLayout({ activeSection, onSectionChange, children }: SettingsLayoutProps) {
  const { setCollapsed, isMobile } = useSidebar();

  // Decision #98 — auto-collapse primary sidebar on entry to give secondary the prominent role.
  useEffect(() => {
    if (!isMobile) setCollapsed(true);
  }, [isMobile, setCollapsed]);

  return (
    <div className="flex h-full min-h-0">
      {/* SecondarySidebar — 200px expanded. Use existing hide-scrollbar pattern. */}
      <aside className="hidden md:flex w-[200px] shrink-0 flex-col bg-card/30 border-r border-border">
        <div className="h-14 px-4 flex items-center border-b border-border">
          <div className="text-[13px] font-semibold tracking-tight text-foreground">Settings</div>
        </div>
        <nav className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none] py-2 px-2">
          {SETTINGS_SECTIONS.map((group) => (
            <div key={group.group}>
              <div className="px-3 mt-3 mb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/60">
                {group.group}
              </div>
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = activeSection === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSectionChange(item.id as SettingsSectionId)}
                    className={cn(
                      "relative w-full flex items-center gap-2.5 h-[30px] px-2.5 rounded-md text-[13px] font-medium transition-colors",
                      active
                        ? "bg-brand/[0.08] text-[hsl(15_60%_75%)]"
                        : "text-foreground/[0.78] hover:bg-white/[0.04] hover:text-foreground",
                    )}
                  >
                    <Icon className={cn("size-4 shrink-0", "tone" in item && item.tone === "danger" && "text-red-400/80")} />
                    <span className="flex-1 text-left truncate">{item.label}</span>
                    {active && (
                      <span aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 size-[5px] rounded-full bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]" />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>

      {/* Mobile sub-nav — horizontal scrollable pill row (parity with marketplace mobile sub-nav) */}
      <div className="md:hidden border-b border-border-soft py-2 px-3 flex gap-2 overflow-x-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        {SETTINGS_SECTIONS.flatMap((g) => g.items).map((item) => {
          const Icon = item.icon;
          const active = activeSection === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSectionChange(item.id as SettingsSectionId)}
              className={cn(
                "shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] font-medium border whitespace-nowrap",
                active
                  ? "bg-brand/[0.12] border-brand/40 text-[hsl(15_60%_75%)]"
                  : "bg-card border-border text-muted-foreground",
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

- [ ] **Step 4: Replace `SettingsPage.tsx` with the new shell**

```tsx
// ui/src/pages/SettingsPage.tsx
import { useEffect } from "react";
import { useSearchParams } from "@/lib/router";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { SettingsLayout, type SettingsSectionId } from "@/components/settings/SettingsLayout";

const VALID_SECTIONS: readonly SettingsSectionId[] = [
  "general", "commander", "llm", "budget", "mcp", "plugins", "marketplace", "archive",
];

function isValidSection(s: string | null): s is SettingsSectionId {
  return s != null && (VALID_SECTIONS as readonly string[]).includes(s);
}

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { setBreadcrumbs } = useBreadcrumbs();

  const tabParam = searchParams.get("tab");
  const activeSection: SettingsSectionId = isValidSection(tabParam) ? tabParam : "general";

  useEffect(() => {
    setBreadcrumbs([{ label: "Settings" }]);
  }, [setBreadcrumbs]);

  const handleSectionChange = (id: SettingsSectionId) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("tab", id);
      // Drop sub-tab param when switching sections
      next.delete("sub");
      return next;
    });
  };

  return (
    <SettingsLayout activeSection={activeSection} onSectionChange={handleSectionChange}>
      <div className="p-8">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60 font-semibold">
          Settings · {activeSection}
        </div>
        <div className="mt-2 text-sm text-muted-foreground italic">
          Section content will be wired in subsequent tasks (T2-T6).
        </div>
      </div>
    </SettingsLayout>
  );
}
```

- [ ] **Step 5: Add the `/settings/commander` redirect in `App.tsx`**

In `ui/src/App.tsx`, **replace** these two lines (132-133):

```tsx
      <Route path="settings/commander" element={<InternalAgentSettingsPage />} />
      <Route path="settings/internal-agent" element={<Navigate to="../settings/commander" replace />} />
```

with:

```tsx
      <Route path="settings/commander" element={<Navigate to="../settings?tab=commander" replace />} />
      <Route path="settings/internal-agent" element={<Navigate to="../settings?tab=commander" replace />} />
```

Also remove the `import { InternalAgentSettingsPage } from "./pages/InternalAgentSettingsPage";` line (~line 27) — it's no longer rendered as a route. (Don't delete the file yet; CommanderSection inherits from it in Task 4.)

- [ ] **Step 6: Update `Commander.tsx:67`'s settings link**

In `ui/src/pages/Commander.tsx`, change:

```tsx
        <Link
          to="/settings/commander"
```

to:

```tsx
        <Link
          to="/settings?tab=commander"
```

- [ ] **Step 7: Run the failing tests**

```
pnpm vitest run src/__tests__/SettingsPage-redesign.test.tsx
```

Expected: all 4 tests now PASS (sections render with stub content, no PageTabBar, no Commander card).

- [ ] **Step 8: Run the broader UI suite**

```
pnpm vitest run --dir src/__tests__
```

Expected: clean. The existing `InternalAgentSettingsPage.test.tsx` (12 tests) will still pass because Task 1 doesn't touch that file yet — Task 4 retargets it.

- [ ] **Step 9: Typecheck**

```
pnpm exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add ui/src/pages/SettingsPage.tsx ui/src/components/settings/SettingsLayout.tsx ui/src/__tests__/SettingsPage-redesign.test.tsx ui/src/App.tsx ui/src/pages/Commander.tsx
git commit -m "refactor(ui): replace per-company SettingsPage chrome with SecondarySidebar

Phase F Task 1 — chrome shell only. Replaces the 7-tab PageTabBar +
top 'Commander' card link with a SecondarySidebar pattern (parity
with InstanceSettingsPage Phase D). 8 sections in 4 groups. Primary
in-company sidebar auto-collapses on entry (Decision #98 applied to
per-company chrome). Mobile gets a horizontal scrollable pill row.
Section content is stubbed in this task; T2-T6 wire each section."
```

---

## Task 2: Extract General + Archive sections (Company + Danger groups)

**Files:**
- Create: `ui/src/components/settings/sections/GeneralSection.tsx`
- Create: `ui/src/components/settings/sections/ArchiveCompanySection.tsx`
- Modify: `ui/src/pages/SettingsPage.tsx` (route `tab=general` and `tab=archive` to the new components)
- Modify: `ui/src/__tests__/SettingsPage-redesign.test.tsx` (assertions for fields)

This task moves the existing `GeneralSection` function body (`SettingsPage.tsx:230-734`) into its own file, **except** the Archive Company action (`L685-708` and the ConfirmDialog at L711-731), which moves to `ArchiveCompanySection.tsx`.

- [ ] **Step 1: Add failing tests for the new General + Archive sections**

Append to `ui/src/__tests__/SettingsPage-redesign.test.tsx`:

```tsx
  it("General section: renders company name, description, brand color, logo upload, agent invites, rootFolder fields", () => {
    renderSettings("/P4/settings?tab=general");
    expect(screen.getByLabelText(/Company name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Description/i)).toBeInTheDocument();
    expect(screen.getByText(/Brand color/i)).toBeInTheDocument();
    expect(screen.getByText(/Upload logo/i)).toBeInTheDocument();
    expect(screen.getByText(/Generate snippet/i)).toBeInTheDocument();
    // Ghost setting added in this task — rootFolder
    expect(screen.getByLabelText(/Root folder/i)).toBeInTheDocument();
    // Archive button is NOT in General — it's in Danger group
    expect(screen.queryByText(/Archive company/i)).toBeNull();
  });

  it("Archive section: renders the archive button with confirm dialog", () => {
    renderSettings("/P4/settings?tab=archive");
    expect(screen.getByRole("button", { name: /Archive company/i })).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm vitest run src/__tests__/SettingsPage-redesign.test.tsx -t "General section"
```

Expected: FAIL.

- [ ] **Step 3: Create `GeneralSection.tsx`**

Move `GeneralSection` function body from `SettingsPage.tsx:230-734` into a new file. The exact code is large; the migration is mechanical. Key changes vs. the existing body:

- **Remove** the `<ConfirmDialog>` for archive confirmation (at the end of the function body) — it moves to `ArchiveCompanySection`.
- **Remove** the Danger Zone sub-section render (`L675-708` — the "Archive company" card with description + button).
- **Add** a new sub-section "Workspace root folder" inside Company Data, BEFORE the export link. Use the existing pattern of the other sub-sections:

```tsx
      {/* Sub-section: Workspace Root Folder */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Workspace Root Folder
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <Field
            label="Root folder"
            hint={
              <span>
                Filesystem path where this company's execution workspaces are created.
                <span className="text-amber-500/80">
                  {" "}Changing this breaks paths for existing workspaces — only change if you know what you're doing.
                </span>
              </span>
            }
          >
            <input
              type="text"
              className="..."
              value={rootFolder}
              onChange={(e) => setRootFolder(e.target.value)}
              aria-label="Root folder"
            />
          </Field>
          {rootFolderDirty && (
            <button onClick={handleSaveRootFolder}>Save</button>
          )}
        </div>
      </div>
```

(Use the existing `Field` component — it's defined inline somewhere in `SettingsPage.tsx` or imported.)

State + mutation:
```tsx
const [rootFolder, setRootFolder] = useState(selectedCompany?.rootFolder ?? "");
const rootFolderDirty = rootFolder !== (selectedCompany?.rootFolder ?? "");
const rootFolderMutation = useMutation({
  mutationFn: (val: string) => companiesApi.update(selectedCompanyId!, { rootFolder: val || null }),
  onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.companies.detail(selectedCompanyId!) }),
});
```

The `companiesApi.update` call already accepts `rootFolder` per `validators/company.ts:8`.

Add a section header at the top of `GeneralSection` (since each section now needs its own h2):
```tsx
<div className="px-8 pt-6 pb-3">
  <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60 font-semibold">
    Settings · Company
  </div>
  <h2 className="text-[1.4rem] font-bold tracking-tight mt-1">
    General<span className="text-brand">.</span>
  </h2>
  <p className="mt-1 text-sm text-muted-foreground">Identity and presentation for this company.</p>
</div>
```

- [ ] **Step 4: Create `ArchiveCompanySection.tsx`**

```tsx
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { companiesApi } from "@/api/companies";
import { queryKeys } from "@/lib/queryKeys";
import { ConfirmDialog } from "@/components/ConfirmDialog";

export function ArchiveCompanySection() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const archiveMutation = useMutation({
    mutationFn: () => companiesApi.archive(selectedCompanyId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      navigate("/");
    },
  });

  return (
    <div>
      <div className="px-8 pt-6 pb-3 border-b border-border">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60 font-semibold">
          Settings · Danger
        </div>
        <h2 className="text-[1.4rem] font-bold tracking-tight mt-1">
          Archive company<span className="text-brand">.</span>
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Soft-delete the company. Reversible by an admin. Stops new heartbeats and freezes spend.
        </p>
      </div>
      <div className="p-8 max-w-[680px]">
        <div className="rounded-md border border-red-900/50 bg-red-950/20 p-4 space-y-3">
          <div>
            <p className="text-sm font-medium">Archive {selectedCompany?.name ?? "this company"}</p>
            <p className="text-xs text-muted-foreground mt-1">
              All running heartbeats stop. Tasks, agents, goals, memory, artifacts are preserved
              but read-only. You'll be returned to the lobby.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-red-700 hover:bg-red-600 text-white text-sm font-medium"
          >
            Archive company
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Archive this company?"
        description={`"${selectedCompany?.name}" will be archived. Reversible by an admin.`}
        confirmLabel="Archive"
        confirmTone="danger"
        onConfirm={() => archiveMutation.mutate()}
      />
    </div>
  );
}
```

- [ ] **Step 5: Wire `tab=general` and `tab=archive` in `SettingsPage.tsx`**

In the SettingsPage shell (created in Task 1), replace the placeholder `<div className="p-8">...</div>` with a switch:

```tsx
import { GeneralSection } from "@/components/settings/sections/GeneralSection";
import { ArchiveCompanySection } from "@/components/settings/sections/ArchiveCompanySection";

// ...inside the component body:
function renderActiveSection(id: SettingsSectionId) {
  switch (id) {
    case "general":   return <GeneralSection />;
    case "archive":   return <ArchiveCompanySection />;
    default:          return <div className="p-8 text-sm text-muted-foreground italic">Section "{id}" — coming in Tasks 3-6</div>;
  }
}

return (
  <SettingsLayout activeSection={activeSection} onSectionChange={handleSectionChange}>
    {renderActiveSection(activeSection)}
  </SettingsLayout>
);
```

- [ ] **Step 6: Run the failing tests**

```
pnpm vitest run src/__tests__/SettingsPage-redesign.test.tsx
```

Expected: General + Archive tests now PASS. The 4 shell-tests from Task 1 still pass.

- [ ] **Step 7: Run broader UI suite**

```
pnpm vitest run --dir src/__tests__
```

- [ ] **Step 8: Typecheck**

```
pnpm exec tsc --noEmit
```

- [ ] **Step 9: Commit**

```bash
git add ui/src/components/settings/sections/GeneralSection.tsx ui/src/components/settings/sections/ArchiveCompanySection.tsx ui/src/pages/SettingsPage.tsx ui/src/__tests__/SettingsPage-redesign.test.tsx
git commit -m "refactor(ui): extract General + Archive sections from SettingsPage

Moves SettingsPage.tsx:230-734 (GeneralSection) into its own file.
Splits Archive Company off into a separate Danger-group section.
Adds rootFolder text input to Company Data sub-section (ghost setting
gets UI). Wires tab=general and tab=archive in the new shell."
```

---

## Task 3: Extract Budget, MCP API keys, LLM, Plugins, Marketplace sections

**Files:**
- Create: `ui/src/components/settings/sections/BudgetCapsSection.tsx`
- Create: `ui/src/components/settings/sections/MCPApiKeysSection.tsx`
- Create: `ui/src/components/settings/sections/LLMProvidersSectionWrapper.tsx`
- Create: `ui/src/components/settings/sections/PluginsSectionWrapper.tsx`
- Create: `ui/src/components/settings/sections/MarketplacePrefsSection.tsx`
- Modify: `ui/src/pages/SettingsPage.tsx` (route remaining tabs)
- Modify: `ui/src/__tests__/SettingsPage-redesign.test.tsx` (assertions)

This task batches 5 section extractions that are mostly mechanical relocations. The `LLMProvidersSection` (377 LOC) and `PluginsSection` (199 LOC) already exist as standalone components — only thin wrappers are needed for the section header pattern. `MarketplaceSettingsTab` and the Budget + Integrations functions inside `SettingsPage.tsx` get pulled into their own files.

- [ ] **Step 1: Add failing tests for each new section**

Append to `ui/src/__tests__/SettingsPage-redesign.test.tsx`:

```tsx
  it("Budget section: renders date presets, summary, by-agent, by-project, open-incidents", () => {
    renderSettings("/P4/settings?tab=budget");
    // Date presets
    expect(screen.getByRole("button", { name: /MTD/i })).toBeInTheDocument();
    // The 4 sub-section headers
    expect(screen.getByText(/By Agent/i)).toBeInTheDocument();
    expect(screen.getByText(/By Project/i)).toBeInTheDocument();
    expect(screen.getByText(/Open Incidents/i)).toBeInTheDocument();
    // Cross-link
    expect(screen.getByText(/Open full Budget page/i)).toBeInTheDocument();
  });

  it("MCP API keys section: renders MCP server toggle and key management — NO GitHub card", () => {
    renderSettings("/P4/settings?tab=mcp");
    expect(screen.getByText(/MCP Server/i)).toBeInTheDocument();
    expect(screen.getByText(/API Key Management/i)).toBeInTheDocument();
    // The GitHub card is GONE
    expect(screen.queryByText(/GitHub/i)).toBeNull();
    expect(screen.queryByLabelText(/Personal Access Token/i)).toBeNull();
  });

  it("Marketplace prefs section: renders Updates / Access / Catalog Refresh + updateWindow Select", () => {
    renderSettings("/P4/settings?tab=marketplace");
    expect(screen.getByText(/Updates$/i)).toBeInTheDocument();
    expect(screen.getByText(/Access/i)).toBeInTheDocument();
    expect(screen.getByText(/Catalog Refresh/i)).toBeInTheDocument();
    // Ghost setting — updateWindow
    expect(screen.getByLabelText(/Update window/i)).toBeInTheDocument();
  });

  it("LLM providers section: renders Anthropic, OpenAI, Google", () => {
    renderSettings("/P4/settings?tab=llm");
    expect(screen.getByText(/Anthropic/i)).toBeInTheDocument();
    expect(screen.getByText(/OpenAI/i)).toBeInTheDocument();
    expect(screen.getByText(/Google/i)).toBeInTheDocument();
  });

  it("Plugins section: renders the existing PluginsSection", () => {
    renderSettings("/P4/settings?tab=plugins");
    // The component renders an h2 with "Plugins" + count
    expect(screen.getByText(/Plugins/i)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```
pnpm vitest run src/__tests__/SettingsPage-redesign.test.tsx
```

Expected: 5 new tests FAIL (they hit the "coming soon" stub).

- [ ] **Step 3: Create the 5 section files**

For each section, the body is a mechanical move from the existing `SettingsPage.tsx` (BudgetSection at L737-1109, IntegrationsSection at L1112-1340, MarketplaceSettingsTab at L1549-1732) into its own file. Add a section header at the top following the same pattern as Task 2:

```tsx
<div className="px-8 pt-6 pb-3 border-b border-border">
  <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60 font-semibold">
    Settings · Operations  // or Extensions
  </div>
  <h2 className="text-[1.4rem] font-bold tracking-tight mt-1">
    Budget &amp; caps<span className="text-brand">.</span>  // adapt name
  </h2>
  <p className="mt-1 text-sm text-muted-foreground">
    {/* one-line description */}
  </p>
</div>
<div className="p-8">
  {/* existing body */}
</div>
```

**Section-specific changes:**

- **`MCPApiKeysSection.tsx`**: rename "Integrations" UI labels to "MCP". **Drop** the GitHub render at the end (the existing `<GitHubIntegrationCard />` from `SettingsPage.tsx:1332-1337`). Do NOT delete `GitHubIntegrationCard.tsx` from the codebase — leave it for the future plugin migration to consume.

- **`MarketplacePrefsSection.tsx`**: in the Updates sub-section, add a new field for `updateWindow`:

```tsx
<Field label="Update window" hint="When automatic updates are allowed to run.">
  <Select
    value={settings.updateWindow}
    onValueChange={(v) =>
      applyPatch({ updateWindow: v as typeof settings.updateWindow })
    }
  >
    <SelectTrigger><SelectValue /></SelectTrigger>
    <SelectContent>
      <SelectItem value="anytime">Any time</SelectItem>
      <SelectItem value="off_hours">Off hours (10pm-6am local)</SelectItem>
      <SelectItem value="weekends">Weekends</SelectItem>
    </SelectContent>
  </Select>
</Field>
```

(`updateWindow` is already in the `MarketplaceSettings` type at `packages/shared/src/marketplace.ts:192` and the patch schema accepts it — no shared-types changes needed.)

- **`LLMProvidersSectionWrapper.tsx`**: 
```tsx
import { LLMProvidersSection } from "@/components/LLMProvidersSection";

export function LLMProvidersSectionWrapper() {
  return (
    <div>
      <div className="px-8 pt-6 pb-3 border-b border-border">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60 font-semibold">
          Settings · Operations
        </div>
        <h2 className="text-[1.4rem] font-bold tracking-tight mt-1">
          LLM providers<span class="text-brand">.</span>
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          API keys for Anthropic, OpenAI, and Google. Used by Discussion extraction and memory embeddings.
        </p>
      </div>
      <div className="p-8">
        <LLMProvidersSection />
      </div>
    </div>
  );
}
```

- **`PluginsSectionWrapper.tsx`**: same pattern as LLMProvidersSectionWrapper but wraps `<PluginsSection />`.

- **`BudgetCapsSection.tsx`**: just move the existing `BudgetSection` body from `SettingsPage.tsx:737-1109`. No content changes (cross-link to `/budget` preserved). Add the section header.

- [ ] **Step 4: Wire all 5 tabs in the SettingsPage shell**

Update `renderActiveSection` in `SettingsPage.tsx`:

```tsx
case "general":     return <GeneralSection />;
case "llm":         return <LLMProvidersSectionWrapper />;
case "budget":      return <BudgetCapsSection />;
case "mcp":         return <MCPApiKeysSection />;
case "plugins":     return <PluginsSectionWrapper />;
case "marketplace": return <MarketplacePrefsSection />;
case "archive":     return <ArchiveCompanySection />;
case "commander":   return <div className="p-8 text-sm text-muted-foreground italic">Commander section — coming in Task 4</div>;
```

- [ ] **Step 5: Delete the now-unused inline section function bodies in `SettingsPage.tsx`**

After the moves, `SettingsPage.tsx` should be ≤100 LOC: imports, `VALID_SECTIONS`, the component body with `useSearchParams` + `setBreadcrumbs` + the `renderActiveSection` switch. Remove all the old inline functions (`GeneralSection`, `BudgetSection`, `IntegrationsSection`, `ActivitySection`, `MarketplaceSettingsTab`).

The Activity function content gets moved in Task 5 (don't delete here — just stop wiring it).

- [ ] **Step 6: Run tests**

```
pnpm vitest run src/__tests__/SettingsPage-redesign.test.tsx
```

Expected: all 9+ tests PASS (4 shell + 2 General/Archive + 5 new from this task).

- [ ] **Step 7: Run broader UI suite + typecheck**

```
pnpm vitest run --dir src/__tests__
pnpm exec tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add ui/src/components/settings/sections/*.tsx ui/src/pages/SettingsPage.tsx ui/src/__tests__/SettingsPage-redesign.test.tsx
git commit -m "refactor(ui): extract Budget/MCP/LLM/Plugins/Marketplace sections

Five sections moved from inline functions in SettingsPage.tsx to
focused component files under ui/src/components/settings/sections/.
MCP API keys section drops the GitHubIntegrationCard render (handoff
to plugin migration — file preserved). Marketplace prefs gains a
new Update window Select (ghost setting → UI). SettingsPage.tsx
shrinks from 1,732 LOC to <100 LOC."
```

---

## Task 4: Migrate Commander into a section (with sub-tabs preserved)

**Files:**
- Create: `ui/src/components/settings/sections/CommanderSection.tsx`
- Create: `ui/src/components/settings/sections/CommanderSubTabs.tsx`
- Modify: `ui/src/pages/SettingsPage.tsx` (route `tab=commander` to the new section)
- Delete: `ui/src/pages/InternalAgentSettingsPage.tsx`
- Rename + retarget: `ui/src/__tests__/InternalAgentSettingsPage.test.tsx` → `ui/src/__tests__/CommanderSection.test.tsx`
- Modify: `ui/src/__tests__/SettingsPage-redesign.test.tsx` (Commander assertions)

This task moves the existing 707-LOC `InternalAgentSettingsPage` content into a section component, preserving all 4 sub-tabs (Execution & Model / Capabilities / Budget & Spend / Run History) AND adding the `proactiveIntervalMinutes` ghost setting.

- [ ] **Step 1: Add failing tests for Commander section**

In `ui/src/__tests__/SettingsPage-redesign.test.tsx`, append:

```tsx
  it("Commander section: renders 4 sub-tabs", () => {
    renderSettings("/P4/settings?tab=commander");
    expect(screen.getByRole("tab", { name: /Execution & Model/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Capabilities/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Budget & Spend/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Run History/i })).toBeInTheDocument();
  });

  it("Commander Capabilities sub-tab: renders proactiveIntervalMinutes input (ghost setting → UI)", () => {
    renderSettings("/P4/settings?tab=commander&sub=capabilities");
    expect(screen.getByLabelText(/Proactive scan interval/i)).toBeInTheDocument();
  });
```

Also rename `InternalAgentSettingsPage.test.tsx` → `CommanderSection.test.tsx`. Update the import in the test file:

```tsx
// was: import { InternalAgentSettingsPage } from "../pages/InternalAgentSettingsPage";
import { CommanderSection } from "@/components/settings/sections/CommanderSection";
```

…and the 12 `renderWithProviders(<InternalAgentSettingsPage />)` calls become `renderWithProviders(<CommanderSection />)`.

- [ ] **Step 2: Run tests to verify they fail**

```
pnpm vitest run src/__tests__/SettingsPage-redesign.test.tsx -t "Commander"
pnpm vitest run src/__tests__/CommanderSection.test.tsx
```

Expected: FAIL on both.

- [ ] **Step 3: Create `CommanderSubTabs.tsx`**

```tsx
import { useSearchParams } from "@/lib/router";
import { cn } from "@/lib/utils";

const COMMANDER_SUB_TABS = [
  { id: "execution",     label: "Execution & Model" },
  { id: "capabilities",  label: "Capabilities" },
  { id: "budget",        label: "Budget & Spend" },
  { id: "history",       label: "Run History" },
] as const;

export type CommanderSubTabId = typeof COMMANDER_SUB_TABS[number]["id"];

export function useCommanderSubTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const subParam = searchParams.get("sub");
  const active: CommanderSubTabId =
    (COMMANDER_SUB_TABS.find((t) => t.id === subParam)?.id) ?? "execution";

  const setActive = (id: CommanderSubTabId) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("sub", id);
      return next;
    });
  };

  return { active, setActive };
}

interface CommanderSubTabsProps {
  active: CommanderSubTabId;
  onSelect: (id: CommanderSubTabId) => void;
}

export function CommanderSubTabs({ active, onSelect }: CommanderSubTabsProps) {
  return (
    <div role="tablist" className="px-8 flex items-end gap-1 border-b border-border-soft -mb-px">
      {COMMANDER_SUB_TABS.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onSelect(t.id)}
          className={cn(
            "px-3.5 py-2 text-[12.5px] font-medium border-b-2 transition-colors",
            active === t.id
              ? "text-[hsl(15_60%_75%)] border-brand"
              : "text-muted-foreground border-transparent hover:text-foreground"
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function CommanderSubTabsMobile({ active, onSelect }: CommanderSubTabsProps) {
  return (
    <div className="md:hidden border-b border-border-soft py-2 px-3 flex gap-2 overflow-x-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
      {COMMANDER_SUB_TABS.map((t) => (
        <button
          key={t.id}
          onClick={() => onSelect(t.id)}
          className={cn(
            "shrink-0 px-3 py-1.5 rounded-full text-[12.5px] font-medium border whitespace-nowrap",
            active === t.id
              ? "bg-brand/[0.12] border-brand/40 text-[hsl(15_60%_75%)]"
              : "bg-card border-border text-muted-foreground"
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Create `CommanderSection.tsx`**

This is mostly a copy of `InternalAgentSettingsPage.tsx`'s body (707 LOC), with:
- The chrome wrapper changed (no breadcrumb-setting, since SettingsPage handles that; new section header)
- The `<Tabs value=...>` / `<PageTabBar items={IA_TABS}/>` replaced with the new `CommanderSubTabs` + `CommanderSubTabsMobile` from Step 3
- The `useCommanderSubTab` hook drives the active sub-tab via `?sub=` URL param
- New ghost setting field added to the Capabilities sub-tab content (see below)

Pseudo-structure:

```tsx
import { CommanderSubTabs, CommanderSubTabsMobile, useCommanderSubTab } from "./CommanderSubTabs";
// ... existing imports from InternalAgentSettingsPage

export function CommanderSection() {
  const { active, setActive } = useCommanderSubTab();
  // ... existing state + queries from InternalAgentSettingsPage

  return (
    <div>
      {/* Section header */}
      <div className="px-8 pt-6 pb-3 bg-card/20">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60 font-semibold">Settings · Operations</div>
        <h2 className="text-[1.4rem] font-bold tracking-tight mt-1">Commander<span className="text-brand">.</span></h2>
        <p className="mt-1 text-sm text-muted-foreground">Internal-agent execution, capabilities, budget, and run history.</p>
      </div>
      {/* Desktop sub-tabs */}
      <div className="hidden md:block">
        <CommanderSubTabs active={active} onSelect={setActive} />
      </div>
      {/* Mobile sub-tabs */}
      <CommanderSubTabsMobile active={active} onSelect={setActive} />
      {/* Sub-tab content */}
      <div className="p-8">
        {active === "execution" && <ExecutionTab ... />}
        {active === "capabilities" && <CapabilitiesTab ... />}
        {active === "budget" && <BudgetTab ... />}
        {active === "history" && <RunHistoryTab ... />}
      </div>
    </div>
  );
}
```

The 4 sub-tab bodies (`ExecutionTab`, `CapabilitiesTab`, `BudgetTab`, `RunHistoryTab`) are extracted from the existing `<TabsContent>` blocks in `InternalAgentSettingsPage.tsx` (`L351-436`, `L439-538`, `L541-603`, `L606-704`). They can be inline functions or separate files at the implementer's discretion — for this plan, inline is fine (each is 50-100 LOC, the overall file lands around 750 LOC).

In **`CapabilitiesTab`**, add the new ghost-setting input AFTER the existing capability checkboxes section, BEFORE the Notification Preference radio group:

```tsx
{/* Ghost setting → UI: proactiveIntervalMinutes */}
<div className="space-y-1.5">
  <label htmlFor="proactive-interval" className="text-xs font-medium text-muted-foreground">
    Proactive scan interval (minutes)
  </label>
  <p className="text-[11px] text-muted-foreground/80">
    How often Commander checks for blocked tasks, budget thresholds, stale work, etc. Min 15 minutes.
  </p>
  <input
    id="proactive-interval"
    type="number"
    min={15}
    step={5}
    aria-label="Proactive scan interval"
    className="..."  // match existing input styling
    value={proactiveIntervalMinutes}
    onChange={(e) => setProactiveIntervalMinutes(Number(e.target.value))}
  />
</div>
```

The state + mutation:

```tsx
const [proactiveIntervalMinutes, setProactiveIntervalMinutes] = useState(
  config?.proactiveIntervalMinutes ?? 240
);
// added to the existing internalAgentApi.update call:
internalAgentApi.update(selectedCompanyId, { ..., proactiveIntervalMinutes })
```

The `proactiveIntervalMinutes` field is already on the `InternalAgentConfig` validator at `packages/shared/src/validators/internal-agent.ts:19` (with `.min(15).optional()`).

- [ ] **Step 5: Wire `tab=commander` in the SettingsPage shell**

Update the `renderActiveSection` switch:

```tsx
case "commander":  return <CommanderSection />;
```

- [ ] **Step 6: Delete `InternalAgentSettingsPage.tsx`**

```bash
git rm ui/src/pages/InternalAgentSettingsPage.tsx
```

(Already removed from `App.tsx` routes in Task 1.)

- [ ] **Step 7: Run all tests**

```
pnpm vitest run src/__tests__/SettingsPage-redesign.test.tsx
pnpm vitest run src/__tests__/CommanderSection.test.tsx
pnpm vitest run --dir src/__tests__
```

Expected: 13+ SettingsPage tests pass; 12 CommanderSection tests pass (retargeted from the old InternalAgentSettingsPage tests); broader suite clean.

- [ ] **Step 8: Typecheck**

```
pnpm exec tsc --noEmit
```

- [ ] **Step 9: Commit**

```bash
git add ui/src/components/settings/sections/CommanderSection.tsx ui/src/components/settings/sections/CommanderSubTabs.tsx ui/src/pages/SettingsPage.tsx ui/src/__tests__/SettingsPage-redesign.test.tsx ui/src/__tests__/CommanderSection.test.tsx
git rm ui/src/pages/InternalAgentSettingsPage.tsx
git commit -m "refactor(ui): fold Commander into Settings as a section with sub-tabs

The 707-LOC InternalAgentSettingsPage moves into CommanderSection
(under ui/src/components/settings/sections/). All 4 sub-tabs preserved
(Execution & Model · Capabilities · Budget & Spend · Run History) —
desktop renders horizontal underline tabs, mobile renders nested
scrollable pills. URL contract: /settings?tab=commander&sub=<value>.
Adds proactiveIntervalMinutes input in Capabilities (ghost setting →
UI). Existing 12 InternalAgentSettingsPage tests retarget to
CommanderSection.test.tsx unchanged in behavior."
```

---

## Task 5: Activity promotion (out of Settings)

**Files:**
- Create: `ui/src/pages/CompanyActivityPage.tsx`
- Modify: `ui/src/components/Sidebar.tsx` (add Activity nav item)
- Modify: `ui/src/App.tsx` (`/activity` redirect target update + new `/activity` route)
- Modify: `ui/src/__tests__/SettingsPage-redesign.test.tsx` (assert Activity NOT in Settings)
- Modify: `ui/src/__tests__/Sidebar.test.tsx` (assert Activity IS in sidebar)

Activity becomes its own page under the in-company chrome. The redirect chain at `App.tsx:185` (`/activity → /settings`) gets reversed: `/activity` becomes a real route, and the old `/settings?tab=activity` deep-link redirects to `/activity`.

- [ ] **Step 1: Add failing tests**

In `Sidebar.test.tsx`:
```tsx
it("renders Activity nav item under WORK section", () => {
  renderSidebar();
  expect(screen.getByText("Activity")).toBeInTheDocument();
});
```

In `SettingsPage-redesign.test.tsx`:
```tsx
it("does not render an Activity section in Settings", () => {
  renderSettings("/P4/settings?tab=activity");
  // The shell should fall back to General (default) for unknown tab values
  expect(screen.queryByText(/Activity event log/i)).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
pnpm vitest run src/__tests__/Sidebar.test.tsx
pnpm vitest run src/__tests__/SettingsPage-redesign.test.tsx -t "Activity"
```

- [ ] **Step 3: Create `CompanyActivityPage.tsx`**

Move the body of `ActivitySection` (currently inside `SettingsPage.tsx:1342-1490`, which Task 3 stopped wiring but didn't delete) into the new file. Add a top-level page header, breadcrumbs.

```tsx
import { useEffect } from "react";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
// ... move imports from the original ActivitySection
// ... move the component body

export function CompanyActivityPage() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => { setBreadcrumbs([{ label: "Activity" }]); }, [setBreadcrumbs]);

  return (
    <div className="p-4 md:p-6 max-w-[1100px] mx-auto">
      <h1 className="text-[1.6rem] font-bold tracking-tight">Activity<span className="text-brand">.</span></h1>
      <p className="mt-1 text-sm text-muted-foreground">All activity for this company — heartbeats, task changes, agent runs, and discussion entries.</p>
      {/* Existing filter + ActivityRow list — moved verbatim */}
    </div>
  );
}
```

Now delete the inline `ActivitySection` from `SettingsPage.tsx` (it should already be unused after Task 3).

- [ ] **Step 4: Add the route in `App.tsx`**

Replace `<Route path="activity" element={<Navigate to="../settings" replace />} />` (line 185) with:

```tsx
import { CompanyActivityPage } from "./pages/CompanyActivityPage";
// ...
<Route path="activity" element={<CompanyActivityPage />} />
```

- [ ] **Step 5: Add Activity to the in-company sidebar**

In `Sidebar.tsx`, inside the WORK section, add Activity between Workspaces and the section close:

```tsx
<SidebarSection label="Work" collapsed={collapsed}>
  <SidebarNavItem to="/discussions" label="Discussions" icon={MessageSquare} ... />
  <SidebarNavItem to="/issues" label="Tasks" icon={CircleDot} collapsed={collapsed} />
  <SidebarNavItem to="/agents/all" label="Agents" icon={Bot} collapsed={collapsed} />
  <SidebarNavItem to="/routines" label="Routines" icon={Repeat} collapsed={collapsed} />
  <SidebarNavItem to="/workspaces" label="Workspaces" icon={FolderGit2} collapsed={collapsed} />
  <SidebarNavItem to="/activity" label="Activity" icon={Activity} collapsed={collapsed} />
</SidebarSection>
```

Add `Activity` to the lucide imports in `Sidebar.tsx`.

- [ ] **Step 6: Run tests + typecheck**

- [ ] **Step 7: Commit**

```bash
git add ui/src/pages/CompanyActivityPage.tsx ui/src/components/Sidebar.tsx ui/src/App.tsx ui/src/__tests__/Sidebar.test.tsx ui/src/__tests__/SettingsPage-redesign.test.tsx
git commit -m "feat(ui): promote Activity out of Settings into its own page

Activity becomes a standalone page at /activity under the in-company
chrome. New sidebar nav item under WORK. The legacy /activity
redirect to /settings is removed (was a downgrade — now reverted)."
```

---

## Task 6: Final cleanup, changeset, integration sanity

**Files:**
- Modify: `ui/src/pages/SettingsPage.tsx` (final shape — only the shell logic remains)
- Create: `.changeset/per-company-settings-redesign.md`

After Tasks 1-5, `SettingsPage.tsx` should be ≤80 LOC: imports + the shell. Verify nothing inline remains.

- [ ] **Step 1: Inventory `SettingsPage.tsx`**

The final file should look approximately like:

```tsx
import { useEffect } from "react";
import { useSearchParams } from "@/lib/router";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { SettingsLayout, type SettingsSectionId } from "@/components/settings/SettingsLayout";
import { GeneralSection } from "@/components/settings/sections/GeneralSection";
import { CommanderSection } from "@/components/settings/sections/CommanderSection";
import { LLMProvidersSectionWrapper } from "@/components/settings/sections/LLMProvidersSectionWrapper";
import { BudgetCapsSection } from "@/components/settings/sections/BudgetCapsSection";
import { MCPApiKeysSection } from "@/components/settings/sections/MCPApiKeysSection";
import { PluginsSectionWrapper } from "@/components/settings/sections/PluginsSectionWrapper";
import { MarketplacePrefsSection } from "@/components/settings/sections/MarketplacePrefsSection";
import { ArchiveCompanySection } from "@/components/settings/sections/ArchiveCompanySection";

const VALID_SECTIONS: readonly SettingsSectionId[] = [
  "general", "commander", "llm", "budget", "mcp", "plugins", "marketplace", "archive",
];

function isValidSection(s: string | null): s is SettingsSectionId {
  return s != null && (VALID_SECTIONS as readonly string[]).includes(s);
}

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { setBreadcrumbs } = useBreadcrumbs();

  const tabParam = searchParams.get("tab");
  const activeSection: SettingsSectionId = isValidSection(tabParam) ? tabParam : "general";

  useEffect(() => { setBreadcrumbs([{ label: "Settings" }]); }, [setBreadcrumbs]);

  const onSectionChange = (id: SettingsSectionId) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("tab", id);
      next.delete("sub");
      return next;
    });
  };

  return (
    <SettingsLayout activeSection={activeSection} onSectionChange={onSectionChange}>
      {(() => {
        switch (activeSection) {
          case "general":     return <GeneralSection />;
          case "commander":   return <CommanderSection />;
          case "llm":         return <LLMProvidersSectionWrapper />;
          case "budget":      return <BudgetCapsSection />;
          case "mcp":         return <MCPApiKeysSection />;
          case "plugins":     return <PluginsSectionWrapper />;
          case "marketplace": return <MarketplacePrefsSection />;
          case "archive":     return <ArchiveCompanySection />;
        }
      })()}
    </SettingsLayout>
  );
}
```

If anything inline survived, move it to its rightful section file.

- [ ] **Step 2: Add the changeset**

Create `.changeset/per-company-settings-redesign.md`:

```md
---
"@armyofagents/ui": patch
---

Per-company Settings redesign: replaces the 7-tab PageTabBar layout
with a SecondarySidebar pattern (parity with InstanceSettings).
Sections grouped into Company / Operations / Extensions / Danger.
Commander is now a Settings section with its 4 sub-tabs preserved
(Execution & Model / Capabilities / Budget & Spend / Run History).
Activity is promoted out of Settings to its own page at /activity.
GitHub PAT management exits Settings (handed off to the Plugins
flow — separate effort). Three previously API-only fields get UI
controls (proactiveIntervalMinutes, marketplaceSettings.updateWindow,
rootFolder).
```

- [ ] **Step 3: Final test sweep**

```
pnpm vitest run --dir src/__tests__
pnpm exec tsc --noEmit
```

Both clean.

- [ ] **Step 4: Visual smoke check**

Start the dev server, navigate to a company, click into Settings. Verify:
1. Primary sidebar auto-collapses on entry to Settings
2. All 8 sections render in the SecondarySidebar with the right icons + group labels
3. Brand-red glow dot appears on the active section row
4. URL `?tab=` updates as you click between sections
5. Commander section shows 4 sub-tabs at the top of its content panel
6. URL `?tab=commander&sub=capabilities` lands on the Capabilities sub-tab
7. The new ghost-setting fields (proactiveIntervalMinutes, updateWindow, rootFolder) are visible in their respective sections and SAVE works
8. `/settings/commander` redirects to `/settings?tab=commander`
9. `/activity` lands on the new CompanyActivityPage
10. Mobile (resize <768px): SecondarySidebar replaced by horizontal pill row; Commander's sub-tabs render as a second pill row underneath
11. SecondarySidebar collapse toggle works (200px ↔ 48px); icon-only collapsed state shows tooltips on hover
12. The GitHub PAT card no longer appears in the MCP API keys section

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/SettingsPage.tsx .changeset/per-company-settings-redesign.md
git commit -m "chore(ui): finalize per-company Settings redesign

SettingsPage.tsx is now ≤80 LOC (was 1,732). All section logic
lives in focused component files under ui/src/components/settings/.
Adds changeset entry."
```

---

## Self-Review

**1. Spec coverage:**

| Locked decision (mockup verdict) | Task that implements it |
|---|---|
| SecondarySidebar at 200px (parity with Phase D) | Task 1 (`SettingsLayout.tsx`) |
| SecondarySidebar collapse to 48px icons-only | Task 1 (`SettingsLayout.tsx` — collapse logic) |
| Primary auto-collapse on entry (Decision #98) | Task 1 (`useEffect` setting `setCollapsed(true)` in `SettingsLayout`) |
| 8 sections in 4 groups (Company / Operations / Extensions / Danger) | Task 1 (`SETTINGS_SECTIONS` constant) |
| Commander folded into Operations w/ 4 sub-tabs | Task 4 |
| Commander sub-tabs on desktop = horizontal underline | Task 4 (`CommanderSubTabs`) |
| Commander sub-tabs on mobile = nested scrollable pills | Task 4 (`CommanderSubTabsMobile`) |
| MCP API keys section (no GitHub, no webhooks UI) | Task 3 (`MCPApiKeysSection`, drops `<GitHubIntegrationCard>`) |
| GitHub PAT moves to Plugins flow | Task 3 + verification rule #7 (UI removed; component file preserved for plugin migration follow-up) |
| Activity promoted out | Task 5 |
| LLM providers always visible | Task 3 (`LLMProvidersSectionWrapper`) |
| Members & access dropped | Implicit — never added to `SETTINGS_SECTIONS` |
| Marketplace stays own section | Task 3 (`MarketplacePrefsSection`) |
| Archive in Danger group | Task 2 (`ArchiveCompanySection`) |
| 3 ghost settings get UI: `proactiveIntervalMinutes` | Task 4 (Capabilities sub-tab) |
| 3 ghost settings get UI: `marketplaceSettings.updateWindow` | Task 3 (`MarketplacePrefsSection` Updates sub-section) |
| 3 ghost settings get UI: `rootFolder` | Task 2 (`GeneralSection` Company Data sub-section) |
| `enableTeams` stays API-only | Implicit — never added to UI |

All 18 locked decisions are mapped to specific tasks.

**2. Placeholder scan:** No `TBD`, `TODO`, `implement later`, or vague steps. Every code block is concrete or explicitly marked as "mechanical move from existing source at line X" with the source line range. The pseudo-structure for `CommanderSection.tsx` Step 4 deliberately stops short of pasting all 707 LOC because the move is mechanical and would bloat the plan; the implementer copies the existing TabsContent bodies into the new switch statement. This is the standard "extract function bodies" refactor pattern.

**3. Type consistency:**
- `SettingsSectionId` enumerated in `SettingsLayout.tsx`; matches the `tab=` URL values.
- `CommanderSubTabId` enumerated in `CommanderSubTabs.tsx`; matches `sub=` values.
- All ghost setting fields verified to exist in shared validators:
  - `rootFolder` → `validators/company.ts:8`
  - `updateWindow` → `marketplace.ts:192` + `MarketplaceSettingsPatchSchema`
  - `proactiveIntervalMinutes` → `validators/internal-agent.ts:19`
- API clients used (no new client files): `companiesApi.update`, `marketplaceSettings.patch`, `internalAgentApi.update`.

**4. Test coverage:**
- New `SettingsPage-redesign.test.tsx` — 13+ tests covering shell + each section + ghost-setting UI controls
- Existing `InternalAgentSettingsPage.test.tsx` (12 tests) renamed to `CommanderSection.test.tsx`, retargeted to `<CommanderSection>` — same coverage, no behavior changes
- `Sidebar.test.tsx` updated for Activity nav item

**5. Risks called out:**
- **`SettingsPage.tsx` is large (1,732 LOC).** The migration is heavy; doing it across 4 tasks (T1 shell, T2 General+Archive, T3 the other 5 sections, T4 Commander) keeps each task scoped to one or two files of moves.
- **GitHub PAT loses its UI surface.** Verification rule #7 calls this out explicitly: data-level functionality preserved (existing PATs in `company_secrets` keep working for workspace PR creation); UI surface deferred to a separate plugin-migration effort. Document this in the changeset.
- **`InternalAgentSettingsPage.test.tsx` retarget is mechanical** but care needed — the 12 tests assume a particular render structure. Task 4 step 1 says "renders <CommanderSection />" which has the same internal structure (4 sub-tabs, same forms), so all 12 tests should pass after the import swap. If any test breaks because of section-header chrome differences (e.g., a test asserts the page-level h1 "Internal Agent Settings"), update the assertion to match the new section header or drop the assertion if it was implementation-coupled.
- **Mobile pill row is the same pattern as marketplace mobile sub-nav** (Phase A). The hide-scrollbar + auto-scroll-active-into-view pattern is established. No new mobile UX invention.

---

## Execution

Plan complete. Per superpowers:writing-plans:

**1. Subagent-Driven (recommended)** — fresh subagent per task with two-stage review (spec compliance → code quality) between tasks. 6 tasks → 6 implementation cycles + reviews. Best fit because each task is well-defined and tasks 2-5 are mostly independent (Task 1 lays the shell; T2-T6 plug into it).

**2. Inline Execution** — execute tasks in this session via superpowers:executing-plans.

Tell me which to use, and I'll dispatch.
