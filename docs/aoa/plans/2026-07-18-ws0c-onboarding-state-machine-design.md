# WS0c — Onboarding State-Machine Redesign — Design

**Status:** Design for Codex review (no implementation yet)
**Date:** 2026-07-18
**Branch:** `claude/signup-onboarding-ui-animations-0724cb`
**Parent plan:** [`2026-07-18-onboarding-redesign-implementation-plan.md`](2026-07-18-onboarding-redesign-implementation-plan.md) (WS0c)

## 1. Problem (Codex-flagged)

The redesign moves the persona fork to **Home** and adds new surfaces (Integrations, Braindump, Librarian, First-job). But onboarding is a **strict, server-enforced state machine** — you cannot just "insert a registry entry":
- `FOUNDER_PHASE1_STATES` (`packages/shared/src/onboarding.ts:41-51`) is a fixed ordered sequence; `computeAdvance` (`server/src/services/onboarding.ts:41-61`) is forward-only and **requires every prior state completed**.
- `FlowEngine` (`ui/src/onboarding/FlowEngine.tsx:83-88`) only fires `onFinished` (→ navigate Home) when **no registry step remains** — and the founder registry (`ui/src/onboarding/steps/index.ts:16-115`) runs Profile → Org → Environment → Commander → Verify → **Department → Agent → Review(SETUP_COMPLETE)**.

Consequences today: (a) a founder cannot reach Home until Department + Agent + Review are done as blocking wizard steps; (b) "Explorer" (creates nothing) can never finish; (c) In-flight would see Department *before* the Map. The redesign needs the wizard to **end at the spine** and hand off to Home.

## 2. Current state machine (verified)

- **States:** `ONBOARDING_STATES` union = Phase-1 states + **reserved Phase-2 states** (`WALKTHROUGH_STARTED`, `DISCUSSION_ANALYZED`, `CLARIFICATIONS_RESOLVED`, `SCOPE_CREATED`, `SCOPE_APPROVED`, `MEMORY_SAVED`, `TASKS_CREATED`, `AGENT_EXECUTION_STARTED`, `ONBOARDING_COMPLETE`) — already anticipating a memory/tasks/agent-execution walkthrough that maps onto our In-flight tail.
- **Ordered sequences:** `FOUNDER_PHASE1_STATES` (9 states, AUTHENTICATED→SETUP_COMPLETE), `INVITED_PHASE1_STATES` (AUTHENTICATED→PROFILE_SET→JOIN_REQUESTED→SETUP_COMPLETE). `orderedStatesFor(journey)`.
- **Advance:** `computeAdvance` = idempotent no-op for already-completed/behind, forward-only, prior-states-required, never regress, union completed. `advanceState` wraps it with optimistic concurrency + a two-layer `ensureProgress` (user layer seeds AUTHENTICATED; org layer inherits the user layer's completed states).
- **Registry:** `StepDefinition{ id, order, state, journeys, dependsOn, canSkip, shouldInclude, isComplete, Component, title }`; `resolveNextStep` = first applicable / deps-met / not-complete by `order`; `validateRegistry` rejects dup id/order, dep-not-in-journey, dep-not-strictly-before-state.
- **Engine:** reads progress only; each step does its own write + advance, engine re-reads; `onFinished` fires when `resolveNextStep` returns null. Founder registry = the 8 steps above.
- **WS0b already added:** `firstRunCompletedAt` + `firstRunPersona` on `onboarding_progress`; a home gate (`showOnboarding = !firstRunCompleted`, with the `isLegacySetupComplete` bridge); and an authz'd `setFirstRunProgress` endpoint. Currently `ReviewStep.finish()` writes `firstRunCompleted` — **this moves in WS0c (see §6).**

## 3. The redesign — founder journey shape

**The FlowEngine founder wizard becomes the SPINE only** (ends after Verify); everything after moves onto **Home** (first-run), driven by the persona fork.

```
WIZARD (FlowEngine)                    │  HOME (first-run; WS9 + WS4–8, NOT the wizard)
  Profile → Company → Environment →    │   Map + door band → persona:
  Commander → Verify (COMMANDER_       │     In-flight: Departments → Integrations →
  VERIFIED) ─ onFinished ─────────────▶│       Braindump → Librarian → Agent → First-job
  (advances SETUP_COMPLETE, lands Home)│     Explorer: → steady Home
                                       │   → writes firstRunCompleted on finish/dismiss
```

## 4. Concrete state-machine changes

1. **Truncate the founder wizard registry** (`ui/src/onboarding/steps/index.ts`): remove the `department`, `agent`, and `review` step entries from the founder registry. The founder wizard = `human-profile`, `organization`, `environment`, `commander`, `verify` (+ a terminal transition, §4.3).
   - **Home reuse constraint (Codex P1):** `DepartmentStep` and `AgentStep` **advance onboarding state today** — `DepartmentStep.tsx:121-125` advances `DEPARTMENT_CREATED`, `AgentStep.tsx:117-121` advances `AGENT_ASSIGNED`. Once those states leave `FOUNDER_PHASE1_STATES` (move b), `computeAdvance` **rejects** them (`onboarding.ts:47-48`, "state not in journey"). So WS4/WS7 must NOT reuse these components as-is on Home. **Extract the domain-only create logic** (create project / create+assign agent, the folder/repo/adapter UI) into components that do their **own domain writes with NO onboarding-state advance**; the wizard versions (if still needed anywhere) keep the advance. The Home surfaces record their own durable milestone signal instead (§5).
2. **Shorten `FOUNDER_PHASE1_STATES`** (`packages/shared/src/onboarding.ts`): remove `DEPARTMENT_CREATED` and `AGENT_ASSIGNED` from the ordered sequence, leaving
   `AUTHENTICATED → PROFILE_SET → ORGANIZATION_CREATED → ENVIRONMENT_READY → COMMANDER_SELECTED → COMMANDER_VERIFIED → SETUP_COMPLETE`.
   `DEPARTMENT_CREATED`/`AGENT_ASSIGNED` **stay in the `ONBOARDING_STATES` union** (still valid values; existing rows may carry them) — they're just no longer gating founder wizard states. `SETUP_COMPLETE`'s only prior gate is now `COMMANDER_VERIFIED`.
3. **Advance `SETUP_COMPLETE` via a retryable terminal step, NOT fire-and-forget `onFinished` (Codex P1).** `FlowEngine` sets `finishedRef` + renders "Onboarding complete" **before** calling `onFinished` (`FlowEngine.tsx:83-88,114-121`), so if an advance inside `onFinished` fails there is no error/retry surface (unlike the current `ReviewStep`, which awaits the advance and shows errors, `ReviewStep.tsx:49-71`). Instead add a **minimal terminal wizard step** (`order` after `verify`, `state: "SETUP_COMPLETE"`, `dependsOn: ["COMMANDER_VERIFIED"]`) that renders a brief "Bringing you to your control room…" transition, **awaits** the `SETUP_COMPLETE` advance with the same pending/error/retry handling `ReviewStep` uses, and on success calls `onComplete()` → engine finds no next step → `onFinished` (now a pure navigate to Home). This preserves the retryable surface, advances **only the selected-company layer** (two-layer handshake stays sound), and keeps `onFinished` side-effect-free. (It replaces `ReviewStep` — no review content, since departments/agents are no longer created in the spine.)

## 5. In-flight tail + persona fork = Home-hosted, NOT the wizard (and NOT new onboarding states)

- The Map, the door band, and the In-flight surfaces (Departments/Integrations/Braindump/Librarian/Agent/First-job) render on **Home first-run** (WS9 + WS4–8). They do their own **domain writes** (create project, create agent, file memory, create task/discussion) and are NOT `FlowEngine` steps.
- **Persona** is `onboarding_progress.firstRunPersona` (WS0b), written at the door band via the WS0b endpoint.
- **Resume is data-driven, not state-driven** — but each milestone needs a **durable, onboarding-correlated signal (Codex P2).** Home today only exposes ambient booleans (vision/department/agent/goal — `home.ts:266-296`); those can't tell an *onboarding* braindump / Librarian run / first-job from unrelated pre-existing data, so resume can't be inferred from them alone. So each In-flight milestone (WS4–8) must record an explicit, idempotent marker keyed to the first-run (e.g. the braindump record carries `(companyId, departmentId)` + an onboarding origin; the onboarding-created agent/task is tagged so resume is deterministic). Resume derives from `firstRunPersona` + these markers — NOT from new `OnboardingState` gates. **This deliberately avoids expanding the state machine** (the reserved Phase-2 states stay reserved; we do not wire `MEMORY_SAVED`/`TASKS_CREATED`/etc. as gates in v1) — coupling the optional Home tail to the monotonic wizard would re-introduce the rigidity we're removing. Each WS4–8 plan must specify its milestone marker + idempotency.
- **Completion:** `firstRunCompleted` is written by WS9 when the founder finishes the In-flight tail, picks Explorer, or clicks "Enter the control room." (Moves the WS0b `ReviewStep` write here — see §6.)

## 6. `SETUP_COMPLETE` vs `firstRunCompleted` — two distinct, both meaningful

- **`SETUP_COMPLETE`** (OnboardingState) = "the required **spine** is done; the founder has a live engine and has landed on Home." Set at spine end (§4.3). Existing consumers (WS0b backfill, telemetry) keep working; existing completed rows are unaffected.
- **`firstRunCompleted`** (WS0b timestamp) = "the founder finished/dismissed the **first-run** persona experience on Home." Set by WS9, not the spine.
- **Move the WS0b write:** `ReviewStep.finish()` currently writes `firstRunCompleted`. Since Review leaves the wizard, that write is **removed**; WS9 owns it. Interim safety (WS0c lands before WS9): the WS0b `isLegacySetupComplete` bridge still applies — a founder who finishes the *legacy* Getting-Started checklist on Home (dept+agent+goal) reads `firstRunCompleted:true`, so no dead-end during the WS0c→WS9 window.

## 7. Invited + returning

- **Invited** wizard is unchanged: only `human-profile` (`journeys:["invited"]`); `INVITED_PHASE1_STATES` unchanged. After profile + join, WS10 renders the read-only **mini-Map on Home**; no engine step (dropped from v1 per the parent plan). `firstRunCompleted` for invited is written when they land on Home (WS10).
- **Returning** is unchanged (Lobby/steady Home + pending invites).

## 8. Migration / back-compat (the real risk)

- **Existing completed founders** (`SETUP_COMPLETE`): unaffected. WS0b backfill already stamps `firstRunCompletedAt` for them → steady Home.
- **In-flight *old-flow* founders** (mid-wizard at `DEPARTMENT_CREATED`/`AGENT_ASSIGNED`): after §4.2 these states leave `FOUNDER_PHASE1_STATES`, so `order.indexOf(currentState)` returns `-1` for such a row. `computeAdvance` tolerates this **for the `SETUP_COMPLETE` request specifically** (Codex P2: curIdx = -1 skips the no-op guard, `priorSatisfied` holds because their completed set includes AUTHENTICATED…COMMANDER_VERIFIED, and `Math.max(-1, reqIdx)` picks `SETUP_COMPLETE`). Codex confirmed the ONLY runtime consumers of `orderedStatesFor(...).indexOf(currentState)` are `advanceState` + `validateRegistry`, so nothing else breaks — the normalization is for semantic/routing cleanliness, not correctness.
- **Normalization must NOT collide with the WS0b first-run backfill (Codex P1).** The WS0b backfill stamps `firstRunCompletedAt` on **every** `SETUP_COMPLETE` row (`backfill-first-run-completed.ts:23-38`) and both run unordered at startup (`server/src/index.ts:834-841`). So normalizing old-flow rows **to `SETUP_COMPLETE` would auto-stamp `firstRunCompleted` and skip the new Home/Map experience.** Instead: normalize matching rows to **`currentState = "COMMANDER_VERIFIED"`** (their spine is done; let the UI's terminal step do the `SETUP_COMPLETE` advance and WS9 own first-run), **version-guarded / `version`-incremented** like WS0b's writes. This keeps old-flow founders in the new Home-first-run experience rather than silently marking them done.
- **`validateRegistry`** still passes (remaining spine steps' deps are intra-sequence); the removed steps' deps vanish with them.
- **Mixed client/server versions during rollout (Codex P2):** a cached old client that PATCHes `DEPARTMENT_CREATED`/`AGENT_ASSIGNED` after deploy gets an illegal-state response. AoA ships server+UI together, so the window is small; note it, and the old-flow user simply reloads into the truncated flow.

## 9. Sequencing

WS0c is a prerequisite for WS3 (spine polish uses the truncated wizard) and WS9 (Map-on-Home consumes the `onFinished`→Home hand-off + owns the `firstRunCompleted` write). WS0c should land **before** WS3/WS9 wire their surfaces; the WS0b bridge (§6) keeps the interim (WS0c-without-WS9) non-dead-end.

## 10. Test plan

- **Unit (shared/server):** `FOUNDER_PHASE1_STATES` no longer contains DEPARTMENT_CREATED/AGENT_ASSIGNED; `computeAdvance(order, COMMANDER_VERIFIED, [...through COMMANDER_VERIFIED], SETUP_COMPLETE)` = advance (legal); an in-flight row at `DEPARTMENT_CREATED` (curIdx -1) advancing to SETUP_COMPLETE is legal (not illegal/regress); the normalization backfill is idempotent + only touches matching rows.
- **Registry/engine (ui):** founder registry = 5 spine steps; after `verify` completes, `resolveNextStep` returns null → `onFinished`; `validateRegistry` clean.
- **OnboardingFlow:** `onFinished` advances `SETUP_COMPLETE` then navigates to Home; the `ReviewStep` `firstRunCompleted` write is gone (no double-write with WS9).
- **Regression:** the founder happy path reaches Home after Verify; invited path unchanged; existing `onboarding-advance`/registry tests updated for the new sequence.

## 11. Codex review — resolved

Design reviewed by Codex; the core (truncate `FOUNDER_PHASE1_STATES`, keep values in the union, retryable terminal step, data-driven resume, no new states) is validated. Resolutions folded in above:

1. **Truncation is the right lever** (a separate `SPINE_COMPLETE` adds no needed gate). `SETUP_COMPLETE` still drives Lobby interrupted-company routing (`Lobby.tsx:55-59`) and stays; old values kept in the union for stored-row compat. Home has its own first-run flag (`home.ts:34-47`).
2. **Terminal step, not `onFinished`** — §4.3 revised (retryable; no hidden Review side-effect; two-layer handshake sound if the callback advances only the selected-company layer).
3. **Data-driven resume is sound; no Phase-2 states needed** — but each milestone needs a durable, onboarding-correlated marker (§5 revised; each WS4–8 plan specifies it).
4. **Normalization** — cosmetic for `computeAdvance` (only `advanceState` + `validateRegistry` consume `orderedStatesFor(...).indexOf`), but **must normalize to `COMMANDER_VERIFIED`, not `SETUP_COMPLETE`**, to avoid the WS0b backfill collision (§8 revised).
5. **No production deep-link/analytics** consumer of the three step ids. Tests to update: `DepartmentStep.test.tsx:151-152`, `AgentStep.test.tsx:106-109`, `ReviewStep.test.tsx:99-102`, `OnboardingFlow.test.tsx:85-99`, + add the `curIdx = -1 → SETUP_COMPLETE` case to `onboarding-advance.test.ts`. **Invited unaffected** as long as the invited-first branch stays before the founder advance (`OnboardingFlow.tsx:104-108`); `INVITED_PHASE1_STATES` unchanged.

**Status: design validated — ready to expand to a bite-sized WS0c implementation plan.**
