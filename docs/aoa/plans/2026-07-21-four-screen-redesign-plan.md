# Four-Screen Redesign — Implementation Plan (corrected)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development — task-by-task with two-stage review. Steps use `- [ ]`.

**Goal:** Ship four approved surfaces into the real app — the onboarding **Map** (polish the existing journey doors + carry the step counter through the whole flow), **Create-agent** (model promoted to a first-class "Brain" block), **Create-task** (essentials + Advanced, dead placeholders removed), and **Braindump** (one company card + example prompts).

**Architecture:** UI-only in `ui/src/`. No schema, no new server routes. Every screen keeps its current submit contract. The Map work touches the onboarding flow chrome (step counter) — the one non-trivial piece.

**Tech stack:** React 19 + TailwindCSS v4, `@/components/ui/*`, onboarding primitives (`onboarding/steps/shared.tsx`, `DarkShell`, `Reveal` under the `.onboarding-dark` scope), `DialogContext`, TanStack Query. Vitest + Testing Library.

## Confirmed decisions
- **Map = the EXISTING onboarding screen** `ui/src/onboarding/Map.tsx` (three doors: In-flight / Explorer / Greenfield-soon). NOT the Memory graph, NOT a new component. Redesign in place; keep the messaging.
- **Step counter = one continuous count** across the whole onboarding. Before the fork it counts the fixed steps (spine + the Map). Picking **Explorer** ends onboarding (the Map was the last step); picking **In-flight** extends the total to include the in-flight steps. (Confirmed with founder.)
- Braindump is the in-flight onboarding surface; Create-task is the in-app `NewIssueDialog`; Create-agent is the in-app `NewAgentDialog`/`AgentConfigForm` (the surface that owns model config). The onboarding `CreateAgents` surface can reuse the improved Brain block later — out of scope here.

---

## Group A — Onboarding Map + unified step counter

**Files:**
- Modify: `ui/src/onboarding/Map.tsx` (redesign the three doors)
- Modify: `ui/src/onboarding/FlowEngine.tsx` (extract `StepPosition`; feed a shared total)
- Modify: `ui/src/onboarding/FirstRunHome.tsx` + `ui/src/onboarding/inflight/InFlightFlow.tsx` (render the counter through the Map + in-flight)
- Create: `ui/src/onboarding/useOnboardingProgress.ts` (shared count model) + `ui/src/onboarding/StepPosition.tsx`
- Tests: `ui/src/onboarding/__tests__/Map.test.tsx`, `ui/src/onboarding/__tests__/onboardingProgress.test.ts`(new), adjust `FlowEngine`/`InFlightFlow` tests

### Task A1 — Polish the Map doors (visual)
- [ ] **Failing test** (`Map.test.tsx`): three doors render; Greenfield is `disabled` and never calls `onPick`; clicking In-flight → `onPick("in_flight")`, Explorer → `onPick("explorer")`. (Adapt/extend any existing Map test.)
- [ ] **Run → fail** (if adding new assertions) — else write the redesign first, then confirm green.
- [ ] **Implement:** rebuild the three `Door`s with the approved treatment — accent tile per door (In-flight → `--brand`, Explorer → `--data-teal`, Greenfield → `--data-amber`), hover-lift on live doors, a clear "Coming soon" chip + dimmed/dashed state on Greenfield, a hairline/glow accent, real button affordances. Keep the `MapDiagram` above (or lightly refine). **Keep the messaging** ("Bring your work in", "Look around", "Just an idea · soon"). Use `steps/shared.tsx` primitives + `.onboarding-dark` tokens only. `MapProps.onPick` signature unchanged.
- [ ] **Run → pass** + `cd ui && npx tsc --noEmit -p tsconfig.json`. **Commit.**

### Task A2 — Continuous step counter across spine + Map + in-flight
- [ ] **Failing test** (`onboardingProgress.test.ts`): a pure `computeOnboardingPosition(...)` helper returns `{current,total}` such that — during the spine it's `k of BASE` where `BASE = visibleSpineSteps + 1` (the Map); at the Map it's `BASE of BASE`; after `persona="in_flight"` with `S` applicable in-flight surfaces it's `BASE+i of BASE+S`; `persona="explorer"` yields no further steps (Map was terminal). Exclude non-UI terminal registry steps (e.g. `spine-complete`) from the visible count.
- [ ] **Run → fail.**
- [ ] **Implement:**
  - Extract the pips + "Step N of M" markup from `FlowEngine.tsx:224-234` into `StepPosition.tsx` (`{current,total}` props; keep `data-testid="onboarding-step-position"`).
  - Add `useOnboardingProgress.ts` exporting the pure `computeOnboardingPosition` + a hook reading persona (`firstRunPersona`) and the applicable in-flight surface list. `BASE` = count of visible spine steps (registry `applicableSteps` minus non-UI terminal) + 1 for the Map. The in-flight applicable count MUST mirror `InFlightFlow`'s own conditional inclusion (only surfaces that will actually render) so the total is honest.
  - Render `<StepPosition>` in three places with the shared numbers: `FlowEngine` (spine — now via the shared component/total), the Map screen inside `FirstRunHome` (position `BASE`), and each in-flight surface header via `InFlightFlow` (position `BASE + index+1`, total `BASE + applicable`).
  - The counter must not render for the invited journey where it carries no info (preserve the existing `applicableSteps.length > 1` guard intent).
- [ ] **Run → pass** + tsc. Update any FlowEngine/InFlightFlow tests that asserted the old counter scope. **Commit.**

---

## Group B — Create agent: model as the headline

**Files:** `ui/src/components/AgentConfigForm.tsx`, `ui/src/components/NewAgentDialog.tsx`, `ui/src/components/team/NewAoaAgentDialog.tsx`; tests in `ui/src/components/__tests__/`.

### Task B1 — "Brain" block (model + thinking), adapter-agnostic (TDD)
- [ ] **Failing test:** for any adapter whose `adapterModels` returns a non-empty list, the Model picker renders in a Brain block ABOVE the Advanced disclosure (not gated to `isLocal`); selecting a model sets `adapterConfig.model`; thinking-effort renders with the adapter's effort key.
- [ ] **Implement:** extract `BrainSection` (runtime chip · provider-grouped `ModelDropdown` · `ThinkingEffortDropdown`) shown when `listAdapterModels(type)` is non-empty; move Command / working-dir / instructions / model-API-key / extra-args / env / permissions / run-policy into the existing collapsible **Advanced** section (reuse edit-mode `sectionLayout="cards"`), collapsed by default in create mode. Keep `buildAdapterConfig` model-folding + submit payload unchanged.
- [ ] **Run → pass** + tsc. **Commit.**

### Task B2 — Commander quick-create gets a model
- [ ] **Failing test:** `NewAoaAgentDialog` renders a Model picker after adapter selection and includes the model in the create payload.
- [ ] **Implement + pass + commit.**

---

## Group C — Create task: essentials + Advanced

**Files:** `ui/src/components/NewIssueDialog.tsx`; tests `ui/src/components/__tests__/NewIssueDialog.*`.

### Task C1 — Regroup the form (TDD)
- [ ] **Failing test:** on open, visible controls = Title, Assignee, Project, Description, Priority, Status, Planning pill, Create/Discard; the Labels chip and More→Start/Due placeholders are **absent**; Environment / Task-workspace / adapter-overrides are inside a collapsed Advanced disclosure.
- [ ] **Implement:** keep `handleSubmit` payload byte-for-byte. Essentials band + Planning pill (keep D8 amber); move Environment (`1264-1312`), Task-workspace (`1314-1393`), adapter-overrides (`1059-1139`) into one collapsible **Advanced**; **delete** the dead Labels chip (`1395-1399`) and More→dates (`1418-1435`). Leave draft autosave + company switcher.
- [ ] **Run → pass** + tsc; update only assertions referencing removed placeholders. **Commit.**

---

## Group D — Braindump: one card + example prompts

**Files:** `ui/src/onboarding/inflight/BraindumpStep.tsx`; keep `BraindumpDropZone.tsx` (already dashed); tests `ui/src/onboarding/inflight/__tests__/BraindumpStep.test.tsx`.

### Task D1 — Company-first + add-department + prompts (TDD)
- [ ] **Failing test:** on load with 3 departments only the **company** card renders; an "Add a department" control reveals a department card; example-prompt chips insert text into the textarea on click; "Skip for now" is a low-emphasis link, not a `Button`; company-card submit payload unchanged (`scope:"company"`, `departmentId:null`).
- [ ] **Implement:** default the box list to the company card; add "+ Add a department" appending a dept box from loaded projects on demand; per-scope example-prompt chips (company vs department copy) appending to `content`; keep `BraindumpDropZone` (dashed) as the drop UI; demote "Skip for now" to a text link beside Continue; show the live char count. Keep `submitAll`/idempotency/`onDone`-on-acceptance intact.
- [ ] **Run → pass** + tsc. **Commit.**

---

## Cross-cutting verification (final task)
- [ ] `cd ui && npx tsc --noEmit -p tsconfig.json` clean; `npx vitest run src/onboarding src/components/__tests__` green.
- [ ] Live-verify on the memstep instance (`:3120`): walk onboarding — the counter continues through the Map and (for In-flight) the in-flight steps; the Map doors look polished with Greenfield disabled; New-agent shows the Brain/model block up top for every adapter; New-task shows essentials + collapsed Advanced with no dead chips; Braindump opens with one company card + prompts + dashed drop.
- [ ] Commit the verification marker.

## Out of scope
- The Memory graph (`CompanyGraphCanvas` etc.) — untouched; it's a different surface from the onboarding Map. (Its own cleanup is a separate task if wanted.)
- The onboarding `CreateAgents` surface (can reuse the Brain block later).
- "Greenfield / Start from an idea" wiring — stays Coming-soon.
- Any schema/route change — all four keep their contracts.
