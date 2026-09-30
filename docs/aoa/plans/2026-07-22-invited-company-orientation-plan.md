# Invited Company Orientation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic node-diagram (`MiniMap`) on the invited-teammate "admitted" terminal with a company-specific orientation (mission, departments, team/agent counts) in the new card visual language, degrading gracefully to fallbacks when data is missing.

**Architecture:** A new self-contained `CompanyOrientation` component fetches the joined company's detail/departments/agents/team via existing api clients (React Query) and renders three static `OrientationCard`s (a non-interactive variant of `Map.tsx`'s `JourneyCard`). `InvitedJoinTerminal` swaps `<MiniMap/>` → `<CompanyOrientation/>` on the `admitted` phase; nothing else in its state machine changes.

**Tech Stack:** React 19, @tanstack/react-query, TailwindCSS v4, Vitest + @testing-library/react. Design language: `ui/src/onboarding/Map.tsx`.

**Spec:** `docs/aoa/plans/2026-07-22-invited-company-orientation-design.md`

---

## File structure

- Create: `ui/src/onboarding/CompanyOrientation.tsx` — data fetch + 3 orientation cards + internal `OrientationCard`.
- Create: `ui/src/onboarding/__tests__/CompanyOrientation.test.tsx` — component tests.
- Modify: `ui/src/onboarding/InvitedJoinTerminal.tsx` — admitted phase renders `CompanyOrientation` instead of `MiniMap`, threading the anchored company id.
- Modify: `ui/src/onboarding/__tests__/InvitedJoinTerminal.test.tsx` — admitted-phase assertion.

Reference facts (verified in source):
- `companiesApi.get(companyId)` → `Company` with `vision: string | null`, `mission: string | null`, `name`.
- `projectsApi.list(companyId)` → `Project[]`; department rows are `type === "department"`, label is `name`.
- `agentsApi.list(companyId)` → `Agent[]` (count via `.length`).
- `teamApi.get(companyId)` → `TeamSummary` with `members: TeamMemberSummary[]` (count via `members.length`).
- `Map.tsx` exports `Map`; its per-card chrome lives in the local `JourneyCard` (accent hairline, glow, icon tile) — mirror it, drop the `<button>`/`onClick`/`cta` arrow.
- `queryKeys` in `ui/src/lib/queryKeys.ts` has `companies.all`; use ad-hoc keys for the others (see code).

---

### Task 1: CompanyOrientation component

**Files:**
- Create: `ui/src/onboarding/CompanyOrientation.tsx`
- Test: `ui/src/onboarding/__tests__/CompanyOrientation.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CompanyOrientation } from "../CompanyOrientation";

const getCompany = vi.fn();
const listProjects = vi.fn();
const listAgents = vi.fn();
const getTeam = vi.fn();

vi.mock("../../api/companies", () => ({ companiesApi: { get: (...a: unknown[]) => getCompany(...a) } }));
vi.mock("../../api/projects", () => ({ projectsApi: { list: (...a: unknown[]) => listProjects(...a) } }));
vi.mock("../../api/agents", () => ({ agentsApi: { list: (...a: unknown[]) => listAgents(...a) } }));
vi.mock("../../api/team", () => ({ teamApi: { get: (...a: unknown[]) => getTeam(...a) } }));

function renderWith(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

describe("CompanyOrientation", () => {
  beforeEach(() => {
    getCompany.mockReset();
    listProjects.mockReset();
    listAgents.mockReset();
    getTeam.mockReset();
  });

  it("renders company mission, department chips, and a team+agent count", async () => {
    getCompany.mockResolvedValue({ id: "c1", name: "Acme", vision: "Ship the future of robotics.", mission: null });
    listProjects.mockResolvedValue([
      { id: "p1", type: "department", name: "Engineering" },
      { id: "p2", type: "department", name: "Design" },
      { id: "p3", type: "project", name: "Launch" },
    ]);
    listAgents.mockResolvedValue([{ id: "a1" }, { id: "a2" }, { id: "a3" }]);
    getTeam.mockResolvedValue({ currentUser: {}, members: [{ id: "m1" }, { id: "m2" }], pendingInvites: [] });

    renderWith(<CompanyOrientation companyId="c1" companyName="Acme" />);

    expect(await screen.findByText("Ship the future of robotics.")).toBeInTheDocument();
    expect(await screen.findByText("Engineering")).toBeInTheDocument();
    expect(screen.getByText("Design")).toBeInTheDocument();
    expect(screen.queryByText("Launch")).not.toBeInTheDocument();
    expect(await screen.findByText(/2 teammates · 3 agents/i)).toBeInTheDocument();
  });

  it("shows per-card fallbacks when data is empty", async () => {
    getCompany.mockResolvedValue({ id: "c1", name: "Acme", vision: null, mission: null });
    listProjects.mockResolvedValue([]);
    listAgents.mockResolvedValue([]);
    getTeam.mockResolvedValue({ currentUser: {}, members: [], pendingInvites: [] });

    renderWith(<CompanyOrientation companyId="c1" companyName="Acme" />);

    expect(await screen.findByText(/shaping this as they go/i)).toBeInTheDocument();
    expect(screen.getByText(/no departments yet/i)).toBeInTheDocument();
    expect(screen.getByText(/one of the first here/i)).toBeInTheDocument();
  });

  it("renders all fallbacks and fetches nothing when companyId is null", () => {
    renderWith(<CompanyOrientation companyId={null} companyName="Acme" />);
    expect(getCompany).not.toHaveBeenCalled();
    expect(screen.getByText(/shaping this as they go/i)).toBeInTheDocument();
    expect(screen.getByText(/no departments yet/i)).toBeInTheDocument();
    expect(screen.getByText(/one of the first here/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ui && npx vitest run src/onboarding/__tests__/CompanyOrientation.test.tsx`
Expected: FAIL — `Failed to resolve import "../CompanyOrientation"`.

- [ ] **Step 3: Write the component**

```tsx
import { type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { companiesApi } from "../api/companies";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { teamApi } from "../api/team";
import { Reveal } from "./motion";

type Accent = "brand" | "teal" | "amber";
const ACCENT_VAR: Record<Accent, string> = {
  brand: "var(--brand)",
  teal: "var(--teal)",
  amber: "var(--amber)",
};

// Static (non-interactive) sibling of Map.tsx's JourneyCard: same chrome, no
// button/onClick/cta arrow — this screen orients, it doesn't fork.
function OrientationCard({
  emoji,
  title,
  accent,
  children,
}: {
  emoji: string;
  title: string;
  accent: Accent;
  children: ReactNode;
}) {
  const c = ACCENT_VAR[accent];
  return (
    <div
      style={{ "--card-accent": c } as CSSProperties}
      className={cn(
        "relative flex min-h-[168px] w-full flex-col gap-3 overflow-hidden rounded-2xl border border-border-strong bg-card p-5 text-left",
      )}
    >
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{ backgroundColor: `color-mix(in srgb, ${c} 65%, transparent)` }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full opacity-40 blur-2xl"
        style={{ backgroundColor: `color-mix(in srgb, ${c} 35%, transparent)` }}
      />
      <span
        aria-hidden
        className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xl leading-none"
        style={{
          backgroundColor: `color-mix(in srgb, ${c} 18%, transparent)`,
          border: `1px solid color-mix(in srgb, ${c} 45%, transparent)`,
        }}
      >
        {emoji}
      </span>
      <div className="relative flex min-w-0 flex-1 flex-col gap-2">
        <h3 className="m-0 text-[15px] font-semibold text-text">{title}</h3>
        <span
          aria-hidden
          className="block h-px w-8"
          style={{ backgroundColor: `color-mix(in srgb, ${c} 55%, transparent)` }}
        />
        <div className="m-0 text-[12.5px] leading-relaxed text-dim">{children}</div>
      </div>
    </div>
  );
}

export type CompanyOrientationProps = {
  /** The joined company's id (null on the rare deep-link/name-only race — then
   * every card shows its fallback and no fetch runs). */
  companyId: string | null;
  companyName: string;
};

/**
 * The invited-teammate terminal's orientation panel (replaces the old generic
 * MiniMap). Shows whatever the joined company actually has — mission,
 * departments, team + agent counts — each card degrading independently to a
 * friendly fallback. Read-only; the "Enter" action stays on the parent.
 */
export function CompanyOrientation({ companyId, companyName }: CompanyOrientationProps) {
  const enabled = Boolean(companyId);
  const company = useQuery({
    queryKey: ["invited-orientation", "company", companyId],
    queryFn: () => companiesApi.get(companyId as string),
    enabled,
    retry: false,
  });
  const projects = useQuery({
    queryKey: ["invited-orientation", "projects", companyId],
    queryFn: () => projectsApi.list(companyId as string),
    enabled,
    retry: false,
  });
  const agents = useQuery({
    queryKey: ["invited-orientation", "agents", companyId],
    queryFn: () => agentsApi.list(companyId as string),
    enabled,
    retry: false,
  });
  const team = useQuery({
    queryKey: ["invited-orientation", "team", companyId],
    queryFn: () => teamApi.get(companyId as string),
    enabled,
    retry: false,
  });

  const missionText = company.data?.vision || company.data?.mission || null;
  const departments = (projects.data ?? []).filter((p) => p.type === "department");
  const agentCount = agents.data?.length ?? 0;
  const teammateCount = team.data?.members.length ?? 0;

  return (
    <Reveal delay={0.09}>
      <div className="grid w-full grid-cols-1 gap-3.5 sm:grid-cols-3 sm:gap-4">
        <OrientationCard emoji="🎯" title="What we're building" accent="brand">
          {missionText ?? `${companyName}'s team is shaping this as they go.`}
        </OrientationCard>

        <OrientationCard emoji="🏢" title="Departments" accent="teal">
          {departments.length === 0 ? (
            "No departments yet."
          ) : (
            <span className="flex flex-wrap gap-1.5">
              {departments.map((d) => (
                <span
                  key={d.id}
                  className="rounded-md border border-border-strong bg-hd px-2 py-0.5 text-[11px] text-text"
                >
                  {d.name}
                </span>
              ))}
            </span>
          )}
        </OrientationCard>

        <OrientationCard emoji="👥" title="Who's here" accent="amber">
          {teammateCount === 0 && agentCount === 0
            ? "You're one of the first here."
            : `${teammateCount} teammate${teammateCount === 1 ? "" : "s"} · ${agentCount} agent${
                agentCount === 1 ? "" : "s"
              } already working`}
        </OrientationCard>
      </div>
    </Reveal>
  );
}
```

Note: if `text-hd`/`bg-hd` is not a valid class in this project, use `bg-card-2` or `bg-white/5` for the chip background — check `ui/src/index.css` / an existing chip (e.g. `Map.tsx` uses `border-border-strong`). Prefer an existing chip token.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ui && npx vitest run src/onboarding/__tests__/CompanyOrientation.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @armyofagents/ui typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add ui/src/onboarding/CompanyOrientation.tsx ui/src/onboarding/__tests__/CompanyOrientation.test.tsx
git commit -m "feat(onboarding): CompanyOrientation panel for the invited terminal"
```

---

### Task 2: Wire CompanyOrientation into InvitedJoinTerminal

**Files:**
- Modify: `ui/src/onboarding/InvitedJoinTerminal.tsx`
- Test: `ui/src/onboarding/__tests__/InvitedJoinTerminal.test.tsx`

- [ ] **Step 1: Update the InvitedJoinTerminal test for the admitted phase**

Read the existing `InvitedJoinTerminal.test.tsx`. Find the admitted-phase test (the one that asserts the MiniMap "the machine you're joining" caption and/or the "Enter {company}" button). Replace the MiniMap assertion with an assertion that `CompanyOrientation` renders — mock it to a sentinel so the terminal test stays about the terminal, not the panel:

```tsx
vi.mock("../CompanyOrientation", () => ({
  CompanyOrientation: ({ companyId, companyName }: { companyId: string | null; companyName: string }) => (
    <div data-testid="company-orientation" data-company-id={companyId ?? ""}>
      orientation:{companyName}
    </div>
  ),
}));
```

Then in the admitted-phase test assert:

```tsx
expect(await screen.findByTestId("company-orientation")).toBeInTheDocument();
expect(screen.getByRole("button", { name: /enter/i })).toBeInTheDocument();
```

Remove any assertion that the old `MiniMap` caption ("the machine you're joining") is present.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ui && npx vitest run src/onboarding/__tests__/InvitedJoinTerminal.test.tsx`
Expected: FAIL — `company-orientation` testid not found (terminal still renders `MiniMap`).

- [ ] **Step 3: Swap MiniMap → CompanyOrientation in the admitted phase**

In `InvitedJoinTerminal.tsx`:
1. Replace the import `import { MiniMap } from "./MiniMap";` with `import { CompanyOrientation } from "./CompanyOrientation";`.
2. In the `admitted` render block, replace `<MiniMap className="w-full text-left" />` with:

```tsx
<CompanyOrientation companyId={anchoredTargetRef.current} companyName={company?.name ?? "the team"} />
```

(`anchoredTargetRef.current` is the resolved company id; it is in scope in the component. `company?.name` is the already-resolved name.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ui && npx vitest run src/onboarding/__tests__/InvitedJoinTerminal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @armyofagents/ui typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add ui/src/onboarding/InvitedJoinTerminal.tsx ui/src/onboarding/__tests__/InvitedJoinTerminal.test.tsx
git commit -m "feat(onboarding): invited terminal shows company orientation, not the generic diagram"
```

---

### Task 3: Verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full onboarding UI unit tests**

Run: `cd ui && npx vitest run src/onboarding`
Expected: all pass (including the two new/updated files; MiniMap.test.tsx still passes since MiniMap.tsx is untouched).

- [ ] **Step 2: UI typecheck**

Run: `pnpm --filter @armyofagents/ui typecheck`
Expected: no errors.

- [ ] **Step 3: Live e2e — invited flow still gates on Enter and reaches the Lobby**

Run: `AOA_E2E_FORCE_WINDOWS=1 npx playwright test --config=tests/e2e/playwright.config.ts onboarding-invited --project=chromium --reporter=list`
Expected: 4 passed. (`expectInsideCompany` clicks "Enter {company}" — unchanged — then asserts the Lobby; the redesigned terminal keeps that button.)

- [ ] **Step 4: Live visual confirmation (screenshot)**

Boot is covered by the e2e run above. Optionally drive the admitted terminal in the browser preview and screenshot it to confirm the three orientation cards render with real company data (mission, department chips, team/agent counts) in the dark shell.

---

## Self-review notes

- **Spec coverage:** mission/vision card ✔ (Task 1 Step 3), department chips ✔, team+agent counts ✔, per-card fallbacks ✔ (Task 1 test 2), null-id → fallbacks + no fetch ✔ (Task 1 test 3), keep Enter button ✔ (Task 2), MiniMap/mapDiagram untouched ✔, e2e unchanged ✔ (Task 3 Step 3).
- **Type consistency:** `companyId: string | null`, `companyName: string` used identically in the component, its props type, and the parent wiring. `departments` filter uses `type === "department"` matching `ProjectType`. `team.data?.members.length` matches `TeamSummary.members`.
- **YAGNI:** no brandColor theming, no card interactions, no new endpoints — all deferred per spec.
