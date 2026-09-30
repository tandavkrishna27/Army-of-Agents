# Onboarding — Finish & Land in v1 (handoff prompt)

> Paste the section below into a fresh session (in a worktree off `feat/v1-combined`) to pick up and finish the onboarding work.

---

## Goal
Finish the first-run onboarding experience and land it in `feat/v1-combined`. It's two separate pieces:
1. **FirstActionPrompt** — already complete; bring it into v1.
2. **Welcome splash + onboarding-state refactor** — ~30% built and never wired; decide the scope, wire it into the live setup wizard, or trim it.

## Where the parked code lives
- Branch: **`feat/onboarding-first-run`** (commit `d97e235d2`) in the AoA repo (`github.com/MeteoriteLabs/AoA`). It branches off the crew arc — **rebase it onto `feat/v1-combined`** (the v1 trunk) before working. (The branch is LOCAL only — `git push -u origin feat/onboarding-first-run` first if you want an off-machine backup.)
- Files on that branch:
  - **Complete (FirstActionPrompt):** `ui/src/components/FirstActionPrompt.tsx`, `ui/src/hooks/useFirstActionPrompt.ts`, + wiring in `ui/src/pages/Dashboard.tsx`.
  - **Parked (~30%, never wired):** `ui/src/components/WelcomeScreen.tsx` (+ `__tests__/WelcomeScreen.test.tsx`), `ui/src/context/OnboardingContext.tsx`, `ui/src/hooks/useOnboardingStep.ts`, the `OnboardingProvider` mount in `ui/src/main.tsx`, and `docs/onboarding-state-management.md`.

## The lay of the land (READ THIS FIRST)
- The **live, working setup wizard is `ui/src/components/OnboardingWizard.tsx`** — an 8-step flow (company → root folder → Commander provider → Crew provider → first agent → first task → discussions → launch). It manages ALL its state with internal `useState`, calls the real APIs, and is opened via `openOnboarding()`.
- The parked `OnboardingContext` is a **separate, redundant re-implementation** of that wizard's state (8 steps: welcome / profile / rootFolder / commander / crew / firstAgent / firstAction / completion) + localStorage persistence. It is **never imported by the live wizard** — `WelcomeScreen` is never rendered; the `OnboardingProvider` wraps the app but nothing calls its hooks.
- `FirstActionPrompt` is **independent** (a post-setup "what do you want to do first?" dialog wired into Dashboard) and does NOT depend on OnboardingContext.

## What "done" should mean (settle in brainstorming)
- **Minimum:** land `FirstActionPrompt` in v1 — it's complete, tested, and adds real first-run value.
- **Welcome splash:** decide whether to show `WelcomeScreen` before the wizard (a polished intro) — small wiring.
- **Wizard refactor (the big call):** decide whether to refactor the live `OnboardingWizard` to consume `OnboardingContext` (centralized state + persistence + *resumable* onboarding), OR keep the wizard's internal state and drop the redundant context. Refactoring re-plumbs a working wizard — only do it if persistence/resumability is an actual goal.

## Suggested approach
1. `git worktree add ../AoA-onboarding feat/onboarding-first-run`, then `git rebase feat/v1-combined`.
2. Use brainstorming → writing-plans → subagent-driven-development (gstack/superpowers): first settle scope (FirstActionPrompt-only vs +welcome vs +wizard-refactor), then plan, then build.
3. Verify: `pnpm -r typecheck` + `pnpm -r build` + the onboarding/welcome tests. **Do not break `OnboardingWizard.tsx`** (its committed test must stay green).
4. Land via a feature branch off `feat/v1-combined` → merge back into v1-combined.

## Constraints
- Base everything off `feat/v1-combined` (the v1 trunk).
- Don't break the shipped `OnboardingWizard.tsx`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
