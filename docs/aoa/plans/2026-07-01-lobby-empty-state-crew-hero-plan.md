# Lobby empty-state crew hero — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the flat no-organizations empty state with a warm "crew hero" — an animated arc of agent avatars around the founder — keeping Create the primary action.

**Architecture:** New presentational `CrewHero` component (illustrative, hardcoded agent icons — no live data) rendered by `LobbyEmptyState`, which swaps its Building2 icon + "Welcome to AoA" block for the crew + a thesis headline. Motion reuses existing `float-gentle` (Tailwind v4 `animate-float-gentle`) gated by `motion-safe:`. No new assets, no new keyframes.

**Tech Stack:** React + TailwindCSS v4, lucide-react, `AgentIcon` (`@/components/AgentIconPicker`), vitest + @testing-library/react.

**Design doc:** `docs/aoa/plans/2026-07-01-lobby-empty-state-crew-hero-design.md`

**Commands:**
- Unit (one file): `pnpm --filter @armyofagents/ui exec vitest run <path>`
- Unit (all): `pnpm --filter @armyofagents/ui test:run`
- Typecheck: `pnpm --filter @armyofagents/ui typecheck`

**Motion note:** `float-gentle` animates `transform: translateY`, so a static arc offset on the SAME element would be overwritten by the keyframe. Fix: put the static arc `translateY` on a WRAPPER div and the animation on the inner avatar. Founder float (transform) and its ring (box-shadow) don't conflict, but two `animate-*` classes DO (both set `animation`) — so the founder floats via a wrapper and uses a static `ring` (not `pulse-glow`) for calm.

---

## Task 1: `CrewHero` component

**Files:**
- Create: `ui/src/components/lobby/CrewHero.tsx`
- Test: `ui/src/components/lobby/__tests__/CrewHero.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `ui/src/components/lobby/__tests__/CrewHero.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { CrewHero } from "../CrewHero";

describe("CrewHero", () => {
  it("renders 5 avatars (founder + 4 crew), each with one icon", () => {
    const { container } = render(<CrewHero />);
    expect(container.querySelectorAll("svg").length).toBe(5);
  });

  it("is decorative — the cluster is aria-hidden", () => {
    const { container } = render(<CrewHero />);
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  it("merges a passed className onto the cluster root", () => {
    const { container } = render(<CrewHero className="mt-2" />);
    expect((container.firstElementChild as HTMLElement).className).toContain("mt-2");
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/components/lobby/__tests__/CrewHero.test.tsx`
Expected: FAIL (cannot find `../CrewHero`).

- [ ] **Step 3: Implement `CrewHero`**

Create `ui/src/components/lobby/CrewHero.tsx`:

```tsx
import { User } from "lucide-react";
import { AgentIcon } from "@/components/AgentIconPicker";
import { cn } from "@/lib/utils";

// Illustrative crew — the empty lobby has no company/agents yet, so this is a
// hardcoded brand visual (not live data). Icons come from the app's AgentIcon set.
const CREW = [
  { icon: "crown", tint: "#c98a4b", label: "Commander", y: 6, delay: "0s" },
  { icon: "target", tint: "#5aa0e0", label: "Planner", y: -6, delay: "0.35s" },
  { icon: "radar", tint: "#7ac07a", label: "Scout", y: -6, delay: "0.5s" },
  { icon: "wrench", tint: "#b48ad8", label: "Engineer", y: 6, delay: "0.25s" },
] as const;

function CrewAvatar({ icon, tint, y, delay }: (typeof CREW)[number]) {
  // Wrapper carries the static arc offset; inner carries the float animation
  // (float-gentle overwrites `transform`, so the two must be on separate nodes).
  return (
    <div style={{ transform: `translateY(${y}px)` }}>
      <div
        className="flex size-[60px] items-center justify-center rounded-[18px] border border-border bg-card motion-safe:animate-float-gentle"
        style={{ color: tint, animationDelay: delay }}
      >
        <AgentIcon icon={icon} className="size-[26px]" />
      </div>
    </div>
  );
}

/** Decorative animated crew cluster for the lobby empty-state hero. */
export function CrewHero({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-end justify-center gap-3.5", className)} aria-hidden="true">
      {CREW.slice(0, 2).map((m) => (
        <CrewAvatar key={m.label} {...m} />
      ))}
      {/* Founder ("you") — centered, larger, brand-red, static ring. Float lives
          on the wrapper so it doesn't fight the avatar's ring. */}
      <div className="motion-safe:animate-float-gentle" style={{ animationDelay: "0.15s" }}>
        <div className="flex size-[74px] items-center justify-center rounded-[22px] bg-brand text-white ring-4 ring-brand/20">
          <User className="size-8" />
        </div>
      </div>
      {CREW.slice(2).map((m) => (
        <CrewAvatar key={m.label} {...m} />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/components/lobby/__tests__/CrewHero.test.tsx`
Expected: PASS (3 tests). If `svg` count ≠ 5, confirm `AgentIcon` renders exactly one svg per icon and `User` one — adjust only if the render shape differs.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/lobby/CrewHero.tsx ui/src/components/lobby/__tests__/CrewHero.test.tsx
git commit -m "feat(lobby): add CrewHero component for empty-state"
```

---

## Task 2: Swap `LobbyEmptyState` to the crew hero

**Files:**
- Modify: `ui/src/components/LobbyEmptyState.tsx`
- Test: `ui/src/__tests__/LobbyEmptyState.test.tsx`

- [ ] **Step 1: Update the test for the new headline (TDD — assert the new copy)**

In `ui/src/__tests__/LobbyEmptyState.test.tsx`, replace the first test:

```tsx
  it("shows the crew-hero headline", () => {
    renderWithProviders(<LobbyEmptyState onCreate={vi.fn()} onImport={vi.fn()} />);
    expect(screen.getByText(/bigger than your headcount/i)).toBeInTheDocument();
  });
```

Leave the Create/Import CTA tests, the two invoke tests, and the "does NOT
auto-trigger" test unchanged — they must keep passing (no behavior change).

- [ ] **Step 2: Run — expect FAIL on the headline test**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/__tests__/LobbyEmptyState.test.tsx`
Expected: the new "crew-hero headline" test FAILS (old copy still says "Welcome to AoA"); the CTA tests still pass.

- [ ] **Step 3: Rewrite `LobbyEmptyState`**

Replace the body of `ui/src/components/LobbyEmptyState.tsx` with:

```tsx
import { Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CrewHero } from "@/components/lobby/CrewHero";

interface LobbyEmptyStateProps {
  onCreate: () => void;
  onImport: () => void;
}

/**
 * Crew-hero empty state shown when the lobby has zero companies.
 *
 * Dramatizes the product thesis (agents + humans) with an illustrative animated
 * crew ({@link CrewHero}), a thesis headline, and the create/import paths. The
 * crew is decorative (no company exists yet). Design-system §9.8 empty-state
 * pattern (brand-tinted radial wash bg); two CTAs so the EmptyState primitive
 * (single action) is not used.
 */
export function LobbyEmptyState({ onCreate, onImport }: LobbyEmptyStateProps) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-10 sm:px-6 sm:py-16 bg-[radial-gradient(ellipse_60%_50%_at_50%_30%,var(--brand-wash)_0%,transparent_70%)]">
      <div className="flex w-full max-w-xl flex-col items-center text-center">
        <CrewHero className="mb-7 sm:mb-9" />

        <h1 className="text-xl sm:text-2xl font-bold tracking-[-0.02em] text-foreground">
          Your team is bigger than your headcount<span className="text-brand">.</span>
        </h1>
        <p className="mt-2 max-w-md text-[0.82rem] sm:text-sm text-dim leading-relaxed">
          Create an organization and put your agents to work alongside you — humans
          and AI, one control room.
        </p>

        <div className="mt-6 sm:mt-8 flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center sm:gap-3">
          <Button size="lg" onClick={onCreate}>
            <Plus />
            Create organization
          </Button>
          <Button size="lg" variant="secondary" onClick={onImport}>
            <Upload />
            Import organization
          </Button>
        </div>
      </div>
    </div>
  );
}
```

(This drops the `Building2` import and the old hero-icon block; keeps the outer
wash container + the two `Button`s + props exactly.)

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/__tests__/LobbyEmptyState.test.tsx`
Expected: PASS (headline + both CTAs + invokes + no-auto-trigger).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/LobbyEmptyState.tsx ui/src/__tests__/LobbyEmptyState.test.tsx
git commit -m "feat(lobby): crew-hero empty state (thesis headline + crew, no chips)"
```

---

## Task 3: Full verification + live check

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `pnpm --filter @armyofagents/ui typecheck`
Expected: no errors.

- [ ] **Step 2: Full UI suite**

Run: `pnpm --filter @armyofagents/ui test:run`
Expected: all green (new CrewHero + updated LobbyEmptyState + existing Lobby.test which mocks LobbyEmptyState — unaffected).

- [ ] **Step 3: Live-verify on the empty-state instance (:3281)**

The dev instance auto-HMRs. Using the gstack browse binary
(`~/.claude/skills/gstack/browse/dist/browse`):
- `goto http://127.0.0.1:3281/` → the lobby is empty (fresh DB) → the crew hero
  renders. Screenshot; `console --errors` clean.
- Confirm: 5 avatars in an arc (founder centered, brand-red), headline + subhead,
  Create + Import buttons, no chips.
- `preview_resize`/`viewport` narrow (mobile) → confirm the hero + CTAs stack and
  fit; confirm at ~700px height the hero doesn't overflow.
- Optional: DevTools emulate `prefers-reduced-motion: reduce` (or `viewport` note)
  → the float animation stops (motion-safe gate).

Expected: crew hero renders, zero console errors, Create/Import still open the
onboarding / navigate to `/import`.

- [ ] **Step 4: Screenshot proof for the user**

Save a screenshot of the live crew hero and share it.

---

## Self-review notes

- **Spec coverage:** E1 5-avatar arc → Task 1; E2 distinct tints → `CREW` tints; E3 illustrative/hardcoded → `CREW` const + `aria-hidden`; E4 no chips → not rendered; E5 motion `float-gentle` + `motion-safe:` + reduced-motion → Task 1 classes + Task 3 verify; E6 keep onCreate/onImport → Task 2 unchanged props/buttons. Testing → Tasks 1-3.
- **Placeholder scan:** none — every step has concrete code/commands.
- **Type consistency:** `CrewHero({ className })`, `CREW` item shape `{icon,tint,label,y,delay}` used consistently in `CrewAvatar` (`(typeof CREW)[number]`); `AgentIcon` prop is `icon: string`. `LobbyEmptyStateProps` unchanged.
- **Risk flagged in plan:** the float-vs-transform and two-`animate-*` conflicts are handled by the wrapper/inner split (see Motion note).
