# Artifacts, formats and generation — implementation preparation plan

**Detailed implementation plans:** [E4.1](../coding-plans/e4-1.md), [E4.2](../coding-plans/e4-2.md), [E4.3](../coding-plans/e4-3.md). Read with the [shared bindings](../implementation-bindings.md) and [full-packet self-review](../planning-self-review.md). Planning only; implementation remains unapproved.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement accepted tasks after their readiness gates close. This document does not start execution or select the user's implementation methodology.

**Goal:** Deliver the artifacts, formats and generation outcomes without duplicating AoA authority.

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

**Accepted human-upload architecture:** E4.1 uses company/actor/destination-scoped intake and canonical asset publication in the same application transaction (A). The original stays recoverable independently of preview/extraction/indexing, and private sources do not become company-wide or enter Memory. E4.2/E4.3 distributed processing and publication retain separate security/qualification decisions. This acceptance does not authorize runtime work.

## Task plans

### E4.1 — Make original intake durable

**Start condition:** BASE; E2.2 only for generated completion. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `server/src/routes/assets.ts`
- `server/src/services/assets.ts`
- `packages/db/src/schema/assets.ts`
- `ui/src/api/assets.ts`

**Proposed files / test ownership:**
- `server/src/services/universe-intake.ts`
- `server/src/__tests__/universe-intake.integration.test.ts`
- `ui/src/components/universe/ArtifactIntakePanel.tsx`

**Interface boundary:** Consumes selected file/reference and explicit draft/canvas destination; produces durable original asset plus independent processing state.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Interrupted upload/commit recovers; repeat completion publishes once; wrong-company reference denied; original downloadable if preview fails; manual upload does not wait for distributed execution.
- [ ] **3. Implement the bounded change:** Reuse upload auth/storage route, distinguish assets from artifact versions, track stage status and reconcile storage/DB publication. Add source destination labeling and recoverable upload UI. Generated job intake binds canonical request/output after E2.2.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

### E4.2 — Qualify format processing independently

**Start condition:** E4.1; format matrix. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `docs/architecture/commander-canvas/format-matrix.md`
- `server/src/routes/assets.ts`
- `server/src/services/asset-serving-safety.ts`

**Proposed files / test ownership:**
- `server/src/services/universe-derivatives.ts`
- `server/src/__tests__/universe-format-matrix.test.ts`
- `ui/src/components/universe/ArtifactPanel.tsx`

**Interface boundary:** Consumes durable asset and processor version; returns derivative/extraction status separately. Never overwrite original or promise universal editing.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Damaged/password/oversize/unsupported fixtures have explicit outcomes; preview-only retry doesn't regenerate original; sanitized rendering and authorized download verified.
- [ ] **3. Implement the bounded change:** For every format family assign native preview/convert/download/reject using current viewers/converters. Preserve processor/source-version lineage. Bound bytes/decompression/time, isolate converters, disable macros, and show stage-specific retry.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

### E4.3 — Preserve revisions and qualify generation

**Start condition:** E4.1–2; generation adapter qualification; E2.2 for jobs. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `server/src/services/artifacts.ts`
- `server/src/routes/artifacts.ts`
- `packages/db/src/schema/artifacts.ts`
- `ui/src/api/artifacts.ts`

**Proposed files / test ownership:**
- `ui/src/components/universe/ArtifactVersions.tsx`
- `server/src/__tests__/universe-artifact-revisions.test.ts`
- `docs/architecture/commander-canvas/generation-qualification.md`

**Interface boundary:** Consumes authorized artifact/version and canonical generation request; produces new immutable version and provenance, not in-place edits.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Repeat uncertain generation outcome checked before new spend; duplicate completion one version; source/winner preserved; external export/publication remains explicit permissioned action.
- [ ] **3. Implement the bounded change:** Reuse immutable versions and winner policy; compare/reuse source references without identity copy. For each generation provider define submission/outcome reconciliation and billing before enabling. Preserve native export separately from preview.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

## Verification commands and completion boundary

Run from repository root. For each listed new test file, use the matching runner after creating the test as part of the task; the file paths above are proposed and do not exist yet.

```sh
pnpm exec vitest run server/src/__tests__/universe-intake.integration.test.ts
pnpm exec vitest run server/src/__tests__/universe-format-matrix.test.ts
pnpm exec vitest run server/src/__tests__/universe-artifact-revisions.test.ts
pnpm -r typecheck
pnpm test:run
pnpm build
```

Unit/DB integration tests must use repository fixtures and authentic tenant/actor construction; browser integration tests use the real configured test application. Run only the commands relevant to the task under review; full combined checks precede runtime handoff. Provider and worker qualification requires a separately authorized configured environment. Missing runtime qualification cannot be replaced by source inspection.

This plan defines work and its acceptance. It deliberately does not fabricate complete implementation code or provider signatures for open gates. BASE binding and relevant qualification produce those executable coding details before production implementation. All boxes remain unchecked because this pass changes documentation only.

## Worker-publication planning follow-up

Consume the [worker-publication design and addendum](../worker-publication-plan.md). E4.2/2 owns the proposed common application receipt/coordinator; E4.3/1 integrates immutable artifact/version writing. Existing job/output records remain non-owner tenant-owned. Application derivative/index/receipt records and E5.2 grant/action-link records are proposed company/actor/destination-scoped, pending independent/security review. The addendum replaces generic A/B/C alternatives for these proposed stores with a concrete recommendation; exact admission, accepted-output, revocation, retention and HOST qualifications remain open. No implementation approval or new increment/release allocation is implied.
