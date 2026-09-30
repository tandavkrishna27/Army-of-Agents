# Commander context, outcomes and task chat — implementation preparation plan

**Detailed implementation plans:** [E2.1](../coding-plans/e2-1.md), [E2.2](../coding-plans/e2-2.md), [E2.3](../coding-plans/e2-3.md), [E2.4](../coding-plans/e2-4.md). Read with the [shared bindings](../implementation-bindings.md) and [full-packet self-review](../planning-self-review.md). Planning only; implementation remains unapproved.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement accepted tasks after their readiness gates close. This document does not start execution or select the user's implementation methodology.

**Goal:** Deliver the commander context, outcomes and task chat outcomes without duplicating AoA authority.

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

### E2.1 — Bind selected references to the existing conversation

**Start condition:** BASE; E1.1 for UI context. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `server/src/services/internal-agent/agent-loop.ts`
- `packages/shared/src/validators/internal-agent.ts`
- `ui/src/api/internal-agent.ts`

**Proposed files / test ownership:**
- `packages/shared/src/types/universe-context.ts`
- `server/src/services/internal-agent/universe-context.ts`
- `server/src/__tests__/universe-context.test.ts`

**Interface boundary:** Consumes conversationId, stable authorized reference/version and view snapshot. Produces bounded context for existing ChatParams; preserve 5,000-character page context unless a reviewed additive contract replaces it.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Select artwork A then move/select B during send: A remains target; revoked/private refs omitted or denied; corrections survive summarization; no full hidden datasets projected.
- [ ] **3. Implement the bounded change:** Define bounded viewport/reference projection using existing CommanderInputRef/context scope. Resolve versions and permissions server-side; capture snapshot at Send/utterance submission. Extend summary/retrieval to preserve corrections and fetch original versioned sources, not untrusted instructions.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

### E2.2 — Add read-only outcome lookup and bind execution

**Start condition:** BASE, E2.1; CMD for distributed behavior. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `server/src/routes/internal-agent.ts`
- `server/src/services/internal-agent/agent-loop.ts`
- `packages/db/src/schema/internal_agent.ts`
- `ui/src/api/internal-agent.ts`

**Proposed files / test ownership:**
- `server/src/services/internal-agent/request-outcome.ts`
- `server/src/__tests__/universe-request-outcome.integration.test.ts`

**Interface boundary:** Consumes canonical submission identity; returns observed accepted/running/succeeded/failed/unknown with linked reply/output refs. GET/lookup never calls chat(), creates run rows, claims leases or executes CLI.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Lost ack repeated lookup produces zero new runs/claims; same key changed args conflicts; unknown is not safe retry; live owner never duplicated; distributed target and origin conversation verified after CMD closes.
- [ ] **3. Implement the bounded change:** Add authenticated read-only lookup by conversation and clientSubmissionId over canonical user turn/reply/run mapping. Validate request payload fingerprint and conflict on reused identity with changed content. Preserve current admitted chat path; connect distributed results only after CMD ownership/credential contract is accepted.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

### E2.3 — Build truthful catch-up and snapshot reconciliation

**Start condition:** BASE, E2.2; CMD for distributed results. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `server/src/services/live-events.ts`
- `server/src/services/internal-agent/proactive.ts`
- `ui/src/api/hub-items.ts`

**Proposed files / test ownership:**
- `server/src/services/universe-catchup.ts`
- `ui/src/components/universe/useUniverseReconciliation.ts`
- `server/src/__tests__/universe-catchup.test.ts`

**Interface boundary:** Consumes authorized canonical states and last-seen checkpoint; produces current catch-up without action dispatch. Transport cursor differs from request revision.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Drop/out-of-order/duplicate events converge; expired cursor snapshot fallback; no replay of jobs; old-conversation results stay at origin; forbidden audit categories absent from catch-up.
- [ ] **3. Implement the bounded change:** Treat events as invalidation hints; fetch authorized snapshots and discard old revisions. Preserve checkpoint per user/conversation. Use the accepted replatform disclosure-safe activity projection, including denial-namespace exclusion; do not query raw audit rows into model summaries.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

### E2.4 — Reuse task content in a reliable conversation panel

**Start condition:** BASE, DESIGN, E1.1, E1.3–4; E2.2 only for new delegated execution. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `ui/src/components/commander/CommanderTaskFocusPane.tsx`
- `ui/src/components/TaskDetail.tsx`
- `ui/src/api/issues.ts`

**Proposed files / test ownership:**
- `ui/src/components/universe/TaskConversationPanel.tsx`
- `tests/e2e/universe-task-routes.spec.ts`

**Interface boundary:** Consumes issueId, optional anchorId and onClose contract already used by CommanderTaskFocusPane; produces canonical task comments/actions. Window operations remain E1, voice destination remains Commander.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: For each entry route repeat open/drag/eight edges/pin/max/restore/min/restore/close; one instance, no animation-only state; message sent to selected task, not Commander; partial/failed send retains draft.
- [ ] **3. Implement the bounded change:** Extract/adapt TaskDetail conversation content and existing task mutation client, not its independent outer window shell. Fixed task reply composer, scrolling messages, title/status and supporting agents/artifacts on demand. Route all launch paths through registry ID.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

## Verification commands and completion boundary

Run from repository root. For each listed new test file, use the matching runner after creating the test as part of the task; the file paths above are proposed and do not exist yet.

```sh
pnpm exec vitest run server/src/__tests__/universe-context.test.ts
pnpm exec vitest run server/src/__tests__/universe-request-outcome.integration.test.ts
pnpm exec vitest run server/src/__tests__/universe-catchup.test.ts
pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/universe-task-routes.spec.ts
pnpm -r typecheck
pnpm test:run
pnpm build
```

Unit/DB integration tests must use repository fixtures and authentic tenant/actor construction; browser integration tests use the real configured test application. Run only the commands relevant to the task under review; full combined checks precede runtime handoff. Provider and worker qualification requires a separately authorized configured environment. Missing runtime qualification cannot be replaced by source inspection.

This plan defines work and its acceptance. It deliberately does not fabricate complete implementation code or provider signatures for open gates. BASE binding and relevant qualification produce those executable coding details before production implementation. All boxes remain unchecked because this pass changes documentation only.
