# Unified Composer Experience — Implementation Plan

**Status:** Draft implementation plan for founder review  
**Approved direction:** Quiet Operator  
**Product scope:** [Unified Composer Experience — Product Scope](./2026-07-15-unified-composer-scope.md)  
**Approved visual references:** `C:\Users\TK\.gstack\projects\aoa-2-5\designs\quiet-operator\`  
**Planning note:** The formal interactive `plan-design-review` and `plan-eng-review` skills could not run because `AskUserQuestion` is unavailable in this Default-mode session. This plan carries their required review concerns forward explicitly; it is not treated as final approval until those review gates are run in an interactive planning session.

## 1. Outcome

Deliver one reliable composer system across Commander, Discussion, Workspace, Task slide-over, Commander focus panes, and Task Comments while preserving domain-specific records, permissions, side effects, and audit behavior.

The implementation must make these user-visible promises true:

- Files and images can be selected, pasted, or dropped everywhere the capability profile allows them.
- Attachments always render inside the same bordered composer frame, directly above the editor, including narrow task panes.
- Mentions and Commander skills are structured tokens, not display-only text.
- Send, upload, streaming, retry, draft, offline, and interruption states are recoverable.
- A failed request never erases newer text, tokens, or files.
- Commander runtime sessions are isolated by company, user, and conversation.
- Discussion posting checks match visibility and participant rules.
- Full-page, embedded, slide-over, and mobile presentations preserve semantics and drafts.

## 2. Scope boundaries

### In scope

- Shared composer UI primitives and state machine.
- Shared draft, submission, attachment, mention, and command contracts.
- Attachment persistence and governed runtime access for Commander, Discussion, and task comments.
- Surface adapters for all identified composer hosts.
- Commander session-key correctness fix.
- Canonical Discussion posting authorization.
- Automated and UI flow coverage described in this document.

### Deferred

- OCR fallback for non-vision runtimes.
- New Discussion or Workspace slash commands.
- Voice input, universal Markdown conversion, and redesign of message bubbles/timelines.
- Office-document extraction without a defined preview/runtime contract.

## 3. Architecture and ownership

### 3.1 Shared UI package boundary

Create a UI composer module that owns presentation and interaction contracts, not domain persistence:

- `ComposerFrame`
- `ComposerContextStrip`
- `ComposerEditor`
- `ComposerTokenTray`
- `ComposerAttachmentTray`
- `ComposerAddMenu`
- `ComposerMentionMenu`
- `ComposerCommandMenu`
- `ComposerSubmitControl`
- `ComposerSubmissionError`
- `useComposerDraft`
- `useComposerSubmission`
- `useComposerAttachments`

The module receives a typed surface profile. It must not infer domain semantics from route names or DOM labels.

```ts
type ComposerSurface = "commander" | "discussion" | "task";

type ComposerProfile = {
  surface: ComposerSurface;
  entityId: string;
  density: "comfortable" | "compact" | "mobile";
  capabilities: {
    files: boolean;
    pasteDrop: boolean;
    mentions: Array<"agent" | "human" | "project">;
    commands: "commander-skills" | "none";
    attachmentOnly: boolean;
  };
  submit: "commander-stream" | "discussion-entry" | "task-comment";
};
```

### 3.2 Domain adapters

Each adapter translates a shared submission snapshot to the existing domain API and returns a normalized result:

- `CommanderComposerAdapter`
- `DiscussionComposerAdapter`
- `TaskComposerAdapter`

The adapter owns domain actions such as wake, summon, stop, interrupt, reopen, and approval checks. The shared composer only renders the action supplied by the profile.

### 3.3 Submission snapshot

```ts
type ComposerSubmission = {
  clientSubmissionId: string;
  text: string;
  mentions: ComposerMention[];
  commands: ComposerCommandToken[];
  attachments: ComposerAttachmentRef[];
  replyTargetId?: string;
  action: "send" | "comment" | "wake" | "interrupt-and-send" | "reopen-and-send";
};
```

The snapshot is immutable for the request lifetime. New typing creates a new draft and can never mutate an in-flight submission.

## 4. Delivery phases

### Phase 0 — Baseline and contract fixtures

1. Reconfirm the audited `origin/main` implementation and identify every current composer mount with code references.
2. Record existing API request/response shapes, upload limits, attachment tables, and activity-log behavior.
3. Add fixture factories for company, user, agent, Commander conversation, Discussion visibility/participants, task states, files, and active runs.
4. Add a capability matrix test fixture used by UI and API tests.
5. Decide the exact existing API extension points before changing schema.

**Exit gate:** all six host surfaces have an owner, existing endpoint, persistence record, and test fixture.

### Phase 1 — Shared contracts and server primitives

1. Add shared types and validators for profiles, mentions, commands, attachments, snapshots, and submission results.
2. Define one client submission/idempotency key format and server duplicate behavior for each domain.
3. Define attachment status transitions: `queued → uploading → ready`, `queued/uploading → failed`, `ready → removed`.
4. Add canonical company membership and entity authorization helpers for attachment reads and structured mentions.
5. Add a canonical `assertCanPostToThread` policy for Discussion visibility and participant checks.
6. Update API/shared contracts together; do not let UI-only fields become implicit server behavior.

**Exit gate:** typecheck passes and contract tests reject cross-company files, invalid mentions, unauthorized thread posts, unsupported MIME types, over-limit files, and duplicate submission keys.

### Phase 2 — Attachment pipeline

1. Reconcile existing Discussion generic-asset limits with the common allowlist: PNG, JPEG, WebP, GIF, PDF, TXT, Markdown, JSON.
2. Implement picker, clipboard paste, and drag/drop normalization in the shared UI hook.
3. Upload files before send with tracked status and cancellation/removal.
4. Persist message/comment/entry plus attachment references atomically, or return a recoverable pending state when the storage system requires separate calls.
5. Link Commander files to the conversation/message and expose governed runtime access.
6. Reuse Discussion attachment records and make attachment context available to extraction/summoned agents.
7. Unify Workspace and Task Comments attachment behavior, replacing image-only selection.
8. Add explicit runtime capability metadata: text-readable, vision-readable, or stored-only.
9. Add promotion actions for Commander files only after the base attachment path is reliable.

**Exit gate:** a file is selectable, persisted, visible to authorized readers, downloadable/previewable, and available to the intended runtime according to capability metadata.

### Phase 3 — Shared Quiet Operator composer

1. Implement one `ComposerFrame` with this order: context/status, attachment/token tray, editor, footer, inline error.
2. Keep attachments inside the frame above the editor at comfortable, compact, and mobile densities.
3. Implement auto-growing editor, Enter send, Shift+Enter newline, Cmd/Ctrl+Enter alias, IME protection, Escape menu dismissal, and menu selection precedence.
4. Implement structured token insertion/removal and stale-metadata prevention.
5. Implement synchronous in-flight guard, immutable submission snapshot, idempotency key, and newer-draft preservation.
6. Implement draft storage keyed by company, user, surface, entity, and reply target.
7. Implement upload progress, failure/retry/remove, send failure with Retry/Edit/Discard, offline saved, and reconnecting states.
8. Implement accessible names, listbox semantics, live regions, keyboard removal, focus management, reduced motion, and 44px touch targets.

**Exit gate:** component-level tests cover every state transition and keyboard path without any domain API dependency.

### Phase 4 — Surface migration

Migrate one domain at a time, keeping old behavior behind a temporary feature flag if rollback is needed.

#### Commander

- Mount the shared composer in `CommanderInput`.
- Preserve streaming Send/Stop, tool confirmation, runtime error, and retry-turn behavior.
- Register `/skill` and structured Commander context mentions.
- Add files/images and stored-only disclosure.
- Ensure conversation-specific runtime session key is passed end to end.

#### Discussion

- Mount the same Discussion profile in full `ThreadDetail` and embedded Commander `ThreadDetail`.
- Preserve visibility, participants, reply target, extraction, presence, and notification semantics.
- Add structured human/agent mentions and universal attachment states.
- Ensure parent submission rejection reaches the composer and preserves the draft.

#### Workspace and Task slide-over

- Mount the Task profile in `WorkspaceTimeline`, `TaskDetail` Workspace mode, and Commander task focus.
- Show assigned agent, task state, active run, planning/closed status, and explicit action copy.
- Keep attachment cards inside the pane composer.
- Default active-run send to non-interrupting comment; expose governed Interrupt separately.

#### Task Comments

- Replace the image-only editor capability with the Task profile.
- Remove dormant slash autocomplete unless a real registry is wired.
- Verify parity with Workspace for files, mentions, drafts, errors, and accessibility.

**Exit gate:** each host uses the same frame anatomy and state behavior while domain-specific side effects remain unchanged.

### Phase 5 — Correctness fixes

1. Change Commander provider-session keying everywhere to `companyId:userId:conversationId`.
2. Audit lookup, resume, replacement, idle cleanup, deletion, reset, and streaming reconnect paths.
3. Add Discussion posting policy to every create-entry route and service path, including agent callers where supported.
4. Preserve non-disclosing behavior for hidden threads.
5. Fix swallowed Discussion parent submission errors.
6. Fix Workspace multipart/plain failure handling, newer-draft erasure, and duplicate keyboard submits.

**Exit gate:** regression tests prove isolated Commander conversations, authorized Discussion posting, and recoverable Workspace failures.

### Phase 6 — Rollout and cleanup

1. Enable the shared composer by surface behind flags if needed.
2. Run the complete UI flow suite against seeded companies and test files.
3. Compare activity logs, wakeups, summons, stream stop behavior, attachment access, and error rates.
4. Remove old composer paths and flags only after the rollback window closes.
5. Update API, architecture, and UI documentation with shipped behavior.

## 5. Test strategy

### 5.1 Unit tests

Cover pure logic with table-driven and property-style cases:

- Profile capability filtering and hidden-vs-disabled controls.
- Attachment MIME/size/count validation, filename normalization, and duplicate files.
- Attachment state reducer for success, cancel, retry, failure, reconnect, and removal.
- Structured mention identity, duplicate display names, removal, company mismatch, and stale token cleanup.
- Commander command token insertion and `/` behavior on non-Commander surfaces.
- Draft-key construction and full draft serialization/deserialization.
- Submission snapshot immutability and newer-draft preservation.
- Idempotency key reuse on retry and duplicate response handling.
- Enter/Shift+Enter/Cmd+Enter/IME/menu precedence.
- Responsive density decisions and attachment overflow labels.

### 5.2 Shared component tests

Use React Testing Library or the repository's established UI test harness:

- Empty composer, typed text, token tray, attachment tray, attachment-only, upload progress, upload failure, send failure, offline, reconnecting, streaming, stopping.
- Picker, paste, drag-over, drop, cancellation, removal, retry, and max-limit rejection.
- Every attachment remains inside the ComposerFrame at comfortable, compact, and mobile widths.
- Keyboard focus order and listbox active-descendant behavior.
- Screen-reader labels/live-region announcements for file name, type, size, status, retry, and remove.
- No duplicate submit when Enter, Cmd/Ctrl+Enter, click, or touch happen close together.
- New text typed during an in-flight request remains after the first snapshot succeeds/fails.

### 5.3 API and contract tests

For every affected endpoint/service:

- Valid text-only, file-only, text-plus-files, mentions, commands, reply targets, and each supported domain action.
- Unsupported type, size, count, empty invalid message, malformed token, duplicate token, missing entity, and stale entity.
- Cross-company attachment read/write denial.
- Unauthorized Discussion visibility/participant combinations.
- Agent caller and board caller permission differences.
- Atomic persistence or recoverable pending behavior when attachment/message writes partially fail.
- Idempotent retry returns one durable entry/comment/message.
- Activity log records all mutating actions and no unauthorized action.
- Runtime attachment context contains only authorized files and correct capability metadata.

### 5.4 Integration tests by domain

#### Commander

- Conversation A → B → A maintains separate provider sessions and histories.
- Send text, file, image, mention, and `/skill` in one turn.
- Stream, Stop, retry, runtime error, and reconnect preserve the correct draft.
- Stored-only image is disclosed; text-readable file is passed to the adapter.
- Conversation-local file can be promoted only through the explicit action.

#### Discussion

- Full page and Commander embedded pane share draft and attachment state for the same thread/reply target.
- Public/team/private visibility and participant rules match UI affordances and server rejection.
- Human and agent mentions produce the intended notification/summon behavior only once.
- Image/PDF attachment appears in the thread and is available to extraction where supported.
- Parent submission rejection shows inline error and preserves all composer state.

#### Task/Workspace

- Full Workspace, Task slide-over, Commander task focus, and Task Comments share the same task draft semantics.
- Assigned agent: Send and wake action.
- Unassigned task: Add comment action.
- Closed task: Add comment and permitted Reopen-and-send paths.
- Active run: non-interrupting send and separately governed Interrupt.
- Attachment metadata reaches wakeup context; unauthorized mentions cannot wake another company.

### 5.5 End-to-end UI flow matrix

Run against a seeded company in a real browser at desktop, compact pane, tablet, and mobile widths.

| Flow | Commander | Discussion | Task/Workspace | Must verify |
|---|---:|---:|---:|---|
| Type and send with Enter | Yes | Yes | Yes | One durable result, draft clears only after acceptance |
| Shift+Enter multiline | Yes | Yes | Yes | No premature send |
| Choose mention | Yes | Yes | Yes | Correct identity, routing side effect, accessible menu |
| Type slash | Skill registry | Literal text | Literal text | No dormant/fake commands |
| Pick file | Yes | Yes | Yes | Card appears inside frame |
| Paste image | Yes | Yes | Yes | Thumbnail, size, upload status |
| Drag/drop | Yes | Yes | Yes | Drop zone inside frame, no navigation |
| Upload failure/retry | Yes | Yes | Yes | Draft/files retained, retry works |
| Attachment-only send | Yes | Yes | Yes | Explicit fallback label, no fake prose |
| Send failure/retry | Yes | Yes | Yes | Retry/Edit/Discard and preserved snapshot |
| Offline/reconnect | Yes | Yes | Yes | Draft saved, no silent loss |
| Streaming/Stop | Yes | N/A | Active run | Stop or Interrupt has correct domain effect |
| Narrow pane/mobile | Yes | Yes | Yes | Frame, cards, editor, and Send remain reachable |
| Host transition | Conversation | Thread/reply | Task | Draft persists across full/embedded/slide-over host |

### 5.6 Accessibility and visual QA

- Automated axe checks on every composer host and state.
- Keyboard-only completion of every flow in the matrix.
- Screen-reader pass for menus, tokens, attachment status, errors, and streaming/stop.
- Contrast checks in light, dark, and high-contrast themes.
- Reduced-motion check for upload progress, streaming pulse, and transitions.
- Screenshot baselines for comfortable, compact, tablet, and 375px layouts.
- Verify no detached attachment panel, horizontal composer scroll, clipped Send/Stop, or obscured mobile safe-area footer.

### 5.7 Concurrency, resilience, and security tests

- Double-click, rapid Enter/click, retry-after-timeout, and reconnect races.
- Typing during upload and send; attachment removed while request is in flight.
- Two tabs editing the same draft/entity.
- Provider stream ends after Stop; late events cannot append to another conversation.
- Attachment upload interrupted, resumed, retried, and canceled.
- Malicious filename/content type, oversized payload, path traversal, and unauthorized download.
- Cross-company IDs in every entity, attachment, mention, and session key.
- Rate limits and server error mapping preserve user drafts.

## 6. Acceptance gates

Do not call the work complete until all are true:

1. `pnpm -r typecheck` passes.
2. `pnpm test:run` passes, including new contract and integration suites.
3. `pnpm build` passes.
4. Every row in the end-to-end matrix has an automated test or an explicitly documented manual test with evidence.
5. All three domain adapters pass idempotency and authorization tests.
6. Commander A/B/A session isolation regression passes.
7. All attachment states pass in full page, embedded pane, slide-over, and mobile presentations.
8. No failed upload/send path silently loses text, tokens, or files.
9. Accessibility and responsive checks pass for every composer host.
10. Activity logs, wakeups, summons, stop/interrupt, and attachment access are verified against domain contracts.
11. Approved mockups and this plan are updated if implementation discovers a necessary behavior change.

## 7. Implementation order and ownership

Recommended execution order:

1. Shared types, fixtures, and contract tests.
2. Commander session and Discussion authorization correctness fixes.
3. Attachment server/storage/runtime contract.
4. Shared ComposerFrame, draft, submission, and attachment hooks.
5. Commander migration.
6. Discussion migration in full page and embedded pane.
7. Task/Workspace migration across all four hosts.
8. Accessibility, responsive, and failure hardening.
9. Full UI flow run, documentation, flag removal.

Each phase should land with its tests and remain independently typecheckable. Avoid a large cross-domain UI rewrite before the server contracts and fixture matrix exist.

## 8. Open decisions before coding

These are the remaining implementation-level decisions, not product-direction questions:

- Exact existing upload endpoint/storage abstraction to extend.
- Whether pending attachment uploads use temporary records or client-only resumable state.
- Exact idempotency support available in each existing domain endpoint.
- Existing browser test runner and screenshot baseline command.
- Feature-flag mechanism and rollback window.
- OCR follow-up boundary and runtime capability metadata shape.

The first four should be answered during Phase 0 code reconnaissance. They should not change the approved Quiet Operator layout or the cross-surface behavior contract.

## 9. Plan review findings and required changes

This review was performed after the initial draft. The formal interactive gstack review gates remain unavailable because this session has no `AskUserQuestion` tool. The findings below are therefore recorded as required engineering gates, not silently treated as resolved.

### P0 — Resolve before implementation starts

1. **File-size contract mismatch.** The product scope and plan define a 10 MB per-file limit, but the approved responsive mock contains copy reading “Any file type up to 50 MB.” The contract is 10 MB. Update the mock/reference copy before implementation, and assert the same limit in shared validation, server validation, upload configuration, and E2E fixtures.
2. **Founder-approved keyboard contract must be closed.** Enter-to-send, Shift+Enter newline, and Cmd/Ctrl+Enter alias were approved. Remove the remaining “recommended/confirmation” wording from the scope and treat it as locked.
3. **Idempotency must be endpoint-specific.** “Where supported” is not sufficient for a reliability promise. Phase 0 must document the key, uniqueness scope, storage/retention, replay response, conflict response, and behavior for Commander, Discussion, and task-comment writes. Add a server-side implementation or explicitly narrow the promise before coding.
4. **Attachment write model must be explicit.** Choose transactionally linked records or a stateful pending-upload model. Define orphan cleanup, cancellation, retry, expiry, authorization during pending state, and what happens if storage succeeds but message persistence fails.
5. **Task action state machine must be explicit.** Define the server action and authorization for `Send and wake`, `Add comment`, `Comment only`, `Reopen and send`, `Interrupt`, and `Interrupt and send`. The UI label, API action, activity log, wakeup, and run state must be one tested mapping.

### P1 — Required for the implementation plan to be executable

6. **Cross-layer change map.** Before Phase 1, name the affected Drizzle schema/export, migration, shared type/validator, API route/service, UI client, and test fixture locations for attachments, mentions, idempotency, and Commander session keys. A plan that only names conceptual components risks contract drift.
7. **Attachment security and lifecycle.** Add MIME sniffing rather than trusting extensions, filename/path normalization, authorization on preview/download/runtime reads, size/count enforcement server-side, and a cleanup job or deterministic tombstone/expiry strategy for abandoned uploads. Add malware/content scanning if the existing storage boundary supports it; otherwise record the deferred security risk explicitly.
8. **Runtime access contract.** Define the exact adapter input shape for text-readable, vision-readable, and stored-only files, including byte limits, extraction failures, and whether the user sees a per-file disclosure before send. Add tests proving an unauthorized or unsupported file never reaches a runtime.
9. **Mention delivery semantics.** Define whether Discussion notifications, agent summons, and task wakeups are at-most-once, at-least-once, or deduplicated exactly-once from the user's perspective. Add an outbox/receipt or equivalent test if the current architecture requires it.
10. **Draft attachment references.** `sessionStorage` cannot safely hold file bytes and may hold stale upload IDs. Define draft serialization, pending-upload rehydration, expiry, reload behavior, private-browsing behavior, and what the user sees when a referenced upload is gone.
11. **Executable E2E harness.** For every E2E matrix row, name the browser runner, seed/reset command, test account, fixture files, viewport list, API assertions, UI assertions, screenshot artifact path, and CI command. “Automated or manual” is too weak for a cross-surface reliability change.
12. **Rollback and migration sequencing.** Define feature flags by domain, backward-compatible API/schema deployment order, old/new client interoperability, rollback behavior for pending attachment records, and the flag-removal date/condition.

### P2 — Strengthen before calling complete

13. Add performance checks for upload latency, large-file memory use, streaming while attachments are present, and composer rerender counts.
14. Add observability requirements: upload failures by reason, send failures by surface/action, duplicate-submit prevention, attachment-runtime capability mismatches, wake/summon failures, and draft recovery events.
15. Add visual regression references for both approved boards and explicitly correct the 50 MB copy before baselining.
16. Add two-tab conflict behavior to the acceptance criteria rather than leaving it only in the resilience test list.

### Review verdict

**Not implementation-ready until P0 items 1–5 are resolved.** The architecture and test breadth are directionally sound, but the unresolved contracts above would let two engineers build incompatible behavior while both claiming conformance to the plan.

## 10. Implementation evidence and bounded follow-ups

The isolated implementation branch (`codex/unified-composer`) has now closed the UI and contract work that was in scope for this pass:

- A shared `ComposerFrame` is mounted in Commander, Discussion, Workspace, task detail, and task slide-over hosts with comfortable, compact, and mobile density behavior.
- Text submission is normalized across hosts: Enter sends, Shift+Enter creates a newline, IME composition is protected, attachment-only sends are allowed, and failed sends preserve the draft and files.
- File and image attachment selection, paste, drop, previews, retry/remove, count/size/type validation, and task-comment refresh are covered across the composer surfaces. The shared contract uses a 10 MB per-file limit.
- Commander supports scoped agent mentions, keyboard selection, token deletion, and conversation-scoped draft keys. Discussion and task drafts are keyed by company, user, surface, entity, and reply target.
- Task action labels map explicitly to add-comment, reopen, interrupt, wake, and reassignment behavior; ordinary comments do not interrupt a run.
- Commander session identity and Discussion posting authorization are company/user/conversation or participant scoped rather than relying on presentation-only context.
- Shared contract, draft, attachment, commander input, composer-frame, workspace, discussion, task, and slide-over tests pass on the branch; UI/shared/server typechecks pass.

Two correctness items remain intentionally bounded rather than being represented as complete:

1. **Runtime file content — text delivered (2026-07-15); vision is Phase 2.** Commander now delivers **text-readable** attachment content (txt/md/json) into the turn: the server resolves `attachmentAssetIds`, enforces company ownership (cross-company bytes never read), UTF-8 decodes up to a 32 KB cap, and folds the text into the user turn — images/other stay stored-only with honest disclosure. Key files: `server/src/services/internal-agent/runtime-attachments.ts`, injection in `agentLoopService.chat()`, shared `attachmentRuntimeCapability`. Verified: unit tests (resolver auth/decode/disclosure + agent-loop injection) + a live check where the agent quoted a sentinel string that existed only inside an attached `.txt`. **Vision delivery (images to vision-capable adapters) is the approved Phase 2 follow-up** (§23); discussion/task-agent parity for text delivery also remains to extend beyond Commander.
2. **Server idempotency:** the shared client contract can derive stable submission keys; endpoint-specific server persistence/replay is being implemented per endpoint.
   - **Task comments — DONE (2026-07-15).** `POST /issues/:id/comments` and `/comments-with-attachments` now replay on a repeated `clientSubmissionId` (200 with the original) without re-creating the row or re-firing control effects/wakeups. Backed by `issue_comments.client_submission_id` + a partial unique index (migration `0171_petite_hex.sql`) and an `onConflictDoNothing`+fetch-existing race backstop in `issueService.addComment`. Verified three ways: mocked route tests (RED→GREEN), a live real-Postgres retry (201→200, one row), and a live concurrent-race check (two simultaneous posts → one durable row).
   - **Discussion entries — DONE (2026-07-15).** `POST /companies/:cid/discussions/:discussionId/entries` replays on a repeated `clientSubmissionId` (200 with the original) without re-posting, bumping the seq/count counters, or re-firing extraction/live-event/mention-summon side-effects. Backed by `discussion_entries.client_submission_id` + a partial unique index (migration `0172_volatile_brood.sql`), an early replay check in `discussionService.addEntry`, and an `onConflictDoNothing` race backstop. Verified three ways: service tests (capturing-DB harness), a live real-Postgres retry (201→200, one row), and a live concurrent-race check (two simultaneous posts → one durable row).
   - **Commander messages — DONE (2026-07-15).** `POST /companies/:cid/internal-agent/chat` replays on a repeated `clientSubmissionId`: it streams the original assistant reply and stops WITHOUT persisting a duplicate user message or starting a second CLI run. Backed by `internal_agent_messages.client_submission_id` + a partial unique index (migration `0173_steep_infant_terrible.sql`), a replay gate in `agentLoopService.chat()` (before user-message persist + CLI dispatch), and an `onConflictDoNothing` backstop in `appendMessage`. Verified three ways: unit tests (replay streams original + no CLI run; fresh key runs normally), and a live real-Postgres retry — first send 7795ms (CLI ran) vs retry 9ms (replayed, no CLI), message count unchanged.
   - **All three endpoints landed — exactly-once is now claimable** for task-comment, discussion-entry, and Commander writes.

Browser E2E remains an environment follow-up: the local dev server is blocked by an existing embedded-Postgres migration conflict (`constraint ... already exists`), and the bundled browse executable is unavailable in this workspace. No browser pass is claimed until the database is repaired or reset with explicit approval and the runner is available.
