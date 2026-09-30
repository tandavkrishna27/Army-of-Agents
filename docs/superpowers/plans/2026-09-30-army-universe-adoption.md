# Army Universe Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the reviewed Universe interface work from the MeteoriteLabs AoA Universe branch into the Army of Agents repository without touching Army `main` directly.

**Architecture:** Army is a fresh export repository whose application files match AoA `origin/main`, while the Universe work lives on a separate MeteoriteLabs worktree with a different commit graph. Adoption therefore uses content-level porting into an isolated Army branch, with local tests and app review as the authority instead of Git ancestry.

**Tech Stack:** React 19, Vite 6, Tailwind v4, Express 5, Drizzle, PostgreSQL, Vitest, pnpm workspaces.

**Spec:** `docs/architecture/commander-canvas/README.md` and `docs/architecture/commander-canvas/execution-sequence.md` after the planning packet is imported.

## Global Constraints

- Work only in `C:\Users\TK\OneDrive\Desktop\Army-of-Agents-worktrees\universe-interface` on branch `codex/universe-interface`.
- Do not modify Army `main` directly.
- Keep product behavior aligned with `CLAUDE.md`, `docs/architecture/decisions.md`, and `docs/roadmap.md`.
- Preserve the dedicated Universe workspace route: no sidebar inside Universe; entry comes from Commander and the lobby company card.
- Port by content because Army's history is a short export history, not the MeteoriteLabs AoA history.
- Do not claim B12 or later distributed-execution/browser qualification unless the required replatform execution owner, output binding, and browser runtime gates exist and pass in Army.
- Use Drizzle schema files and generated migrations for DB schema changes; do not hand-author schema DDL.
- Verification before handoff: focused tests for the wave, then `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build` unless a command is blocked and explicitly reported.

## Review Focus

- Dedicated-route shell: opening Universe from Commander or lobby must not render the normal board sidebar.
- Layout persistence and recovery: reloads must recover tab-only unsaved layout state without storing chat text or file contents.
- Panel lifecycle: open, drag, resize, minimize, restore, maximize, pin, close, and selection styling must work consistently for task and artifact panels.
- Route authority: task routes, attention items, and open-panel references must be company-scoped and conversation-scoped.
- Blocked execution/browser slices: B12+ must stay marked blocked until Army has real replatform evidence, not implied by copied docs.

---

### Task 1: Import Universe Planning Packet And Adoption Status

**Files:**
- Create: `docs/architecture/commander-canvas/**`
- Modify: `docs/superpowers/plans/2026-09-30-army-universe-adoption.md`

**Interfaces:**
- Consumes: MeteoriteLabs Universe planning packet from `C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-2.5\.worktrees\universe-interface\docs\architecture\commander-canvas`.
- Produces: Army-local plan/spec sources for subsequent implementation tasks.

- [ ] **Step 1: Copy the planning packet**

Copy `docs/architecture/commander-canvas/**` from the Universe worktree into the Army worktree.

- [ ] **Step 2: Add Army adoption note**

Record in `docs/architecture/commander-canvas/army-adoption-status.md`:
- Army base commit: `66e6bd6`.
- Army branch: `codex/universe-interface`.
- Port mode: content-level port from MeteoriteLabs Universe branch.
- B12+ status: blocked until execution/browser replatform gates are present in Army.

- [ ] **Step 3: Verify documentation inventory**

Run: `rg --files docs/architecture/commander-canvas | Measure-Object`

Expected: non-zero file count and `execution-sequence.md` present.

- [ ] **Step 4: Commit**

Commit message: `docs(universe): import adoption plan packet`

### Task 2: Port Universe Foundation And Dedicated Route

**Files:**
- Create/modify: Universe shared validators/types, DB schema, server routes/services, `ui/src/pages/Universe*.tsx`, `ui/src/components/universe/**`, route wiring, lobby and Commander entry points.
- Test: Universe UI/server/shared tests copied with the port.

**Interfaces:**
- Consumes: planning packet and current Army app shell.
- Produces: a dedicated Universe route and core canvas/panel system in Army.

- [ ] **Step 1: Apply Universe code content**

Apply the Universe implementation content from the MeteoriteLabs Universe branch, excluding generated evidence logs that are not needed for Army runtime review.

- [ ] **Step 2: Preserve Army public/export docs**

Keep Army-only docs currently absent from MeteoriteLabs AoA main:
- `docs/aoa/reports/first-install-report.md`
- `docs/contributing/public-docs-style.md`
- `docs/guides/board-operator/company-brain.md`
- `docs/guides/board-operator/crew.md`
- `docs/start/first-agent-run.md`

- [ ] **Step 3: Run focused tests**

Run: `pnpm exec vitest run ui/src/pages/UniverseRoute.test.tsx ui/src/pages/Universe.test.tsx ui/src/components/universe/__tests__/UniverseWorkspace.test.tsx`

Expected: all selected tests pass.

- [ ] **Step 4: Run route/shell review**

Start the dev server and verify:
- Commander entry opens Universe.
- Lobby company card Universe icon opens Universe.
- Universe route does not show the normal board sidebar.

- [ ] **Step 5: Commit**

Commit message: `feat(universe): add dedicated workspace route`

### Task 3: Port Persistence, Drafts, Attention, And Preferences

**Files:**
- Create/modify: Universe layout, draft, attention, intake, preference schemas/routes/services/hooks/tests.

**Interfaces:**
- Consumes: Task 2 route and core UI.
- Produces: persisted/recoverable panel state, draft handling, attention rail, preferences, and intake foundations.

- [ ] **Step 1: Verify schemas and exports**

Check that every new Universe DB schema file is exported from `packages/db/src/schema/index.ts` and every shared validator is exported from `packages/shared/src/index.ts`.

- [ ] **Step 2: Run focused shared/server tests**

Run: `pnpm exec vitest run packages/shared/src/__tests__/universe-layout.test.ts packages/shared/src/__tests__/universe-draft.test.ts packages/shared/src/__tests__/universe-preferences.test.ts server/src/__tests__/universe-layout-service.test.ts server/src/__tests__/universe-attention-projection.test.ts`

Expected: all selected tests pass.

- [ ] **Step 3: Run focused UI state tests**

Run: `pnpm exec vitest run ui/src/components/universe/__tests__/panel-state.test.ts ui/src/components/universe/__tests__/tray-state.test.ts ui/src/components/universe/useUniverseState.test.tsx ui/src/components/universe/useUniverseDraft.test.tsx`

Expected: all selected tests pass.

- [ ] **Step 4: Commit**

Commit message: `feat(universe): add persistence and attention state`

### Task 4: Reconcile Replatform-Dependent Foundations

**Files:**
- Create/modify only what Universe already requires for current implemented waves: credential purpose policy, shared spend capacity reservation, and any schema/services required by focused tests.
- Do not claim distributed execution/browser B12 readiness unless the required owner/output/browser gates are implemented and pass.

**Interfaces:**
- Consumes: Task 3 Universe state.
- Produces: enough backend foundation for implemented Universe waves to typecheck and build in Army.

- [ ] **Step 1: Check B12 gates directly in Army**

Run `rg` checks for:
- `server/src/services/job-admission-bridge.ts`
- `server/src/services/job-output-bridge.ts`
- Browser runtime packages and launch guard files.

Expected: document present/missing state in `docs/architecture/commander-canvas/army-adoption-status.md`.

- [ ] **Step 2: Keep B12+ blocked if gates are missing**

If the execution owner/output/browser gates are missing, record the block and do not implement B12+.

- [ ] **Step 3: Run credential/spend focused tests**

Run the focused tests covering credential purpose scope and shared budget reservation after the port.

Expected: all selected tests pass, or blockers documented if tests depend on missing replatform code.

- [ ] **Step 4: Commit**

Commit message: `feat(universe): add credential and spend foundations`

### Task 5: Full Verification And Local App Review

**Files:**
- Modify only fixes required by verification.

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: a pushed Army branch that the user can run and inspect locally.

- [ ] **Step 1: Run full static/build verification**

Run:
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`

Expected: pass, or exact failures recorded with whether they are pre-existing, port-caused, or blocked by missing replatform foundations.

- [ ] **Step 2: Run local app**

Start the local app with `pnpm dev` or the repo's dev command on an available port.

- [ ] **Step 3: Browser-check the main journey**

Verify:
- Lobby loads.
- Universe entry exists on company card.
- Commander entry opens Universe.
- Dedicated Universe route renders without normal sidebar.
- Panels open and basic lifecycle controls work.

- [ ] **Step 4: Push branch**

Push `codex/universe-interface` to `origin`.

- [ ] **Step 5: Final report**

Report branch, commits, verification commands, local URL, and any blocked slices.
