# Onboarding Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship five onboarding improvements — real SVG splash logo, AoA-crew-filtered agent picker, an `aoa-librarian` marketplace entry, a unified phase-model flow chrome, and a reworked memory step (file drop + repo ingestion) — one at a time, smallest/safest first, each fully tested and (where visible) live-verified.

**Architecture:** Frontend React + Vite + Tailwind v4 (`ui/src`), Express 5 (`server/src`), Drizzle + Postgres (`packages/db`), shared types (`packages/shared`). Onboarding renders standalone at `/onboarding`: spine via `FlowEngine`, then persona + in-flight tail via `FirstRunHome`/`InFlightFlow`. Agents are keyless CLI (`claude_local`); the Librarian proposes memory (never writes directly).

**Tech Stack:** React 19, TanStack Query, vitest + @testing-library/react (UI), vitest (server, drizzle-mock/pure-function patterns), gh CLI (marketplace repo), the isolated `journey2` instance (`:3100`, Google auth) for live verification.

**Design spec:** `docs/aoa/plans/2026-07-19-onboarding-improvements-design.md`

**Global conventions**
- Run UI tests from `ui/`: `npx vitest run <path>`. UI typecheck: `cd ui && npx tsc --noEmit`.
- Run server tests from `server/`: `npx vitest run <path>`. (Some route tests only run in CI — drizzle ESM cycle; noted per task.)
- Live verify: rebuild UI (`pnpm --filter @armyofagents/ui build`) → the running `journey2` server serves `ui/dist`; server code changes need a server restart (env in the design spec's Verification section).
- Commit after each green task. Branch: `claude/signup-onboarding-ui-animations-0724cb`.

---

## Item 1 — Splash: real SVG `AoaLogo`

**Files:**
- Modify: `ui/src/onboarding/motion/AoaLogo.tsx` (replace internals; keep `{ size, hideDot }` API)
- Modify: `ui/src/onboarding/motion/motion.css` (add logo keyframes, remove dead `obd-spin` if unreferenced)
- Test: `ui/src/onboarding/motion/__tests__/AoaLogo.test.tsx`
- Reference (fetch, do not commit): `MeteoriteLabs/AoA-Website` main `client/src/components/animations/AoaLogo.tsx` + `animations.css`

- [ ] **Step 1: Fetch the authoritative source for reference**

```bash
gh api repos/MeteoriteLabs/AoA-Website/contents/client/src/components/animations/AoaLogo.tsx \
  --jq '.content' | base64 -d > /tmp/website-AoaLogo.tsx
gh api repos/MeteoriteLabs/AoA-Website/contents/client/src/components/animations/animations.css \
  --jq '.content' | base64 -d > /tmp/website-animations.css
```
Read both. Note the SVG `viewBox="0 0 1085 350"`, the `aoa-dot` breathing path + its `@keyframes`, and any letter draw/reveal animation classes.

- [ ] **Step 2: Update the failing test first**

Rewrite `ui/src/onboarding/motion/__tests__/AoaLogo.test.tsx` to assert the real SVG:

```tsx
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { AoaLogo } from "../AoaLogo";

describe("AoaLogo", () => {
  it("renders an accessible SVG wordmark sized from the `size` prop", () => {
    const { container } = render(<AoaLogo size={64} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute("role", "img");
    expect(svg).toHaveAttribute("aria-label");
    // width derives from size; height from the 1085:350 aspect ratio
    expect(svg).toHaveAttribute("viewBox", "0 0 1085 350");
    // the breathing dot path is present by default
    expect(container.querySelector(".aoa-dot")).toBeInTheDocument();
  });

  it("omits the dot when hideDot is set", () => {
    const { container } = render(<AoaLogo size={40} hideDot />);
    expect(container.querySelector(".aoa-dot")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ui && npx vitest run src/onboarding/motion/__tests__/AoaLogo.test.tsx`
Expected: FAIL (current CSS-fake logo renders a `<span>`, not an `<svg>` with `viewBox`).

- [ ] **Step 4: Replace the component internals with the real SVG**

Rewrite `ui/src/onboarding/motion/AoaLogo.tsx`: paste the website's SVG markup, but keep the app's signature and derive `width` from `size`:

```tsx
/**
 * AoaLogo — the real brand SVG wordmark (ported from MeteoriteLabs/AoA-Website
 * `animations/AoaLogo.tsx`). Keeps the app's `{ size, hideDot }` API so existing
 * callers (SplashScreen, SpineCompleteStep, Auth) are untouched. `size` is the
 * width in px; height follows the 1085:350 aspect ratio. Animation lives in
 * motion.css (`.aoa-dot` breathe + any letter reveal).
 */
export function AoaLogo({ size = 40, hideDot = false }: { size?: number; hideDot?: boolean }) {
  const width = size;
  const height = Math.round(width * (350 / 1085));
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 1085 350"
      overflow="visible"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Army of Agents"
    >
      {/* PASTE the website's paths here verbatim:
          - the {!hideDot && <path className="aoa-dot" .../>} breathing dot
          - the two "A" glyph paths and the "o" ring path(s)
          Keep className="aoa-dot" and any animation classes so motion.css drives them. */}
    </svg>
  );
}
```
Guard the dot path with `{!hideDot && (...)}`.

- [ ] **Step 5: Port the logo keyframes into motion.css**

Copy ONLY the logo-relevant rules from the website `animations.css` into `ui/src/onboarding/motion/motion.css` (e.g. `.aoa-dot { animation: ... }` + its `@keyframes`, and any letter-draw class). Do not import the whole website CSS. If `obd-spin` / the old `.obd-logo` ring styles are now unreferenced (grep confirms), delete them.

Run: `grep -rn "obd-spin\|obd-logo" ui/src` — remove dead rules only if zero references remain.

- [ ] **Step 6: Run tests + typecheck**

Run: `cd ui && npx vitest run src/onboarding/motion/__tests__/AoaLogo.test.tsx src/onboarding/__tests__ && npx tsc --noEmit`
Expected: PASS (AoaLogo + SplashScreen suites green, typecheck clean).

- [ ] **Step 7: Live verify**

Rebuild + view: `pnpm --filter @armyofagents/ui build`, then load `http://127.0.0.1:3100/auth` (splash plays). Confirm the real wordmark + breathing dot render on the constellation, typewriter still runs. Screenshot via the browser tools if the renderer allows; otherwise assert via `read_page`/`javascript_tool` that an `<svg viewBox="0 0 1085 350">` is present on the splash.

- [ ] **Step 8: Commit**

```bash
git add ui/src/onboarding/motion/AoaLogo.tsx ui/src/onboarding/motion/motion.css ui/src/onboarding/motion/__tests__/AoaLogo.test.tsx
git commit -m "fix(onboarding): use the real SVG AoaLogo in the splash (ported from AoA-Website)"
```

---

## Item 2 — Agent-picker: hide the AoA curated crew

**Files:**
- Modify: `ui/src/api/marketplace.ts` (add `isAoaCuratedItem` predicate)
- Modify: `ui/src/onboarding/inflight/CreateAgents.tsx:121` (apply the filter)
- Test: `ui/src/api/__tests__/marketplace.test.ts` (create if absent) + `ui/src/onboarding/inflight/__tests__/CreateAgents.test.tsx`

- [ ] **Step 1: Write the failing predicate test**

Create/append `ui/src/api/__tests__/marketplace.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isAoaCuratedItem } from "../marketplace";
import type { CatalogItem } from "@armyofagents/shared";

const item = (source: Partial<CatalogItem["source"]>): CatalogItem =>
  ({ id: "x", type: "agent", source: { adapter: "github-skills", url: "", locator: "" }, ...{ source } } as unknown as CatalogItem);

describe("isAoaCuratedItem", () => {
  it("is true for aoa-curated source adapter", () => {
    expect(isAoaCuratedItem(item({ adapter: "aoa-curated", url: "https://github.com/MeteoriteLabs/aoa-marketplace", locator: "content/agents/aoa-adjutant" }))).toBe(true);
  });
  it("is false for other adapters", () => {
    expect(isAoaCuratedItem(item({ adapter: "github-skills", url: "", locator: "" }))).toBe(false);
  });
});
```
(Adjust the `item` helper to the real `CatalogItem` shape after reading `packages/shared/src/marketplace.ts` — the point is: predicate keys off `source.adapter === "aoa-curated"`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/api/__tests__/marketplace.test.ts`
Expected: FAIL ("isAoaCuratedItem is not a function").

- [ ] **Step 3: Implement the predicate**

In `ui/src/api/marketplace.ts`, next to `filterByType`:

```ts
/** AoA-curated crew items (source adapter "aoa-curated", e.g. agent:aoa-curated/aoa-adjutant).
 *  Used to hide the internal crew from the onboarding agent picker. */
export function isAoaCuratedItem(item: CatalogItem): boolean {
  return item.source?.adapter === "aoa-curated";
}
```

- [ ] **Step 4: Run predicate test to verify it passes**

Run: `cd ui && npx vitest run src/api/__tests__/marketplace.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing CreateAgents filter test**

In `ui/src/onboarding/inflight/__tests__/CreateAgents.test.tsx`, add a test that mocks `marketplaceApi.getCatalog` to return one `aoa-curated` agent + one regular agent + one regular team, and asserts the aoa-curated one is not offered in the picker (assert by the catalog state or rendered picker — match the suite's existing patterns for opening the marketplace picker).

- [ ] **Step 6: Run it to verify it fails**

Run: `cd ui && npx vitest run src/onboarding/inflight/__tests__/CreateAgents.test.tsx`
Expected: FAIL (aoa-curated item currently appears).

- [ ] **Step 7: Apply the filter in CreateAgents**

`ui/src/onboarding/inflight/CreateAgents.tsx` — change the catalog set (currently ~line 121):

```tsx
const agentsAndTeams = [
  ...filterByType(catalog.items, "agent"),
  ...filterByType(catalog.items, "team"),
].filter((item) => !isAoaCuratedItem(item));
setCatalogItems(agentsAndTeams);
```
Add `isAoaCuratedItem` to the existing `../../api/marketplace` import.

- [ ] **Step 8: Run tests + typecheck**

Run: `cd ui && npx vitest run src/onboarding/inflight/__tests__/CreateAgents.test.tsx src/api/__tests__/marketplace.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add ui/src/api/marketplace.ts ui/src/api/__tests__/marketplace.test.ts ui/src/onboarding/inflight/CreateAgents.tsx ui/src/onboarding/inflight/__tests__/CreateAgents.test.tsx
git commit -m "fix(onboarding): hide AoA curated crew from the create-agents marketplace picker"
```

---

## Item 3 — Marketplace PR: add `aoa-librarian`

**Repo:** `MeteoriteLabs/aoa-marketplace` (cloned outside this worktree). **Do not push until the user approves the diff.**

- [ ] **Step 1: Clone + branch**

```bash
gh repo clone MeteoriteLabs/aoa-marketplace /tmp/aoa-marketplace
cd /tmp/aoa-marketplace && git checkout -b add-aoa-librarian && (pnpm install || npm install)
```

- [ ] **Step 2: Study the model agent**

Read `content/agents/aoa-memory-keeper/` (`agent.json`, `manifest.json`, `AGENTS.md` + any instruction files) and `content/teams/default-crew/team.json`. Note the exact JSON shape, required fields, id/slug conventions, and how members are listed in `team.json`.

- [ ] **Step 3: Source the Librarian's real content from the app**

In the AoA worktree, read the app's Librarian definition so the marketplace agent matches the seeded one: `server/src/services/internal-agent/aoa-agents/ensure-librarian.ts`, `server/src/services/default-agent-instructions.ts` (Librarian branch), and any `server/src/onboarding-assets/*` crew content. Extract the Librarian's role, SOUL/instructions, and tool allowlist.

- [ ] **Step 4: Create the agent content**

Create `content/agents/aoa-librarian/` mirroring `aoa-memory-keeper`'s file set, with:
- `agent.json` — id/slug `aoa-librarian`, display name "Librarian", description, adapter, tool allowlist (from Step 3).
- `manifest.json` — matching the memory-keeper manifest shape (schema version, entry files).
- Instruction `.md` files (AGENTS.md / SOUL.md / HEARTBEAT.md / TOOLS.md as the model uses), content from Step 3.

- [ ] **Step 5: Wire into the default crew**

Add `aoa-librarian` to `content/teams/default-crew/team.json`'s `agents` array (matching the existing entry format). Add a changeset if the repo uses changesets (`.changeset/`).

- [ ] **Step 6: Validate against the repo's own tests**

```bash
cd /tmp/aoa-marketplace && pnpm -r test 2>&1 | tail -30   # or: npm test
# Specifically the catalog schema + aggregate suites under catalog/src/__tests__
```
Expected: PASS (the new agent validates against `catalog-schema` + `aggregate`). Fix shape issues until green.

- [ ] **Step 7: Build the catalog locally to confirm the item appears**

Run the repo's aggregate build (see `catalog/package.json` scripts, e.g. `pnpm --filter catalog build` / `aggregate`), then grep the output `dist/catalog.json` for `aoa-librarian`.
Expected: `agent:aoa-curated/aoa-librarian` present.

- [ ] **Step 8: Show the diff to the user (GATE)**

```bash
cd /tmp/aoa-marketplace && git add -A && git --no-pager diff --staged
```
Present the full diff. **Wait for explicit approval before pushing.**

- [ ] **Step 9: Commit + push + open PR (after approval)**

```bash
git commit -m "feat: add aoa-librarian curated agent + wire into default-crew"
git push -u origin add-aoa-librarian
gh pr create --repo MeteoriteLabs/aoa-marketplace --title "Add aoa-librarian curated agent" --body "Adds the Librarian to content/agents + default-crew so it publishes to the catalog CDN. Matches the app's seeded Librarian."
```

- [ ] **Step 10: Verify end-to-end after merge**

Once merged, `aggregate.yml` publishes `catalog.json` to the CDN. Confirm:
```bash
curl -s https://meteoritelabs.github.io/aoa-marketplace-cdn/catalog.json | grep -o "aoa-librarian" | head -1
```
Expected: `aoa-librarian`. (No AoA-side commit here; the app already consumes the CDN.)

---

## Item 4 — Unified phase-model flow chrome

**Phases:** `Setup` (spine, 6 steps) → `Your world` (persona → departments, integrations, braindump, librarian) → `Your crew` (agents, first job).

**Files:**
- Create: `ui/src/onboarding/OnboardingChrome.tsx` (dumb phase rail)
- Create: `ui/src/onboarding/onboardingProgress.ts` (pure mapping: position → `{ phase, subStep, subTotal }`)
- Modify: `ui/src/onboarding/FlowEngine.tsx` (add `onProgress?(index, total)`; drop its own stepper pips)
- Modify: `ui/src/onboarding/inflight/InFlightFlow.tsx` (add `onProgress?(index, total)`)
- Modify: `ui/src/onboarding/FirstRunHome.tsx` (report persona-phase start + tail progress upward)
- Modify: `ui/src/pages/OnboardingFlow.tsx` (own the position → chrome mapping; render `OnboardingChrome`)
- Tests: `ui/src/onboarding/__tests__/onboardingProgress.test.ts`, `ui/src/onboarding/__tests__/OnboardingChrome.test.tsx`, plus updates to `FlowEngine`/`OnboardingFlow`/`InFlightFlow` tests for the API changes.

### Task 4.1 — Pure progress mapping

- [ ] **Step 1: Write the failing mapping test**

Create `ui/src/onboarding/__tests__/onboardingProgress.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PHASES, resolvePhase } from "../onboardingProgress";

describe("resolvePhase", () => {
  it("maps a spine step to Setup", () => {
    expect(resolvePhase({ kind: "spine", index: 2, total: 6 })).toEqual({ phase: "setup", subStep: 3, subTotal: 6 });
  });
  it("maps the persona door to Your world (first sub-step)", () => {
    expect(resolvePhase({ kind: "persona" })).toEqual({ phase: "world", subStep: 1, subTotal: 5 });
  });
  it("maps a tail world-surface (braindump, index 2) to Your world", () => {
    // IN_FLIGHT order: departments(0) integrations(1) braindump(2) librarian(3) agents(4) first_job(5)
    // world sub-steps = persona + departments + integrations + braindump + librarian = 5
    expect(resolvePhase({ kind: "tail", index: 2 })).toEqual({ phase: "world", subStep: 4, subTotal: 5 });
  });
  it("maps a tail crew-surface (agents, index 4) to Your crew", () => {
    expect(resolvePhase({ kind: "tail", index: 4 })).toEqual({ phase: "crew", subStep: 1, subTotal: 2 });
  });
  it("exposes three ordered phases", () => {
    expect(PHASES.map((p) => p.key)).toEqual(["setup", "world", "crew"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && npx vitest run src/onboarding/__tests__/onboardingProgress.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the mapping**

Create `ui/src/onboarding/onboardingProgress.ts`:

```ts
export type PhaseKey = "setup" | "world" | "crew";
export const PHASES: { key: PhaseKey; label: string }[] = [
  { key: "setup", label: "Setup" },
  { key: "world", label: "Your world" },
  { key: "crew", label: "Your crew" },
];

// In-flight tail order (mirror of InFlightFlow.IN_FLIGHT_SURFACES):
// 0 departments, 1 integrations, 2 braindump, 3 librarian -> "world"
// 4 agents, 5 first_job -> "crew"
const WORLD_TAIL_COUNT = 4; // departments..librarian
const WORLD_SUBTOTAL = 1 + WORLD_TAIL_COUNT; // persona + 4
const CREW_SUBTOTAL = 2; // agents + first_job

export type Position =
  | { kind: "spine"; index: number; total: number }
  | { kind: "persona" }
  | { kind: "tail"; index: number };

export function resolvePhase(pos: Position): { phase: PhaseKey; subStep: number; subTotal: number } {
  if (pos.kind === "spine") return { phase: "setup", subStep: pos.index + 1, subTotal: pos.total };
  if (pos.kind === "persona") return { phase: "world", subStep: 1, subTotal: WORLD_SUBTOTAL };
  if (pos.index < WORLD_TAIL_COUNT) return { phase: "world", subStep: pos.index + 2, subTotal: WORLD_SUBTOTAL };
  return { phase: "crew", subStep: pos.index - WORLD_TAIL_COUNT + 1, subTotal: CREW_SUBTOTAL };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd ui && npx vitest run src/onboarding/__tests__/onboardingProgress.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/onboarding/onboardingProgress.ts ui/src/onboarding/__tests__/onboardingProgress.test.ts
git commit -m "feat(onboarding): pure phase-progress mapping for the unified flow chrome"
```

### Task 4.2 — `OnboardingChrome` phase rail

- [ ] **Step 1: Write the failing component test**

Create `ui/src/onboarding/__tests__/OnboardingChrome.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { OnboardingChrome } from "../OnboardingChrome";

describe("OnboardingChrome", () => {
  it("highlights the active phase and shows sub-step position", () => {
    render(<OnboardingChrome phase="world" subStep={3} subTotal={5} />);
    expect(screen.getByText("Setup")).toBeInTheDocument();
    expect(screen.getByText("Your world")).toBeInTheDocument();
    expect(screen.getByText("Your crew")).toBeInTheDocument();
    const active = screen.getByText("Your world").closest("[data-active]");
    expect(active).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("onboarding-substep")).toHaveTextContent("3 / 5");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && npx vitest run src/onboarding/__tests__/OnboardingChrome.test.tsx`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the dumb rail**

Create `ui/src/onboarding/OnboardingChrome.tsx` using the dark-shell tokens (match `FlowEngine`'s pip styling — `bg-brand`, `text-dim`, mono tracking):

```tsx
import { cn } from "@/lib/utils";
import { PHASES, type PhaseKey } from "./onboardingProgress";

export function OnboardingChrome({ phase, subStep, subTotal }: { phase: PhaseKey; subStep: number; subTotal: number }) {
  const activeIndex = PHASES.findIndex((p) => p.key === phase);
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2" aria-hidden="true">
        {PHASES.map((p, i) => (
          <div key={p.key} data-active={p.key === phase} className="flex items-center gap-2">
            <span className={cn("h-1 w-6 rounded-full bg-border-strong transition-colors", i < activeIndex && "bg-brand", i === activeIndex && "bg-brand-hover shadow-[0_0_8px_rgba(209,58,38,0.6)]")} />
            <span className={cn("text-[11px]", i === activeIndex ? "text-text" : "text-very-dim")}>{p.label}</span>
          </div>
        ))}
      </div>
      <span data-testid="onboarding-substep" className="font-mono text-[10.5px] tracking-[0.14em] text-very-dim">
        {subStep} / {subTotal}
      </span>
    </div>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd ui && npx vitest run src/onboarding/__tests__/OnboardingChrome.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/onboarding/OnboardingChrome.tsx ui/src/onboarding/__tests__/OnboardingChrome.test.tsx
git commit -m "feat(onboarding): OnboardingChrome phase rail (dumb, phase + sub-step)"
```

### Task 4.3 — Wire progress reporting + render the chrome

- [ ] **Step 1: Add `onProgress` to FlowEngine + drop its own pips**

In `ui/src/onboarding/FlowEngine.tsx`: add optional `onProgress?: (index: number, total: number) => void` to `FlowEngineProps`; call it in an effect whenever `stepNumber`/`applicableSteps.length` change (`onProgress?.(stepNumber - 1, applicableSteps.length)`). Remove the internal `StepperPips` + "Step N of M" readout render (the chrome now owns progress). Keep the Back affordance.

- [ ] **Step 2: Add `onProgress` to InFlightFlow**

In `ui/src/onboarding/inflight/InFlightFlow.tsx`: add optional `onProgress?: (index: number) => void`; call it in an effect on `index` change (`onProgress?.(index)`).

- [ ] **Step 3: Report persona start + tail progress from FirstRunHome**

In `ui/src/onboarding/FirstRunHome.tsx`: accept optional `onProgress?: (pos: Position) => void`; emit `{ kind: "persona" }` while phase is `"door"`, and pass an `onProgress={(i) => onProgress?.({ kind: "tail", index: i })}` into `<InFlightFlow>`.

- [ ] **Step 4: Own the mapping + render the chrome in OnboardingFlow**

In `ui/src/pages/OnboardingFlow.tsx`: hold `const [position, setPosition] = useState<Position>({ kind: "spine", index: 0, total: 6 })`. Pass `onProgress={(index, total) => setPosition({ kind: "spine", index, total })}` to the spine `FlowEngine`, and `onProgress={setPosition}` to `FirstRunHome`. Render `<OnboardingChrome {...resolvePhase(position)} />` inside the dark shell above the active sub-flow (both the spine `FlowEngine` branch and the `FirstRunHome` branch), so it persists across the whole journey.

- [ ] **Step 5: Update affected tests**

Update `FlowEngine` tests (removed pips → assert no "Step N of M"; assert `onProgress` fires), `OnboardingFlow` test (chrome renders; position updates), `InFlightFlow`/`FirstRunHome` tests (onProgress fires). Add a mapping-integration assertion: spine finish → persona → tail advances the chrome phases.

- [ ] **Step 6: Run the onboarding suite + typecheck**

Run: `cd ui && npx vitest run src/onboarding src/pages/__tests__/OnboardingFlow.test.tsx && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Live verify**

Rebuild UI; on `journey2` resume into `/onboarding` and confirm the phase rail persists spine → persona → tail, highlighting the right phase, with no duplicate "Step N of M".

- [ ] **Step 8: Commit**

```bash
git add ui/src/onboarding/FlowEngine.tsx ui/src/onboarding/inflight/InFlightFlow.tsx ui/src/onboarding/FirstRunHome.tsx ui/src/pages/OnboardingFlow.tsx ui/src/onboarding/__tests__ ui/src/pages/__tests__/OnboardingFlow.test.tsx
git commit -m "feat(onboarding): unified phase-model chrome across spine + persona + tail"
```

---

## Item 5 — Memory step rework (file drop + repo ingestion)

Split into **5a (file drop → memory tree)** and **5b (repo code-reading for software depts)**. Ship 5a first (independently useful), then 5b.

### Phase 5a — File drop into the memory tree

**Files:**
- Modify: `ui/src/onboarding/inflight/BraindumpStep.tsx` (drop zone + uploaded-file chips)
- Modify: `ui/src/api/braindump.ts` (submit carries `assetIds`)
- Modify: `server/src/services/braindump.ts` + its route (persist `assetIds`; link `memory_assets` at the department folder path)
- Modify: `server/src/services/internal-agent/aoa-agents/aoa-trigger-prompt.ts` (inject dropped-file paths into the `braindump.ingest` directive)
- Tests: braindump service test, trigger-prompt test, BraindumpStep component test

- [ ] **Step 1: Confirm the asset-upload + memory_assets contracts**

Read the existing asset upload route/service (search `server/src/routes` + `server/src/services` for `assets` upload; `packages/db/src/schema/assets.ts`, `memory_assets.ts`, `StorageService`). Note: how bytes are stored (`storageKey`), the 50MB cap, and how `memory_assets` rows link `companyId` + `folderPath` + `storageKey`. Pin the exact function names before writing tests.

- [ ] **Step 2: Write the failing server test — braindump submit persists assetIds + links memory_assets**

In `server/src/__tests__/braindump.test.ts` (or a focused new test), following the drizzle-mock / sequence-db patterns already in that file, assert that submitting a braindump with `assetIds: ["a1"]` for a department (a) stores them on the capture and (b) creates a `memory_assets` row with the department's seeded `folderPath`.

- [ ] **Step 3: Run it to verify it fails**

Run: `cd server && npx vitest run src/__tests__/braindump.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement the capture + linkage**

Extend `braindumpApi.submit` (`ui/src/api/braindump.ts`) and the server `braindump` service/route to accept `assetIds: string[]` (default `[]`), persist them on the capture, and create `memory_assets` rows (`companyId`, `folderPath` = the department's root seeded folder, `storageKey` from the asset). Keep it best-effort per asset (one failure doesn't fail the capture), mirroring existing patterns.

- [ ] **Step 5: Run server test to verify it passes**

Run: `cd server && npx vitest run src/__tests__/braindump.test.ts`
Expected: PASS. (If the file hits the drizzle ESM cycle locally, note it runs in CI; keep the assertion pure where possible.)

- [ ] **Step 6: Write + pass the trigger-prompt test**

In the trigger-prompt test suite, assert the `braindump.ingest` directive includes the dropped-file paths when `assetIds` are present (so the CLI Librarian reads them), while preserving the "do not invent" guardrail. Implement by extending `aoa-trigger-prompt.ts`'s braindump branch to append a "Dropped files (read these):" section with the resolved file paths/keys. Run the suite; expected PASS.

- [ ] **Step 7: Write the failing BraindumpStep drop-zone test**

In `ui/src/onboarding/inflight/__tests__/BraindumpStep.test.tsx`, assert a drop zone renders per department and that selecting a file uploads it (mock the upload) and shows a chip, and that submit includes the returned `assetIds`.

- [ ] **Step 8: Run it to verify it fails**

Run: `cd ui && npx vitest run src/onboarding/inflight/__tests__/BraindumpStep.test.tsx`
Expected: FAIL.

- [ ] **Step 9: Implement the drop zone**

Add a file input / drop zone to each department card in `BraindumpStep.tsx`; on select, upload via the asset API, collect `assetIds`, render chips (reuse the existing chip styling); include `assetIds` in `braindumpApi.submit`. Keep the textarea; either the text or a file makes the box non-empty.

- [ ] **Step 10: Run tests + typecheck**

Run: `cd ui && npx vitest run src/onboarding/inflight/__tests__/BraindumpStep.test.tsx && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add ui/src/onboarding/inflight/BraindumpStep.tsx ui/src/api/braindump.ts server/src/services/braindump.ts server/src/services/internal-agent/aoa-agents/aoa-trigger-prompt.ts server/src/__tests__ ui/src/onboarding/inflight/__tests__/BraindumpStep.test.tsx
git commit -m "feat(onboarding): braindump file drop -> memory tree (assets linked to seeded folders)"
```

- [ ] **Step 12: Live verify 5a**

Rebuild UI + restart server; on `journey2`, in the Braindump step drop a file, submit, and confirm (DB) a `braindump_capture` with `assetIds` + a `memory_assets` row at the department folder path, and the Librarian proposes items.

### Phase 5b — Repo code-reading for software departments

**Files:**
- Modify: `ui/src/onboarding/inflight/BraindumpStep.tsx` (activate the repo affordance for software depts)
- Modify: `ui/src/api/braindump.ts` + `server/src/services/braindump.ts` (carry `repoIngest` + resolved repo path)
- Modify: `server/src/services/internal-agent/aoa-agents/aoa-trigger-prompt.ts` (inject repo path + code-reading directive + seeded-folder list)
- Modify: `server/src/services/default-agent-instructions.ts` (Librarian directive supports repo ingestion)
- Tests: trigger-prompt test (repo branch), braindump service test (repoIngest flag), directive-content test

- [ ] **Step 1: Determine the repo path source**

Read `BraindumpStep.tsx`'s `repoChipFor` (uses `project.primaryWorkspace?.repoUrl || cwd`) and how a software department's workspace path is available server-side at ingest time. Pin whether the Librarian reads the live workspace `cwd` or a cloned path (record the decision in the plan's assumptions).

- [ ] **Step 2: Write the failing trigger-prompt test (repo branch)**

Assert that, for a software department with `repoIngest: true` + a repo path, the `braindump.ingest` directive includes the repo path, an instruction to explore the code and extract durable architecture/conventions knowledge, and the department's seeded-folder list for `write_memory`. Run; expected FAIL.

- [ ] **Step 3: Implement the repo directive + folder list**

Extend `aoa-trigger-prompt.ts` (+ `default-agent-instructions.ts` Librarian directive) to inject, when `repoIngest`, the repo path + a bounded code-reading instruction + the seeded folder list (from `getSeedFoldersForFunctionType`), preserving the "propose, don't invent, no tool if nothing durable" guardrail and depth/size/time bounds. Run the test; expected PASS.

- [ ] **Step 4: Wire the flag through capture**

Extend `braindumpApi.submit` + the server service to carry `repoIngest` (true when the dept is software + has a connected repo) and persist/pass it. Add a service test asserting the flag flows to the trigger. Run; expected PASS.

- [ ] **Step 5: UI — activate the repo affordance**

In `BraindumpStep.tsx`, for software departments with a repo chip, set `repoIngest` on submit and surface copy ("The Librarian will read this repo"). Add/adjust the component test. Run UI tests + typecheck; expected PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/onboarding/inflight/BraindumpStep.tsx ui/src/api/braindump.ts server/src/services/braindump.ts server/src/services/internal-agent/aoa-agents/aoa-trigger-prompt.ts server/src/services/default-agent-instructions.ts server/src/__tests__ ui/src/onboarding/inflight/__tests__/BraindumpStep.test.tsx
git commit -m "feat(onboarding): Librarian reads the connected repo for software departments"
```

- [ ] **Step 7: Live verify 5b**

On `journey2`, create a software department with a real connected repo, run the braindump step with repo ingestion, and confirm the Librarian proposes memory items derived from the repo, filed into the seeded folder structure. Approve one and confirm it lands in Memory.

- [ ] **Step 8: LibrarianStep polish**

Show attached files + a repo-reading state in `LibrarianStep.tsx`; add a component test; commit.

---

## Self-review coverage map

| Spec item | Plan task(s) |
|-----------|--------------|
| 1 Splash real SVG logo | Item 1 (Steps 1–8) |
| 2 Agent-picker filter | Item 2 (Steps 1–9) |
| 3 Marketplace aoa-librarian | Item 3 (Steps 1–10) |
| 4 Unified phase chrome | Item 4 (Tasks 4.1–4.3) |
| 5 Memory rework (files) | Item 5 Phase 5a |
| 5 Memory rework (repo) | Item 5 Phase 5b |

**Assumptions to confirm during execution** (carried from the spec): exact phase labels (Item 4); whether the Librarian reads the live workspace `cwd` vs a cloned path (Item 5b Step 1); precise asset-upload + `memory_assets` function names (Item 5a Step 1). Each is pinned by a "read/confirm" step before its dependent code.
