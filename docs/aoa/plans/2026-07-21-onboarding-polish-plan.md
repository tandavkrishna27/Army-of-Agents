# Onboarding Polish — Three Fixes Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development — task-by-task, TDD, two-stage review (spec then quality). Steps use `- [ ]`.

**Goal:** Three approved fixes to the onboarding flow — (1) the "first job" step becomes task-only with a polished card (discussion removed), (2) the braindump "Add a department" floating dropdown becomes inline "+" chips (the current menu renders but is clipped/invisible), and (3) Back navigation extends into the in-flight tail (Back everywhere except back into the Map fork).

**Architecture:** UI-only, `ui/src/onboarding/`. No schema, no server routes, no submit-contract changes. Fixes 1 & 2 are single-component; fix 3 touches the in-flight sequencer chrome (mirrors the spine's existing Back).

**Design source:** approved with the founder — mockup artifact `onboarding-decisions.html` (inline "+" chips; Back everywhere except into the Map) + "task-only, polished simple card" for first-job.

**Tech stack:** React 19 + Tailwind v4, onboarding primitives (`steps/shared.tsx`, `DarkShell`, `Reveal`, `.onboarding-dark`), Vitest + Testing Library.

---

## Task 1 — First-job step: task-only, polished

**Files:** `ui/src/onboarding/inflight/FirstJobStep.tsx`; test `ui/src/onboarding/inflight/__tests__/FirstJobStep.test.tsx` (create/extend).

Today `FirstJobStep` renders a 2-column grid: a "Create a task" card AND a "Start a discussion" card (`discussionsApi.create`), plus "Skip to Home". Remove the discussion path entirely; keep a single, centered, polished task card.

- [ ] **Failing test:** render `FirstJobStep`; assert the "Start a discussion" card is **absent** (`queryByText(/start a discussion/i)` is null, no discussion input); the task card is present (title input + assignee select + "Create task"); "Skip to Home" still present; creating a task calls `issuesApi.create` with `{title, status:"todo", assigneeAgentId?}` and fires `onDone` once. (Mock `agentsApi.list`, `issuesApi.create`; assert `discussionsApi.create` is NOT called.)
- [ ] **Run → fail.**
- [ ] **Implement:** delete the discussion card JSX + `discussionTitle`/`discussionStatus`/`discussionError` state + `handleStartDiscussion` + the `discussionsApi` import. Change the grid to a single centered card (e.g. `mx-auto max-w-md`, drop `sm:grid-cols-2`). Keep the task card behavior (title + assignee + create, `fireOnDoneOnce`) and "Skip to Home". Polish to match the redesign: use `StepCard`/`FIELD`/`LABEL` tokens already imported; tighten spacing; keep the `GradientText` heading but update the subtitle to task-only copy ("Give your agent its first task — or skip straight to Home."). No new deps.
- [ ] **Run → pass** + `cd ui && npx tsc --noEmit -p tsconfig.json`. Update any existing FirstJobStep test that asserted the discussion card. **Commit** `feat(onboarding): first-job is task-only (remove discussion) + polished card`.

---

## Task 2 — Braindump "Add a department": inline "+" chips

**Files:** `ui/src/onboarding/inflight/BraindumpStep.tsx`; extend `__tests__/BraindumpStep.test.tsx`.

Today (`BraindumpStep.tsx` ~387-412) "Add a department" toggles `addMenuOpen` and renders an `absolute z-10` `role="menu"` that gets clipped by the centered layout → invisible. Replace with inline clickable "+" chips (one per remaining department), matching the example-prompt chip pattern already in the file.

- [ ] **Failing test:** on load with ≥2 mocked departments, assert the remaining departments render as inline chips labeled like "+ <Dept>" (NOT inside a `role="menu"`); clicking "+ Software" appends that department's card (its textarea appears) and the "+ Software" chip disappears from the remaining list; there is NO `role="menu"` element. (Adapt to the existing test harness / mock setup.)
- [ ] **Run → fail.**
- [ ] **Implement:** remove `addMenuOpen` state + the `role="menu"` block + the `Plus`-button-that-toggles. Render `remainingDepartments.map(d => <button className="chip">+ {d.name}</button>)` inline under the cards (reuse the example-prompt chip classes), each calling `addDepartmentBox(d)`. Keep a small `LABEL` ("Add department knowledge") above the chip row. When `remainingDepartments` is empty, render nothing (as today). Keep `addDepartmentBox`, `remainingDepartments`, and all submit behavior unchanged.
- [ ] **Run → pass** + tsc. **Commit** `fix(onboarding): braindump add-department as inline chips (dropdown was clipped/hidden)`.

---

## Task 3 — Back navigation in the in-flight tail

**Files:** `ui/src/onboarding/inflight/InFlightFlow.tsx`; test `__tests__/InFlightFlow.test.tsx` (create/extend). Reference: `ui/src/onboarding/FlowEngine.tsx` chrome (Back on the left + `StepPosition` on the right).

Today the in-flight chrome (added in the counter work) shows only `StepPosition` on the right; there's no Back. Add a Back control that steps to the PREVIOUS in-flight surface, shown only when `index > 0` (the first surface, Departments, has no Back — that would go back into the Map fork, which is one-way). The Map (`FirstRunHome` door) and the spine are unchanged (spine already has Back).

- [ ] **Failing test:** render `InFlightFlow` at surface index 0 (Departments) → no Back button; at index ≥ 1 (e.g. Braindump) → a Back button is present, and clicking it renders the previous surface (Integrations). Assert Back never appears on Departments. (Drive index via the `aoa:inflight-step:<companyId>` localStorage key the sequencer already reads, or by advancing.)
- [ ] **Run → fail.**
- [ ] **Implement:** add `function goBack()` that does `setIndex(i => Math.max(0, i-1))` and writes the new index via the existing `writeStoredStep`. In the chrome wrapper, change `justify-end` to `justify-between` and render, on the left, `{index > 0 ? <BackButton onClick={goBack}/> : <span className="min-w-[64px]"/>}` mirroring FlowEngine's Back (ghost button, `ChevronLeft`, "Back"); keep `StepPosition` on the right. Do NOT add Back at index 0. Do NOT touch `advance()`, the surfaces, `onDone`, or `setFirstRunCompleted`. Going back and forward re-runs an idempotent surface (braindump uses its idempotencyKey) — no new writes to guard.
- [ ] **Run → pass** + tsc. Update any InFlightFlow test affected by the chrome change. **Commit** `feat(onboarding): Back navigation through the in-flight tail (not into the Map fork)`.

---

## Task 4 — First-job task card: richer + smart defaults (added after live test)

**Files:** `ui/src/onboarding/inflight/FirstJobStep.tsx`; test `__tests__/FirstJobStep.test.tsx`.

Live E2E test showed the flow works (dept→agent→task all created + wired), but the first-job task card is too sparse (title + assignee only) and defaults the assignee to "Unassigned" even though the founder just created a department worker. Founder wants: add Description + Priority; default the assignee to the just-created agent; default/associate the department they chose. (Department creation is already guaranteed — no change needed there.)

- [ ] **Failing test:** with `agentsApi.list` → one agent (e.g. Ada) and `projectsApi.list` → one department (Software), render `FirstJobStep`; assert (a) a Description field + a Priority control render; (b) the assignee defaults to Ada (not "Unassigned"); (c) creating a task calls `issuesApi.create` with `{title, description?, status:"todo", priority, assigneeAgentId: <Ada>, projectId: <Software>}` (verify the payload keys the issues API actually accepts by reading `ui/src/api/issues.ts` + the standalone `NewIssueDialog` submit).
- [ ] **Run → fail.**
- [ ] **Implement:** load departments (`projectsApi.list`, filter `type==="department"`) alongside the existing `agentsApi.list`. Add to the task card: a Description textarea (optional) and a Priority selector (Low/Medium/High, default Medium — match the values `NewIssueDialog`/the issues API use). Default `taskAssigneeId` to the first org agent once loaded; default a new `projectId` to the first department. Optionally show the department as a small select/chip defaulting to the chosen dept. Thread `description`, `priority`, `projectId` into the `issuesApi.create` payload (only when set). Keep `fireOnDoneOnce`, "Skip to Home", the single-centered-card layout, and the task-only structure. If there are 0 agents (agent step skipped), keep "Unassigned" as the default; if 0 departments (can't happen per DefineDepartments, but be defensive) omit `projectId`.
- [ ] **Run → pass** + tsc. **Commit** `feat(onboarding): first-job task card — description, priority, default assignee + department`.

## Task 5 — Map: rebuild to the approved mock (big journey cards, drop diagram)

**Files:** `ui/src/onboarding/Map.tsx`; test `__tests__/Map.test.tsx`.

The live Map is a light polish of the OLD design (flow diagram + 3 small doors). Founder wants the approved mock: three LARGE journey cards, friendlier labels, descriptions, buttons, "Most teams start here" flag, NO flow diagram.

- [ ] **Failing test:** three cards render with the mock labels — "Bring a project in motion", "Explore on your own", "Start from an idea"; the idea card is disabled + shows "Coming soon" and never calls `onPick`; "Bring a project in motion" → `onPick("in_flight")`, "Explore on your own" → `onPick("explorer")`; the `MapDiagram` is NOT rendered (mock has no diagram). Mock `../mapDiagram` if needed to assert absence.
- [ ] **Run → fail.**
- [ ] **Implement:** rewrite `Map` to render a heading ("Where are you starting from?" + sub "Three ways in — you can switch paths later.") and three large cards (translate the approved mock, artifact `aoa-screen-redesigns` v3 Map tab / `onboarding-decisions` — accent tile, title, hairline rule, a full description paragraph, a real button, per-accent glow + top hairline). Card copy:
  - **Bring a project in motion** (accent brand, `onPick("in_flight")`, button "Continue setup →", "Most teams start here" flag): "Already building. Point your crew at the repo, the docs, the context you have — and they pick up exactly where you left off."
  - **Explore on your own** (accent teal, `onPick("explorer")`, button "Open the workspace →"): "Skip the rails. Wander the workspace, wire up agents, memory, and tasks yourself — at whatever pace suits you."
  - **Start from an idea** (accent amber, DISABLED, "Coming soon" chip): "Just a spark, no company yet? We'll help you shape it into a plan, a first team, and the opening moves — from a single sentence."
  Optional reassurance footer. Remove the `MapDiagram` import + render + the "THE MAP" header row. Keep `MapProps.onPick` and the `MapDoorPersona` union. Use `.onboarding-dark` tokens only (`--brand`/`--teal`/`--amber`, `color-mix` for glows/tints — verify they resolve, as in the prior Door). Do NOT delete `MapDiagram.tsx` (still used by `MiniMap` for the invited journey).
- [ ] **Run → pass** + tsc. Update the existing Map test to the new labels/structure. **Commit** `feat(onboarding): rebuild Map to the approved journey-card mock (drop diagram)`.

## Task 6 — Braindump: show the departments the founder created

**Files:** `ui/src/onboarding/inflight/BraindumpStep.tsx`; test `__tests__/BraindumpStep.test.tsx`.

Currently only the company card renders on load; created departments hide behind "+" chips. Founder created them explicitly, so they should show as cards.

- [ ] **Failing test:** on load with 2 mocked departments (Software, Marketing), assert BOTH a Software card AND a Marketing card render up front (their textareas present), alongside the company card — with no "+ Software" chip needed.
- [ ] **Run → fail.**
- [ ] **Implement:** in the load effect, build a DumpBox for the company AND one per department (`projects.filter(type==="department")`) — `setBoxes([companyBox, ...deptBoxes])`. Reuse the existing `addDepartmentBox` shape for the dept boxes (scope "department", departmentId, folderPath, hint, repoChip). Since all created departments now render, the "+ Add a department" chips become empty (remainingDepartments = []) and naturally disappear — leave that code (harmless) or remove it. Keep example-prompt chips, dashed drop, char count, submit/onDone-on-acceptance/idempotency unchanged.
- [ ] **Run → pass** + tsc. **Commit** `feat(onboarding): braindump shows a card per department the founder created`.

## Task 7 — Onboarding scroll: tall steps must scroll (top reachable)

**Files:** `ui/src/onboarding/FlowEngine.tsx` (`DarkShell` + spine content wrapper), `ui/src/onboarding/FirstRunHome.tsx`, `ui/src/onboarding/inflight/InFlightFlow.tsx`. Test: a layout/RTL check if practical, else manual live-verify.

`DarkShell` is `overflow-hidden` and the content wrapper is `min-h-screen … flex-1 justify-center` — with tall content (many braindump/department cards) the `justify-center` pushes the TOP of the content above the viewport and it's unreachable / clipped.

- [ ] **Implement:** make tall onboarding steps scrollable with the top reachable. Keep the `ConstellationBg` clipped (horizontal) but allow vertical scroll of content. Recommended: on the content wrappers (FlowEngine's `min-h-screen … justify-center` div, and the InFlightFlow/FirstRunHome equivalents), stop hard-centering tall content — e.g. use `min-h-screen` with the inner content block `my-auto` (centers when it fits, but flows and lets the page scroll when it doesn't), and change `DarkShell`'s `overflow-hidden` to `overflow-x-hidden` (keep x clip for the constellation, allow y). Verify: a step taller than the viewport can scroll to reveal BOTH its top and bottom (test by walking the braindump with several department cards). Keep short steps visually centered as today.
- [ ] **Verify:** `cd ui && npx vitest run src/onboarding` green; `npx tsc --noEmit`. Live-verify the braindump with 3+ departments scrolls fully (top + bottom reachable). **Commit** `fix(onboarding): tall steps scroll (top reachable) instead of clipping`.

## Final verification
- [ ] `cd ui && npx tsc --noEmit -p tsconfig.json` clean; `cd ui && npx vitest run src/onboarding` green.
- [ ] Live on memstep (:3120): walk onboarding (or resume) — first-job shows only a task card (no discussion); braindump shows inline "+ <Dept>" chips that add a card on click; Back appears on braindump/first-job (steps back a surface) but NOT on departments, and the Map has no Back. Counter still continuous.
- [ ] Commit the verification marker.

## Out of scope
- The Create-task dialog (`NewIssueDialog`) — already redesigned + verified; unchanged here.
- The Map fork itself / the spine Back (already correct).
- Any change to what the in-flight surfaces write.
