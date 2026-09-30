# Voice capability qualification and sessions — implementation preparation plan

**Detailed implementation plans:** [E3.1](../coding-plans/e3-1.md), [E3.2](../coding-plans/e3-2.md), [E3.3](../coding-plans/e3-3.md), [E3.4](../coding-plans/e3-4.md). Read with the [shared bindings](../implementation-bindings.md) and [full-packet self-review](../planning-self-review.md). Planning only; implementation remains unapproved.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement accepted tasks after their readiness gates close. This document does not start execution or select the user's implementation methodology.

**Goal:** Deliver the voice capability qualification and sessions outcomes without duplicating AoA authority.

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

### E3.1 — Qualify and integrate OpenAI realtime

**Start condition:** BASE, VOICE, E2.1–2, E8.1 provider setup; CMD only for distributed execution. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `ui/src/components/settings/sections/CommanderSection.tsx`
- `server/src/services/secrets.ts`
- `server/src/routes/internal-agent.ts`

**Proposed files / test ownership:**
- `server/src/services/universe-voice.ts`
- `server/src/services/voice/openai.ts`
- `ui/src/components/universe/useVoiceSession.ts`
- `server/src/__tests__/universe-voice.test.ts`

**Interface boundary:** Qualification output fixes adapter operations connect/end/interrupt/mute, transcript events and token/session issuance. No endpoint, model name or SDK version is assumed from the mock; bind before provider code.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Actual audio request→Commander→task/result speech; missing/revoked provider fails clearly; no long-lived secret in browser; opening settings does not start paid session; CLI-only configured vendor shows voice unready.
- [ ] **3. Implement the bounded change:** First produce a provider contract with current official APIs, session credential scope/expiry/retention/usage and allowed speech exception to existing key rules. Then add explicit start/end service and direct audio connection. Route every work request through canonical Commander; no independent speech execution tools.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

### E3.2 — Implement independent voice controls and recovery

**Start condition:** E3.1, E2.2, E1.5. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `ui/src/api/internal-agent.ts`
- `server/src/services/internal-agent/agent-loop.ts`

**Proposed files / test ownership:**
- `ui/src/components/universe/voice-state.ts`
- `server/src/services/voice/transcript-reconciliation.ts`
- `tests/e2e/universe-voice-lifecycle.spec.ts`

**Interface boundary:** Consumes adapter events and canonical outcome; emits display status/captions and explicit connection intents. Work cancel remains separate from speech interruption.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Mute input while playback works; silence output with text preserved; end/start same conversation; late audio suppressed; lost provider session never repeats external action; hidden blob/chat cannot strand active mic controls.
- [ ] **3. Implement the bounded change:** Model disconnected/connecting/listening/thinking/speaking/reconnecting/error plus independent mic/speaker flags. Stop speech promptly on interrupt; end transport on Stop while blob persists. Reconcile transcript/audio generation and outcome lookup before retry; switch conversation invalidates old playback.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

### E3.3 — Qualify Gemini and ElevenLabs independently

**Start condition:** VOICE, E3.1–2; provider-specific capability acceptance. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `server/src/services/secrets.ts`

**Proposed files / test ownership:**
- `server/src/services/voice/gemini.ts`
- `server/src/services/voice/elevenlabs.ts`
- `server/src/__tests__/voice-provider-conformance.test.ts`

**Interface boundary:** Consumes common voice contract qualified in E3.1; each provider produces declared/tested capabilities and canonical transcript/action mapping.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Each provider passes start/stop/interrupt/reconnect and origin attribution independently; unsupported feature disabled; no fallback to unapproved provider or substitution of another user's credential.
- [ ] **3. Implement the bounded change:** Produce separate conformance records for each provider before implementation: transcripts, interruption, tools/results, multilingual support, expiry, retention and usage. Implement same accepted adapter boundary with honest capability flags; do not imitate unsupported combinations.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

### E3.4 — Plan later speech pipelines and local speech

**Start condition:** E3.1–2; later allocation. Gate meanings and owners are in the readiness register. Complete only the qualification/binding work while a runtime gate is open.

**Existing source anchors** (paths relative to repository root; replatform-only paths require the pinned replatform tree):
- `docs/architecture/commander-canvas/voice-provider-research.md`

**Proposed files / test ownership:**
- `docs/architecture/commander-canvas/speech-modes-qualification.md`

**Interface boundary:** Produces mode capability/environment matrix and concrete provider/runtime adapter plan. Local speech is not offline control-plane execution.

- [ ] **1. Bind:** Resolve these anchors and the consumed contracts at the accepted revision. Record new exports/routes/schema columns together before runtime editing; do not substitute the old mock's handlers or invent an upstream authority.
- [ ] **2. Establish acceptance:** Build fixtures for this exact observable outcome: Missing model/hardware yields clear unavailability; recognition correction reconciles transcript; local device loss does not dispatch twice; mixed providers preserve authorized data handling.
- [ ] **3. Implement the bounded change:** Qualify recognition+synthesis and local runtime separately: supported hardware/OS/models, install/update, language, timing, recording and failure. Bind adapters only after qualification; retain canonical Commander authority and privacy scopes.
- [ ] **4. Verify:** Run the proposed task test file(s) with the commands below, then its connected journey. Exercise forbidden cross-company access and the stated failure/recovery cases before claiming the task complete.
- [ ] **5. Review and integrate:** Review source/contract/migration/UI together. Update the spec/evidence with measured outcomes, retain unresolved upstream gates, and merge the reviewed task only through the agreed integration workflow. Re-run consumer tests when upstream bindings change.

**Recovery/rollback:** Keep canonical records and independent drafts intact; disable only this feature's new entry/actions on failure. Expose failure/unknown state rather than replaying a possibly completed write. Keep previous schema readers compatible until migration/rollback review passes.

## Verification commands and completion boundary

Run from repository root. For each listed new test file, use the matching runner after creating the test as part of the task; the file paths above are proposed and do not exist yet.

```sh
pnpm exec vitest run server/src/__tests__/universe-voice.test.ts
pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/universe-voice-lifecycle.spec.ts
pnpm exec vitest run server/src/__tests__/voice-provider-conformance.test.ts
pnpm -r typecheck
pnpm test:run
pnpm build
```

Unit/DB integration tests must use repository fixtures and authentic tenant/actor construction; browser integration tests use the real configured test application. Run only the commands relevant to the task under review; full combined checks precede runtime handoff. Provider and worker qualification requires a separately authorized configured environment. Missing runtime qualification cannot be replaced by source inspection.

This plan defines work and its acceptance. It deliberately does not fabricate complete implementation code or provider signatures for open gates. BASE binding and relevant qualification produce those executable coding details before production implementation. All boxes remain unchecked because this pass changes documentation only.

## D3 correction scheduling

The [credential, shared Budget and session corrections](../voice-media-review-corrections.md) are authoritative for this follow-up. E8.1/1 delivers the restricted-secret resolver and BUDGET-VOICE-MEDIA producer; E3.1/2 integrates transactional session ownership after accepted documentary/security bindings. E3.1/1's live qualification closes on those real producers and consumer; it does not gate their own construction. E8.1/2 UI follows consumers. Runtime tests and implementation still require explicit authorization. Existing increment IDs and release allocation are unchanged.
