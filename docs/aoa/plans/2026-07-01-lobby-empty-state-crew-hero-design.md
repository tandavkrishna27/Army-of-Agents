# Lobby empty-state "crew hero" — Design

**Date:** 2026-07-01
**Branch:** `feat/lobby-empty-state` (off main, which now includes the lobby chrome + persistent shell from PR #255)
**Status:** Approved (design), pending implementation plan
**Author:** TK + Claude

---

## Problem

The no-organizations lobby (first screen after install, zero companies) is a flat
`Building2` icon + "Welcome to AoA" + two buttons (`LobbyEmptyState.tsx`). It's
functional but cold — it doesn't sell what AoA is or feel alive. The founder just
installed an "Army of Agents" product and sees a generic building icon.

## Goal

Replace the empty-state hero with a warm, on-brand **"crew hero"** that dramatizes
the product thesis (agents + humans working together) while keeping **Create** the
clear primary action. Conversion-first, warm-not-cold. Use only existing motion
primitives + the existing `AgentIcon` system — **no new art/lottie/assets**.

## Approved direction (validated via mock)

Primary job: **drive the first Create action**, with a light thesis line and a
touch of life so it doesn't feel empty. Confirmed against an HTML mock.

## Composition (centered hero)

Top → bottom, replacing the current icon + heading block:

1. **Crew cluster** — a shallow arc of 5 squircle avatars:
   - Center: the **founder** ("you") — larger (~74px), brand-red fill, `User` icon,
     soft brand glow (`pulse-glow`).
   - Flanking (2 left, 2 right, ~60px): four **illustrative** agent characters using
     `AgentIcon` — Commander (`crown`), Planner (`target`), Scout (`radar`),
     Engineer (`wrench`). Each tinted a distinct role color.
   - All avatars bob with `float-gentle` at staggered delays; arc shape via small
     alternating vertical offsets.
   - **Illustrative only** — the empty lobby has no company/agents, so the crew is a
     hardcoded curated set (icon name + tint), NOT live data.
2. **Headline** (one line): "Your team is bigger than your headcount**.**" (brand-red
   period, matching the wordmark).
3. **Subhead** (one line): "Create an organization and put your agents to work
   alongside you — humans and AI, one control room."
4. **CTAs** — **Create organization** (primary, `onCreate`) + **Import organization**
   (secondary, `onImport`). Unchanged behavior/props.
5. **No starter chips.** (Decided: no real solo/template preset flow exists;
   `openOnboarding` only takes `initialStep`/`companyId`. Chips would be
   decorative/duplicative — dropped per YAGNI. Real presets = separate future feature.)

## Decisions (locked)

| # | Decision | Rationale |
|---|----------|-----------|
| E1 | Crew = 5 avatars, founder centered + larger + glow, 4 illustrative agents flanking. | Reads as "you + your agents" instantly; 5 is balanced (4 too sparse, 6 busy). |
| E2 | Each agent a distinct role tint (not uniform). | Mock looked good multi-tint; conveys a varied "crew," not clones. |
| E3 | Crew is illustrative/hardcoded, not live data. | No company/agents exist on the empty lobby. |
| E4 | No chips. | No real preset flow; YAGNI. Create/Import cover both real paths. |
| E5 | Motion = existing `float-gentle` + `pulse-glow` + lobby mount choreography; honor `prefers-reduced-motion`. | Zero new deps; matches the codebase; a11y-safe. |
| E6 | Keep `onCreate`/`onImport` props + behavior exactly. | No regression; the empty state's contract is unchanged. |

## Components / files

- **Modify:** `ui/src/components/LobbyEmptyState.tsx` — replace the icon+heading+copy
  block with the crew hero. Keep the `LobbyEmptyStateProps` (`onCreate`, `onImport`)
  and the two `Button`s.
- **New (small):** `ui/src/components/lobby/CrewHero.tsx` — the crew-cluster visual
  (pure presentational; no props or a tiny `className`). Keeps `LobbyEmptyState`
  focused and the crew independently testable.
- **Maybe:** `ui/src/index.css` — only if a new keyframe is needed. Prefer reusing
  `float-gentle` + `pulse-glow`; add a scoped arc/stagger via inline `style` or a
  tiny utility. No new keyframe if avoidable.
- **Crew data:** a local `const CREW = [{ icon, tint, label }]` in `CrewHero.tsx`
  (illustrative). Icons via `AgentIcon`/`getAgentIcon`. Tints: reuse `avatar-color`
  or a small local palette of role tints (amber/blue/green/purple + brand for you).

## Motion detail

- Avatars: `animate-float-gentle` (existing) with per-avatar `animationDelay` (inline
  style, staggered ~0.15s) and a small base `translateY` for the arc.
- Founder: additional `animate-pulse-glow` (existing) or a static brand ring.
- Entrance: wrap the hero in the existing lobby mount-choreography classes if they
  compose cleanly; otherwise a simple fade/rise. Reduced-motion: existing
  `@media (prefers-reduced-motion: reduce)` already zeroes `float-gentle`/`pulse-glow`
  usage patterns; verify the new usage is covered (add to the media query if needed).

## Accessibility

- Crew avatars are decorative → `aria-hidden="true"` on the cluster; the headline +
  subhead carry the meaning for screen readers.
- CTAs remain real `<Button>`s (already accessible).
- Motion respects `prefers-reduced-motion`.

## Testing

- **`LobbyEmptyState.test.tsx` (update):** still renders the headline, still fires
  `onCreate` on the Create button and `onImport` on Import. Remove any assertion tied
  to the old Building2 icon / "Welcome to AoA" copy; assert the new headline text.
- **`CrewHero.test.tsx` (new):** renders 5 avatars; the founder avatar is present
  (distinct marker); cluster is `aria-hidden`. (Icons are `AgentIcon` svgs — assert
  count, not specific paths.)
- Existing `Lobby.test.tsx` (mocks `LobbyEmptyState`) is unaffected.

## Risks / edge cases

- **Motion jank on low-end:** `float-gentle` is a cheap transform animation; 5 nodes
  is trivial. Reduced-motion covered.
- **Vertical fit on short viewports:** the hero is centered; on very short screens the
  crew + copy + CTAs must not overflow. Use compact spacing + it already lives in a
  scroll container (`main` is `overflow-auto`). Verify at ~700px height.
- **Illustrative crew mistaken for real agents:** acceptable — it's clearly a brand
  hero on a zero-state; copy frames it as "your agents" aspirationally.

## Non-goals

- No changes to the populated lobby (org cards), the sidebar, or onboarding.
- No real "solo/template" preset flows (separate feature).
- No new illustration assets / lottie / animation libraries.
