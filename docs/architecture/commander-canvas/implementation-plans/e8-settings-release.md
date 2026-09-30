# Settings, rollout and release acceptance — implementation preparation plan

**Detailed implementation plans:** [E8.1](../coding-plans/e8-1.md), [E8.2](../coding-plans/e8-2.md). Read with the [shared bindings](../implementation-bindings.md) and [full-packet self-review](../planning-self-review.md). Planning only; implementation remains unapproved.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement accepted tasks after their readiness gates close. This document does not start execution or select the user's implementation methodology.

**Goal:** Deliver the settings, rollout and release acceptance outcomes without duplicating AoA authority.

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

### E8.1 — Implement scoped settings with each consumer

**Start condition:** BASE; corresponding E1/E3/E6/E7 consumer contracts. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `ui/src/pages/SettingsPage.tsx`
- `ui/src/components/settings/SettingsLayout.tsx`
- `ui/src/context/ThemeContext.tsx`
- `server/src/services/secrets.ts`

**Proposed files / test ownership:**
- `ui/src/components/settings/sections/UniverseSection.tsx`
- `packages/shared/src/validators/universe-preferences.ts`
- `server/src/services/universe-preferences.ts`
- `server/src/__tests__/universe-preferences.test.ts`

**Interface boundary:** Consumes user/company overrides, app theme and permitted capabilities; produces effective preference plus inheritance/readiness. No preference read triggers voice capture or a billable probe.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Reset preserves drafts/layout/work; top-only tray default expanded; separate visibility; unsupported provider voice marked unavailable; cross-company updates denied; saved preference migration and failed-save recovery tested.
- [ ] **3. Implement the bounded change:** Implement field matrix in settings-contract with revisioned patch/reset. Personal appearance versus shared Commander style versus provider capability/Secrets versus Budget & caps. Device-local audio selection; full retained theme/blob/grid/rail/caption options; provider checks explicit.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

### E8.2 — Qualify integrated release and rollback

**Start condition:** All release-included slices and relevant BASE/CMD/BROWSER/CLOUD/PROFILE/VOICE/HOST gates. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `package.json`
- `docs/architecture/commander-canvas/grooming-review.md`
- `docs/architecture/commander-canvas/motion-and-interaction.md`

**Proposed files / test ownership:**
- `tests/e2e/universe-release.spec.ts`
- `docs/architecture/commander-canvas/release-evidence.md`

**Interface boundary:** Consumes integrated evidence per included capability; produces release disposition by capability, measured device/network limits and rollback result. A fixture or unassigned upstream gate cannot certify release.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Voice→task→artifact; local/cloud takeover/reconnect; post-send typing; cross-tab conflict; revoked access; renderer failure; duplicate/missed routine events; 100-panel workload/close cycles measured; rollback retains canonical work.
- [ ] **3. Implement the bounded change:** Pin combined revision and run full repository checks, connected product journeys, tenant/access failure injection, long-session resource and responsive/accessibility qualification. Record actual tier limitations and policy closure; rehearse feature rollback preserving records.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

## Verification commands and completion boundary

Run from repository root. For each listed new test file, use the matching runner after creating the test as part of the task; the file paths above are proposed and do not exist yet.

```sh
pnpm exec vitest run server/src/__tests__/universe-preferences.test.ts
pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/universe-release.spec.ts
pnpm -r typecheck
pnpm test:run
pnpm build
```

Unit/DB integration tests must use repository fixtures and authentic tenant/actor construction; browser integration tests use the real configured test application. Run only the commands relevant to the task under review; full combined checks precede runtime handoff. Provider and worker qualification requires a separately authorized configured environment. Missing runtime qualification cannot be replaced by source inspection.

This plan defines work and its acceptance. It deliberately does not fabricate complete implementation code or provider signatures for open gates. BASE binding and relevant qualification produce those executable coding details before production implementation. All boxes remain unchecked because this pass changes documentation only.
