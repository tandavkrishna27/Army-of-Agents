# Browser qualification and local/cloud integration — implementation preparation plan

**Detailed implementation plans:** [E6.0](../coding-plans/e6-0.md), [E6.1](../coding-plans/e6-1.md), [E6.2](../coding-plans/e6-2.md), [E6.3](../coding-plans/e6-3.md), [E6.4](../coding-plans/e6-4.md). Read with the [shared bindings](../implementation-bindings.md) and [full-packet self-review](../planning-self-review.md). Planning only; implementation remains unapproved.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement accepted tasks after their readiness gates close. This document does not start execution or select the user's implementation methodology.

**Goal:** Deliver the browser qualification and local/cloud integration outcomes without duplicating AoA authority.

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

### E6.0 — Prove browser compatibility before selecting transport details

**Start condition:** BASE, BROWSER, CLOUD, APPROVAL. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `packages/browser-runtime/src/launch-guard.ts`
- `docs/replatform/epics/E8-browser-automation/findings.md`

**Proposed files / test ownership:**
- `docs/architecture/commander-canvas/browser-qualification.md`
- `tests/e2e/universe-browser-qualification.spec.ts`

**Interface boundary:** Produces accepted adapter contract and evidence for attach/view/control/reconnect/capabilities; unresolved capability means dependent integration cannot pass. No new public debugger endpoint.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Approved launch remains contained; unauthorized attach/view/input rejected; human control acknowledged before input; stale epoch denied; source task/session identity retained after reconnect.
- [ ] **3. Implement the bounded change:** Bind approved worker launch, internal Browser Use attachment, stream authentication, ownership epoch and canonical decision path. Qualify cloud headed/window capture and local browser-only capture separately; test native dialog/tab/audio coverage. Record tier exclusions and evidence. Never bypass CDP guard.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

### E6.1 — Integrate automation through governed worker path

**Start condition:** E6.0; BASE and relevant replatform admission. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `packages/browser-runtime/src/launch-guard.ts`
- `docs/replatform/epics/E8-browser-automation/findings.md`

**Proposed files / test ownership:**
- `server/src/services/universe-browser-sessions.ts`
- `server/src/__tests__/universe-browser-authority.test.ts`

**Interface boundary:** Consumes admitted task/session execution capability; produces observable browser session descriptor and action outcomes. Session controller distinct from selected panel.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Two tasks do not share controller; saved profile is not shared live session; pause affects only target session; unsupported execution target fails closed.
- [ ] **3. Implement the bounded change:** Use qualified Browser Use adapter through existing execution owner. Map one browser session per task by default with tabs; declare actual controller/account/location. Use canonical approval authority and stranded-answer recovery, not canvas-created decisions.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

### E6.2 — Implement cloud live view and takeover

**Start condition:** E6.0–1, CLOUD, APPROVAL. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `docs/architecture/commander-canvas/integration-contracts.md`

**Proposed files / test ownership:**
- `ui/src/components/universe/BrowserPanel.tsx`
- `server/src/services/universe-browser-stream.ts`
- `tests/e2e/universe-cloud-browser.spec.ts`

**Interface boundary:** Consumes qualified session/stream capability; sends epoch-bound input. UI rendering is not proof of control authority; negotiated stream limits truthful.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: View/pause/human edit/resume on real cloud worker; old controller rejected; stream loss disables input without falsely stopping job; native dialogs/capture exclusions visible.
- [ ] **3. Implement the bounded change:** Use qualified headed streaming transport and explicit browser-window selection. Authenticate each stream and input session, display task/account/location/controller, grant input only after pause acknowledgement; resume re-observes state.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

### E6.3 — Implement remote access to local browser

**Start condition:** E6.0–1, approved local-worker authentication. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `docs/architecture/commander-canvas/integration-contracts.md`

**Proposed files / test ownership:**
- `ui/src/components/universe/LocalBrowserConnection.tsx`
- `tests/e2e/universe-local-browser.spec.ts`

**Interface boundary:** Consumes worker availability and browser-only stream capability; produces same browser panel protocol as cloud with actual supported capability flags.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Local computer offline shows unavailable; reconnect same session verified; no desktop-wide capture by accident; unauthorized device denied; lost pointer capture/keyboard focus recovered.
- [ ] **3. Implement the bounded change:** Bind qualified worker-owned browser capture/input to outbound authenticated connection. Access from another authorized device; avoid router changes/public debugger ports. Revalidate worker/session/epoch before reconnect input.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

### E6.4 — Implement lifecycle, transfer and gated profile reuse

**Start condition:** E6.2–3; E4 intake; PROFILE for saved logins. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `server/src/services/assets.ts`
- `server/src/services/secrets.ts`
- `docs/replatform/epics/E8-browser-automation/findings.md`

**Proposed files / test ownership:**
- `server/src/services/universe-browser-lifecycle.ts`
- `server/src/__tests__/universe-browser-lifecycle.test.ts`
- `tests/e2e/universe-browser-files.spec.ts`

**Interface boundary:** Consumes canonical task lifecycle/account access and file transfer capabilities. Produces durable outputs and authorized profile references, never cookies in layout/captions.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Close panel leaves task/session alive per policy; expiry frees resources without deleting outputs; login revocation blocks reuse; unresolved submission never blindly retried; teardown/purge/audit evidence closes profile gate.
- [ ] **3. Implement the bounded change:** Implement separate reviewable increments: task-active lifetime/idle teardown; downloads to canonical artifacts and selected upload through worker; saved-profile reuse only after PROFILE gate. Preserve provider capacity/budget policy and reconcile uncertain form submissions.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

## Verification commands and completion boundary

Run from repository root. For each listed new test file, use the matching runner after creating the test as part of the task; the file paths above are proposed and do not exist yet.

```sh
pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/universe-browser-qualification.spec.ts
pnpm exec vitest run server/src/__tests__/universe-browser-authority.test.ts
pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/universe-cloud-browser.spec.ts
pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/universe-local-browser.spec.ts
pnpm exec vitest run server/src/__tests__/universe-browser-lifecycle.test.ts
pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/universe-browser-files.spec.ts
pnpm -r typecheck
pnpm test:run
pnpm build
```

Unit/DB integration tests must use repository fixtures and authentic tenant/actor construction; browser integration tests use the real configured test application. Run only the commands relevant to the task under review; full combined checks precede runtime handoff. Provider and worker qualification requires a separately authorized configured environment. Missing runtime qualification cannot be replaced by source inspection.

This plan defines work and its acceptance. It deliberately does not fabricate complete implementation code or provider signatures for open gates. BASE binding and relevant qualification produce those executable coding details before production implementation. All boxes remain unchecked because this pass changes documentation only.
