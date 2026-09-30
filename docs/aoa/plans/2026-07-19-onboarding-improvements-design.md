# Onboarding Improvements — Design Spec

**Date:** 2026-07-19
**Branch:** `claude/signup-onboarding-ui-animations-0724cb`
**Status:** Design approved (decisions locked below); pending user review of this spec → implementation plan.

## Overview

Five focused improvements to the onboarding experience, discovered during live QA of the isolated Google-auth instance (`journey2`, `:3100`). They are independent enough to build and verify **one at a time**, smallest/safest first. Each item below is self-contained: current state → target → approach → files → tests.

Ordering for implementation (smallest, lowest-risk first):
1. Splash logo (tiny)
2. Agent-picker filter (small)
3. Marketplace PR — `aoa-librarian` (medium, external repo, diff-reviewed before push)
4. Unify flow chrome — phase model (medium)
5. Memory step rework — files + repo ingestion (large)

Non-negotiables inherited from the codebase:
- Keyless-except-embeddings (Decision #104): the Librarian is a **CLI agent**; no hosted-key extraction. The memory rework stays CLI-based.
- Agents cannot write Memory directly (Decisions #15/#52): the Librarian **proposes** items (status `pending`); the founder approves.
- Drizzle ORM only for schema; follow existing service/route patterns.

---

## Item 1 — Splash logo: use the real SVG `AoaLogo`

**Current:** `ui/src/onboarding/motion/AoaLogo.tsx` is a **CSS fake** — the letters `A`, a CSS-`border` ring spun via `obd-spin` as the "o", `A`, and a CSS dot. `SplashScreen.tsx` renders it over `ConstellationBg` with a typewriter status line.

**Target:** the **real brand SVG** wordmark, sourced from `MeteoriteLabs/AoA-Website` main: `client/src/components/animations/AoaLogo.tsx` (real vector letterforms + breathing red `aoa-dot` path) and the logo-relevant keyframes from that repo's `animations.css`. Keep constellation + typewriter.

**Approach:**
- Fetch `AoaLogo.tsx`, `animations.css` from `MeteoriteLabs/AoA-Website` main (authoritative — confirmed by the user; local copies diverge).
- Replace the app component's **internals** with the real SVG, but **keep the app's existing `{ size, hideDot }` prop API** (website uses `width`; app callers pass `size`). Compute `width` from `size` inside. This means **zero churn** for the three callers: `SplashScreen`, `steps/SpineCompleteStep`, `pages/Auth`.
- Port only the **logo keyframes** (e.g. the `aoa-dot` breathe, any letter draw/reveal) from the website `animations.css` into the app's `motion.css` — do not import the whole 13KB website CSS. Namespace/scope to avoid collisions.
- Delete the dead `obd-spin` ring styles once nothing references them.

**Files:** `ui/src/onboarding/motion/AoaLogo.tsx` (replace internals), `ui/src/onboarding/motion/motion.css` (add logo keyframes), possibly `motion/index.ts` (unchanged export). Callers unchanged.

**Tests:** update `motion/__tests__/AoaLogo.test.tsx` to assert the SVG renders with `role="img"` + `aria-label` and honors `hideDot`; `SplashScreen` test (typewriter → `onDone`) stays green.

**Risk:** low. Pure component swap behind a stable API.

---

## Item 2 — Agent-picker: hide the AoA curated crew

**Current:** `ui/src/onboarding/inflight/CreateAgents.tsx` renders `[...filterByType(catalog.items, "agent"), ...filterByType(catalog.items, "team")]` — i.e. the **whole catalog**, so the AoA curated crew shows up in the picker.

**Target:** hide AoA-curated items; still show **other** marketplace agents **and** teams.

**Approach:**
- AoA-curated items are marked by `source.adapter === "aoa-curated"` (verified against the live CDN catalog; e.g. `id: "agent:aoa-curated/aoa-adjutant"`).
- Add a pure predicate `isAoaCuratedItem(item)` in `ui/src/api/marketplace.ts` (next to `filterByType`), and filter it out in `CreateAgents` before `setCatalogItems`.
- This affects **only the onboarding agent picker**. The full Marketplace page is unchanged (AoA crew still browsable there).

**Files:** `ui/src/api/marketplace.ts` (predicate), `ui/src/onboarding/inflight/CreateAgents.tsx` (apply filter).

**Tests:** unit test for `isAoaCuratedItem` (aoa-curated excluded; regular agents/teams kept); a CreateAgents test asserting an aoa-curated catalog item does not render in the picker.

**Risk:** low.

---

## Item 3 — Marketplace PR: add `aoa-librarian`

**Current:** `MeteoriteLabs/aoa-marketplace` (the **source** repo) has `content/agents/aoa-*` (adjutant, chronicler, engineer, memory-keeper, navigator, planner, reviewer, scout) and `content/teams/default-crew/team.json`. There is **no `aoa-librarian`**, so it's absent from the published catalog. The app **auto-seeds** the Librarian locally on company create, but a new teammate installing/reconciling the crew from the marketplace would not get it.

**Publish flow (confirmed):** `aggregate.yml` runs on push to `main` → builds `dist/catalog.json` → **clones `aoa-marketplace-cdn` and pushes `catalog.json`** (GitHub Pages) → the app reads `meteoritelabs.github.io/aoa-marketplace-cdn/catalog.json`. So a **merged PR flows to the app automatically** — no manual CDN step.

**Target:** add `content/agents/aoa-librarian/` and wire it into `content/teams/default-crew/team.json`, modeled on `aoa-memory-keeper`, with content sourced from the app's existing Librarian instructions so the marketplace agent matches the seeded one.

**Approach:**
- Clone `MeteoriteLabs/aoa-marketplace`, branch, create `content/agents/aoa-librarian/{agent.json, manifest.json, + instruction .md files}` mirroring `aoa-memory-keeper`'s shape.
- Add `aoa-librarian` to `content/teams/default-crew/team.json` `agents` array.
- Run the repo's own `catalog-schema` / `aggregate` tests locally to confirm it validates.
- **Show the full diff to the user before pushing / opening the PR** (external repo — publish action requires explicit go-ahead per interaction).

**Files (external repo):** `content/agents/aoa-librarian/*`, `content/teams/default-crew/team.json`, changeset if required.

**Tests:** the aoa-marketplace repo's existing `catalog/src/__tests__` (aggregate + schema) must pass with the new agent.

**Verification:** after merge, confirm `catalog.json` on the CDN includes `agent:aoa-curated/aoa-librarian`; the app's marketplace reconcile picks it up.

**Risk:** medium — external repo; content must match the app's Librarian; gated behind user diff review.

---

## Item 4 — Unify the flow chrome (phase model)

**Current:** the spine runs in `FlowEngine` with a "Step N of 6" stepper-pip row. After it, `OnboardingFlow` renders `FirstRunHome` → persona door (`Map`) → `InFlightFlow` (6 tail surfaces), each a standalone screen with its own Continue and **no shared progress**. The seam is why it "feels like separate flows."

**Target:** one **phase model** spanning the whole `/onboarding` flow:
- **Phase 1 — Setup:** the 6 spine steps (Profile → Company → Environment → Commander → Verify → spine-complete).
- **Phase 2 — Your world:** persona pick → Departments → Integrations → Braindump → Librarian.
- **Phase 3 — Your crew:** Create agents → First job.

A top **phase rail** (3 phases, current highlighted) with a **sub-step indicator** inside the active phase, plus the shared dark shell + back affordance already present. Handles the Explorer persona (which short-circuits phase 2/3) gracefully — phases can complete early.

**Approach:**
- New presentational component `ui/src/onboarding/OnboardingChrome.tsx`: renders the phase rail + sub-step dots given `{ phase, subStep, subTotal }`. Pure/dumb.
- A single source of truth for position lives in `OnboardingFlow`. The two sub-flows report their internal position upward:
  - `FlowEngine` gains an `onProgress?(index, total)` callback (it already computes `stepNumber`/`applicableSteps.length`) → maps to Phase 1 sub-steps.
  - `InFlightFlow` gains an `onProgress?(index, total)` callback (it already tracks `index`/`IN_FLIGHT_SURFACES.length`) → maps to Phase 2/3 sub-steps.
  - The persona door (`Map` in `FirstRunHome`) marks the start of Phase 2.
- `OnboardingFlow` maps `(spine active step | spineDone + inflight index | persona pending)` → `(phase, subStep, subTotal)` and renders `OnboardingChrome` above the active sub-flow.
- `FlowEngine`'s existing stepper pips are **subsumed** into the phase rail (removed from FlowEngine, or kept only as the sub-step indicator within Phase 1) to avoid double progress UI.

**Files:** new `OnboardingChrome.tsx`; `OnboardingFlow.tsx` (own the mapping + render chrome); `FlowEngine.tsx` (`onProgress` + drop its own pips); `InFlightFlow.tsx` (`onProgress`); `FirstRunHome.tsx` / `Map.tsx` (persona = phase-2 start signal).

**Tests:** `OnboardingChrome` renders the right phase highlighted + sub-step count for representative positions; a mapping unit test: spine step 3 → (Setup, 3/6); braindump → (Your world, 3/4); first-job → (Your crew, 2/2); Explorer persona → phases 2/3 collapse. Existing FlowEngine/OnboardingFlow tests updated for the removed pips + new callback.

**Risk:** medium — touches routing/progress state across three components. Mitigation: the chrome is dumb; only the `onProgress` plumbing + the mapping function carry logic, and the mapping is unit-tested in isolation.

---

## Item 5 — Memory step rework: files + repo ingestion

**Current:** `BraindumpStep` = one **textarea per department** (+ a display-only repo/folder chip). Submit → `braindump_captures` → the Librarian is woken with **only the pasted text** in its trigger prompt (`aoa-trigger-prompt.ts` `braindump.ingest`, directive: "Do not invent facts that are not in the braindump content") → `write_memory` → domain memory items (pending) → `LibrarianStep` lists them for approval. No file drop; the repo is **not** read; output is memory items only.

**Target (confirmed scope — refined 2026-07-20):** a **multi-scope "seed your knowledge" step**, not one text box. Each scope gets its own **drop-any-files** surface (+ optional text); the Librarian ingests each and proposes memory at the **right layer** for founder approval (it never writes directly; identity + domain proposals are founder-approved per Decision #6/#15).

- **Company-wide surface** — one, at the top: vision / values / how-we-work. The Librarian proposes **identity-layer** memory into the company root folder.
- **Per-department surface** — one per department created. The Librarian proposes **domain-layer** memory into that department's seeded folders.
  - For a **software department** with a connected folder/GitHub repo (from setup), the surface **shows that repo/folder** as the ingest source, the Librarian **reads the repo's code directly** (it is a `claude_local` CLI agent with real file tools) to **generate docs**, AND the founder can **drop extra documents** too.
- Dropped files (any type) are stored and **attached into the seeded memory folder tree** (via `memory_assets`, which carries `companyId` + `folderPath` + `storageKey`) at the surface's scope (company root vs. department folder).
- Everything organizes into the **existing default seeded folder structure** (`getSeedFoldersForFunctionType` for departments; the company root for company-wide). Files attach to their folder; memory items are created (pending) at the right layer + folder.
- **Folder-guided placement:** the Librarian is given the scope's seeded folder tree and uses it to decide **which document to create and where to file it** — the structure guides the output, so a department's memory lands in its natural sub-folders (Overview / Decisions / Architecture / …).
- **Output by file type (refined 2026-07-20):**
  - **Text / documents** (notes, docs, code the Librarian reads) → the Librarian **synthesizes `.md` memory items** filed into the right folder.
  - **Images / binaries** (a logo, a diagram, a PDF, etc.) → **added directly to memory as an asset** in the folder (no `.md` conversion — the file itself is the memory). Some files are just attached as-is.
- **Drop-zone sub-text:** each surface shows helper copy listing **what they can add** (e.g. "notes, docs, a repo, a logo, diagrams, PDFs — anything the team should remember").
- (Project-scoped surfaces / active_context were considered and **deferred** — company + department only for v1.)

**Approach — extend the braindump pipeline (chosen over a new ingestion service):**
1. **Multi-scope drop UI:** rework `BraindumpStep` from one textarea into a list of scope cards — one **company-wide** card + one card per **department** — each with a textarea + a **drop-any-files** zone (upload via the existing asset/storage path; any type; 50MB cap; uploaded files shown as chips). A software department's card **shows its connected folder/GitHub repo** (derived as today via `repoChipFor`) as the ingest source + a "read this repo" affordance.
2. **Capture payload:** the braindump capture (`braindumpApi.submit` + server `braindump` service/route) carries, per scope: `scope` (`"company"` | `"department"`), the `departmentId` (null for company), `assetIds: string[]`, and a `repoIngest` flag (software dept + connected repo). One capture per non-empty scope surface. Persist alongside `content` on `braindump_captures`.
3. **Librarian trigger (server):** extend the `braindump.ingest` directive in `aoa-trigger-prompt.ts` to carry the **target layer per scope** — `identity` for the company-wide surface, `domain` for a department — plus:
   - the pasted `content`, **plus** the paths of dropped files (the CLI agent reads them via its file tools), **plus** — for `repoIngest` — the repo/workspace path with an instruction to explore the code and extract durable architecture/conventions/glossary knowledge.
   - the target folder for `write_memory` (company root vs. the department's **seeded folder list**).
   - Guardrail preserved: extract only durable knowledge actually present in the sources; nothing invented; nothing worth keeping → no tool call (non-failing). (The Librarian's instruction currently hardcodes `layer="domain"`; it must accept the passed layer.)
4. **File → folder linkage:** on capture, create `memory_assets` rows linking each dropped file to the scope's folder path (company root vs. department folder) so files live in the tree.
5. **LibrarianStep (UI):** show the proposed items grouped by scope (company / department) + attached files + repo-read progress; approve flow unchanged.

**Bounding:** repo reading gets depth/size/time caps so a single CLI run stays within budget; the existing `BRAINDUMP_CONTENT_PROMPT_CAP` still bounds pasted text; large repos are summarized, not exhaustively ingested.

**Files:** `ui/src/onboarding/inflight/BraindumpStep.tsx` (+drop zone), `ui/src/onboarding/inflight/LibrarianStep.tsx` (show files/progress), `ui/src/api/braindump.ts` (payload), `server/src/services/braindump.ts` + route (assetIds + repoIngest + memory_assets linkage), `server/src/services/internal-agent/aoa-agents/aoa-trigger-prompt.ts` (directive + context injection), Librarian instructions (`default-agent-instructions` / onboarding-assets). Reuse existing asset upload + `memory_assets` + `write_memory`.

**Tests:** braindump submit carries assetIds + repoIngest; `memory_assets` linkage created with correct `folderPath`; trigger-prompt includes file paths + repo path + seeded-folder list when applicable; directive-content unit test; UI drop-zone + chips test. (Server tests follow the mock-DB / pure-function patterns per CLAUDE.md.)

**Risk:** largest item. Because it spans UI + capture + agent prompt + storage + memory linkage, its **implementation plan may itself be split into sub-steps** (file-drop first, then repo ingestion). Called out for the writing-plans phase.

---

## Cross-cutting: verification & tests

Every item ships with: unit tests (per above), a green `ui` typecheck + relevant vitest suites, and — where observable — **live verification on the isolated `journey2` instance** (`:3100`, Google auth) with a UI rebuild. Server-route tests follow the drizzle-mock / pure-function patterns (some route tests only run in CI due to the known drizzle ESM cycle). No item is considered done until its tests pass and (if visible) it's verified live.

## Open questions / assumptions to confirm at plan time

- **Item 4:** exact phase labels ("Setup / Your world / Your crew") are a naming choice — adjustable.
- **Item 5:** "software department with a connected repo" — the trigger uses the department's primary workspace `repoUrl`/`cwd` (as `BraindumpStep`'s `repoChipFor` already derives). Whether the Librarian reads a cloned path vs. the live workspace depends on workspace availability at ingest time; the plan will pin this.
- **Item 5 (company-wide → identity):** verify the `write_memory` tool accepts an agent **identity-layer** proposal as `status: "pending"` (agents may suggest identity + domain; only the founder approves — Decision #6/#15). If `write_memory` restricts agents to domain, the plan adds an identity-proposal path (still founder-gated). Pin at plan time.
- **Item 5 sequencing:** this refinement (company scope + repo-read + extra drops) makes Item 5 the largest item; its implementation plan will split into sub-steps (multi-scope drop UI → capture/scope plumbing → Librarian layer/repo directive → LibrarianStep grouping).
