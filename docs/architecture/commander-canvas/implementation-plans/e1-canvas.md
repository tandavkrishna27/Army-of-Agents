# Canvas, persistence and presentation — implementation preparation plan

**Detailed implementation plans:** [E1.0](../coding-plans/e1-0.md), [E1.1](../coding-plans/e1-1.md), [E1.2](../coding-plans/e1-2.md), [E1.3](../coding-plans/e1-3.md), [E1.4](../coding-plans/e1-4.md), [E1.5](../coding-plans/e1-5.md), [E1.6](../coding-plans/e1-6.md). Read with the [shared bindings](../implementation-bindings.md) and [full-packet self-review](../planning-self-review.md). Planning only; implementation remains unapproved.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement accepted tasks after their readiness gates close. This document does not start execution or select the user's implementation methodology.

**Goal:** Deliver the canvas, persistence and presentation outcomes without duplicating AoA authority.

**Architecture:** Follow the canonical Universe contracts and the accepted replatform base. Reuse domain services and place new presentation state above renderer lifetime. Gate-dependent tasks first produce qualification/binding evidence; they are not executable adapter recipes until those contracts exist.

**Tech Stack:** Existing React/TypeScript UI, Express services, shared validators and PostgreSQL/Drizzle; React Flow remains the chosen canvas direction, with package version to qualify at execution.

**Spec:** [Master scope](../master-scope.md), [UI decisions](../ui-review-decisions.md), [readiness review](../readiness-review.md), [motion acceptance](../motion-and-interaction.md).

## Global constraints

- Scope every reference/read/write to authenticated company and actor; preserve single assignee, approvals, atomic checkout, budget stops and activity auditing.
- UI says Task, APIs/DB retain issues. Artifact versions immutable. No runtime/provider keys in layout, drafts, captions or generated tool data.
- Apply accepted replatform tenant repository/credential boundaries before server coding. Proposed file paths below are ownership proposals, not existing exports or delivered endpoints.
- Existing Commander send contract: message ≤10,000 characters, pageContext ≤5,000, clientSubmissionId ≤200, attachmentAssetIds ≤5. Larger recoverable drafts do not expand sending limits.
- Generate Drizzle migrations and synchronize db/shared/server/ui exports. Dependency manifest and generated lockfile change together. No schema/lockfile hand edits.
- No release assignment, provider spend, implementation branch or runtime code change is authorized by this planning record alone. Current user request ends at planning and discussion.

## Task plans

### E1.0 — Complete the design-state inventory

**Start condition:** DESIGN. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `docs/architecture/commander-canvas/ui-review-decisions.md`
- `docs/architecture/commander-canvas/motion-and-interaction.md`

**Proposed files / test ownership:**
- `docs/architecture/commander-canvas/ui-state-review.md`

**Interface boundary:** Produces per-screen state disposition and reproduction steps with host/viewport/route. The accepted UI contract remains U01–U10; no production functionality follows merely from a mock.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Review opens one task through every entry, manipulates it and returns to same draft; all missing states assigned to their owning epic, not marked implicitly approved.
- [ ] **3. Implement the bounded change:** Enumerate normal, empty, loading, failed, offline, revoked and conflict states per screen; reproduce the intermittent task-panel route in the actual host; reconcile omitted mock settings/previews; review narrow, keyboard, touch and reduced-motion flows.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

### E1.1 — Build one canvas and panel controller

**Start condition:** BASE, DESIGN. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `ui/src/components/hub/HubShell.tsx`
- `ui/src/components/commander/CommanderTaskFocusPane.tsx`
- `ui/package.json`

**Proposed files / test ownership:**
- `ui/src/components/universe/UniverseWorkspace.tsx`
- `ui/src/components/universe/PanelFrame.tsx`
- `ui/src/components/universe/panel-state.ts`
- `ui/src/components/universe/__tests__/panel-state.test.ts`
- `tests/e2e/universe-panels.spec.ts`

**Interface boundary:** Consumes authorized content references and viewport. Produces panel operations open/focus/move/resize/pin/minimize/restore/maximize/close with stable IDs, saved geometry and selected ID; local state never grants domain authority.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Same task via Work/Inbox/attention/source/overview is one live instance; every control changes actual state after animation; user drag still works when pinned; minimized keeps draft, closed removes view only.
- [ ] **3. Implement the bounded change:** Pin/qualify React Flow and regenerate manifest+lockfile together. Build a reducer/registry owned above renderers and one PanelFrame. Adapt first-party content without nested window chrome. Bind header-only drag, all edges, pin, min/max/close and z-order; exclude editor/browser input.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

### E1.2 — Persist layout with revisions and recovery

**Start condition:** BASE, E1.1. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `ui/src/hooks/useHomeBoardLayout.ts`
- `server/src/routes/goals.ts`
- `server/src/services/goals.ts`
- `packages/db/src/schema/internal_agent.ts`

**Proposed files / test ownership:**
- `packages/db/src/schema/universe.ts`
- `packages/shared/src/validators/universe.ts`
- `server/src/services/universe-state.ts`
- `server/src/routes/universe.ts`
- `ui/src/api/universe.ts`
- `ui/src/components/universe/useUniverseState.ts`
- `server/src/__tests__/universe-state.integration.test.ts`

**Interface boundary:** Consumes {operationId,expectedRevision,operations}; actor/company derived server-side. Produces acknowledged revision or conflict with recoverable latest state. Exact route/export names are fixed in BASE binding before coding; no whole-document stale overwrite.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Two tabs different-panel edits survive; same-property conflict retains both choices; duplicate operation same payload returns original ack, changed payload conflicts; invalid coordinates/unknown schema/other-company reads fail.
- [ ] **3. Implement the bounded change:** Define company/user/conversation ownership, schema revision and operation ledger against BASE tenant repositories. Generate Drizzle migration and exports. Apply bounded operation batches atomically with expected revision and payload fingerprint; return acknowledgement. Add final-drag flush, journal/reconcile and non-destructive conflict UI.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

### E1.3 — Persist destination-specific drafts safely

**Start condition:** BASE; independent of E1.2 geometry; request outcome for submitted recovery. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `ui/src/components/commander/CommanderInput.tsx`
- `ui/src/api/internal-agent.ts`
- `packages/shared/src/validators/internal-agent.ts`

**Proposed files / test ownership:**
- `server/src/services/universe-drafts.ts`
- `ui/src/components/universe/useUniverseDraft.ts`
- `server/src/__tests__/universe-drafts.integration.test.ts`
- `ui/src/components/universe/__tests__/draft-recovery.test.ts`

**Interface boundary:** Consumes draft destination and snapshots; produces recoverable text/ref variants and an acknowledgement-bound clear. Reuse clientSubmissionId; never send a recovered draft without user action.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Submit A then type B before ack: B remains; two task composers isolated; lost ack invokes read-only lookup, not POST; logout/company switch clears applicable local journal; conflict preserves variants.
- [ ] **3. Implement the bounded change:** Add separate draft records keyed by actor/conversation/destination with revision. Preserve snapshot submission ID and content identity. Clear only acknowledged snapshot; retain subsequent typing. Enforce current send limits (10,000 message chars/five attachments); larger draft recovery does not silently truncate at send.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

### E1.4 — Implement tray, overview and reference navigation

**Start condition:** BASE, DESIGN, E1.1; E1.2–3 for persistent acceptance. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `ui/src/api/internal-agent.ts`
- `ui/src/api/issues.ts`
- `ui/src/api/artifacts.ts`
- `ui/src/api/hub-items.ts`

**Proposed files / test ownership:**
- `ui/src/components/universe/UniverseTray.tsx`
- `ui/src/components/universe/OpenPanelsOverview.tsx`
- `ui/src/components/universe/PanelPreviewRail.tsx`
- `tests/e2e/universe-navigation.spec.ts`

**Interface boundary:** Consumes registry, canonical authorized search and visibility preferences. Produces focus/open/restore commands; counts derive from registry, not task execution. Main Commander toggle uses hidden/covered/frontmost state.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Collapse logo position invariant; switch menus never overlaps; zero badge absent; all minimized items recover with rails hidden; denied/deleted refs cannot show stale private preview; keyboard and touch work.
- [ ] **3. Implement the bounded change:** Center one brand anchor with symmetric wings. Centralize open menu state. Resolve entries through registry and authorized APIs. Implement unified Commander toggle/menu, one Open panels count, stable paged previews, rail settings and focus return; no cloned live controls.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

### E1.5 — Implement independent Commander surfaces

**Start condition:** BASE, DESIGN, E1.1, E1.3; E8.1 prefs; no live-provider dependency for presentation. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `ui/src/components/commander/CommanderInput.tsx`
- `ui/src/components/InternalAgentPanel.tsx`
- `ui/src/api/internal-agent.ts`

**Proposed files / test ownership:**
- `ui/src/components/universe/CommanderSurface.tsx`
- `ui/src/components/universe/CommanderBlob.tsx`
- `ui/src/components/universe/CommanderCaptions.tsx`
- `tests/e2e/universe-commander-surfaces.spec.ts`

**Interface boundary:** Consumes conversation messages, draft, presentation preferences and voice state from E3. Produces presentation changes and explicit start/end/mute/silence intents; no transport side effect on show/hide.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Maximize→Compact returns bottom; hide chat preserves caption/blob/voice; hide blob does not lose captions; hover Expand remains clickable; Add/voice/Send align; no rectangular orb hover or duplicate window icons.
- [ ] **3. Implement the bounded change:** Reuse rich input/history behavior. Model compact/expanded/maximized and visible/tucked independently of blob/captions/connection. Implement movable resizable expanded chat, saved restore geometry, rightmost Compact, fixed input and internal scroll; caption placement without duplicates; hover row and voice shortcut.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

### E1.6 — Implement viewport-aware motion and accessibility

**Start condition:** BASE, DESIGN, E1.1, E1.4–5; E2.1 context binding. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `docs/architecture/commander-canvas/motion-and-interaction.md`

**Proposed files / test ownership:**
- `ui/src/components/universe/viewport-controller.ts`
- `ui/src/components/universe/motion-tokens.ts`
- `ui/src/components/universe/__tests__/viewport-controller.test.ts`
- `tests/e2e/universe-motion.spec.ts`

**Interface boundary:** Consumes viewport size/camera, geometry, pins, active manipulation and requested target. Produces readable target camera and bounded layout ops; preserve previous viewport for restore. Motion state is not execution state.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Rapid min/max/close converges; pointer loss releases; all eight resize edges at zoom work; background results never move camera; requested offscreen highlight reveals target; text-scaled/narrow/reduced-motion controls stay reachable.
- [ ] **3. Implement the bounded change:** Implement cancellable movement and geometry transitions using common tokens. Keep screen-space chrome outside canvas. Expose usable viewport/visible refs to context. Add keyboard move/resize and reduced motion. Auto-reveal requested references then glow; defer camera while active input.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

## Verification commands and completion boundary

Run from repository root. For each listed new test file, use the matching runner after creating the test as part of the task; the file paths above are proposed and do not exist yet.

```sh
pnpm exec vitest run ui/src/components/universe/__tests__/panel-state.test.ts
pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/universe-panels.spec.ts
pnpm exec vitest run server/src/__tests__/universe-state.integration.test.ts
pnpm exec vitest run server/src/__tests__/universe-drafts.integration.test.ts
pnpm exec vitest run ui/src/components/universe/__tests__/draft-recovery.test.ts
pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/universe-navigation.spec.ts
pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/universe-commander-surfaces.spec.ts
pnpm exec vitest run ui/src/components/universe/__tests__/viewport-controller.test.ts
pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/universe-motion.spec.ts
pnpm -r typecheck
pnpm test:run
pnpm build
```

Unit/DB integration tests must use repository fixtures and authentic tenant/actor construction; browser integration tests use the real configured test application. Run only the commands relevant to the task under review; full combined checks precede runtime handoff. Provider and worker qualification requires a separately authorized configured environment. Missing runtime qualification cannot be replaced by source inspection.

This plan defines work and its acceptance. It deliberately does not fabricate complete implementation code or provider signatures for open gates. BASE binding and relevant qualification produce those executable coding details before production implementation. All boxes remain unchecked because this pass changes documentation only.
