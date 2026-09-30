# Routines, catch-up and shared attention — implementation preparation plan

**Detailed implementation plans:** [E7.1](../coding-plans/e7-1.md), [E7.2](../coding-plans/e7-2.md), [E7.3](../coding-plans/e7-3.md). Read with the [shared bindings](../implementation-bindings.md) and [full-packet self-review](../planning-self-review.md). Planning only; implementation remains unapproved.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement accepted tasks after their readiness gates close. This document does not start execution or select the user's implementation methodology.

**Goal:** Deliver the routines, catch-up and shared attention outcomes without duplicating AoA authority.

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

### E7.1 — Connect conversational routines to existing scheduler

**Start condition:** BASE, E2.2; CMD only for distributed work. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `server/src/services/routines.ts`
- `server/src/routes/routines.ts`
- `ui/src/api/routines.ts`
- `packages/db/src/schema/routines.ts`

**Proposed files / test ownership:**
- `server/src/services/internal-agent/tools/universe-routine-actions.ts`
- `server/src/__tests__/universe-routine-actions.test.ts`

**Interface boundary:** Consumes validated routine instruction and canonical request; produces routine/run references through current service revisions.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Duplicate submission one routine/run; edit stale revision conflicts; permission/budget denial leaves clear state; timezone/DST and overlap follow scheduler semantics.
- [ ] **3. Implement the bounded change:** Map explicit conversational create/edit/pause/run to existing governed routine APIs, including owner/timezone/output/authority/overlap. No separate background scheduler; user arrival is not a routine grant.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

### E7.2 — Add durable authorized follow-up intent

**Start condition:** BASE, E7.1; canonical event/intent binding. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `server/src/services/routines.ts`
- `packages/db/src/schema/routines.ts`
- `server/src/services/live-events.ts`

**Proposed files / test ownership:**
- `server/src/services/universe-followup-intent.ts`
- `server/src/__tests__/universe-followup-recovery.integration.test.ts`

**Interface boundary:** Consumes explicit standing authority, trigger identity and canonical terminal status; produces one intended follow-up run. Bind transaction owner in BASE; no fire-and-forget trigger as sole delivery.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Drop all UI events, restart scheduler and recover once; duplicate completions do not rerun; revoked authority stops follow-up; successful prior effects not repeated.
- [ ] **3. Implement the bounded change:** Attach durable trigger intent and idempotent execution to owning routine/task transaction or accepted outbox. Reconcile after downtime; bound retries and coalesce duplicate delivery. UI events invalidate only, never authorize execution.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

### E7.3 — Upgrade shared attention delivery and add Universe presentation

**Start condition:** E7.3/1: BASE + E8.1/1 preferences; it owns the read-only projection consumed by E2.3 and E7.3/2. E7.3/2 additionally consumes E1.3 structured drafts, E2.2 outcomes and E2.4 Task ownership; E7.3/3 binds delivery and E3 only for speech. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `server/src/services/internal-agent/proactive.ts`
- `server/src/services/hub-items.ts`
- `server/src/services/notification-preferences.ts`
- `ui/src/lib/hub-toast-bridge.ts`

**Proposed files / test ownership:**
- `server/src/services/universe-attention-projection.ts`
- `ui/src/components/universe/AttentionRail.tsx`
- `ui/src/components/universe/AttentionQuestion.tsx`
- `server/src/__tests__/universe-attention-migration.test.ts`

**Interface boundary:** Consumes authorized hub items and effective shared delivery policy; produces view state/delivery intent. Direct answers remain available; no third independent policy.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Silent policy retains durable work without unsolicited speech; answer ack resolves same item; opening/closing is not approval; repeated events/devices don't repeat announcement; hidden rail still accessible via Inbox.
- [ ] **3. Implement the bounded change:** Separate durable item creation from delivery policy; migrate silent/digest intent explicitly. Reuse safe projection excluding denial audit namespace. Add optional local sound/voice channels with cross-device dedup; bottom-right movable question, same canonical answer.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

## Verification commands and completion boundary

Run from repository root. For each listed new test file, use the matching runner after creating the test as part of the task; the file paths above are proposed and do not exist yet.

```sh
pnpm exec vitest run server/src/__tests__/universe-routine-actions.test.ts
pnpm exec vitest run server/src/__tests__/universe-followup-recovery.integration.test.ts
pnpm exec vitest run server/src/__tests__/universe-attention-migration.test.ts
pnpm -r typecheck
pnpm test:run
pnpm build
```

Unit/DB integration tests must use repository fixtures and authentic tenant/actor construction; browser integration tests use the real configured test application. Run only the commands relevant to the task under review; full combined checks precede runtime handoff. Provider and worker qualification requires a separately authorized configured environment. Missing runtime qualification cannot be replaced by source inspection.

This plan defines work and its acceptance. It deliberately does not fabricate complete implementation code or provider signatures for open gates. BASE binding and relevant qualification produce those executable coding details before production implementation. All boxes remain unchecked because this pass changes documentation only.
