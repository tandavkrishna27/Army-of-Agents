# W2 Layer 2 Notifications Registry Implementation Plan

**Goal:** Lock persistent notifications behind the Inbox Hub contract by adding a shared registry, routing legacy notification writes through one canonical hub-backed emit path, and adding guard tests that prevent arbitrary notification types or dead legacy types from drifting back in.

**Architecture:** W1 made `notifications` the physical hub-items table and exposed `hubItemsService.emit/query/action/reconcile` as the canonical Inbox Hub service. W2 Layer 2 keeps that table and service, then adds a registry for persistent notification event names. Legacy notification routes remain compatible, but new writes are validated and hub-shaped. W2 Layer 3 remains deferred: no realtime transport, toast bridge, notification preferences, anti-spam, quiet hours, or digests in this PR.

**Reviewed Plan Changes:** Codex plan review found the first draft under-specified retry behavior, legacy state sync, unknown type rejection, legacy related fields, proactive aliases, and migration/backfill compatibility. This version makes those decisions explicit.

## Scope

### In

- Add a shared persistent notification registry keyed from `NOTIFICATION_TYPES`, plus documented persisted-only aliases.
- Reject unknown or dead notification types on new persistent writes.
- Preserve unknown-to-`legacy_other` mapping only for reading old persisted rows, not for writes.
- Route `createNotification` and `notificationService.create` through `hubItemsService.emit`.
- Extend hub emit args with optional legacy notification fields so legacy routes keep `message`, `relatedEntityType`, `relatedEntityId`, `deliveryAttempts`, and `deliveredAt`.
- Sync legacy `markRead` and `dismiss` route state with hub user-state/lifecycle state.
- Keep retry worker behavior for existing failed rows, but stop creating arbitrary raw retry stubs for invalid notification types.
- Add production write guard tests for direct notification/hub row inserts.
- Update cockpit proactive findings to use `semanticType = "proactive"` with a temporary compatibility predicate for old dot/underscore rows.
- Update the roadmap with W2-L2 active and W2-L3 deferred.

### Out

- No SSE/websocket/realtime transport.
- No toast bridge or LiveEvents changes.
- No notification preferences, anti-spam, quiet hours, or digests.
- No data backfill migration in this PR. Compatibility predicates stay until a separate backfill plan exists.
- No W3 Autopilot, W4 Steward, W5 runtime decision routing, or Mail lane work.

## Current State

- PR #246 merged the W1 final cutover into `main`.
- `packages/db/src/schema/notifications.ts` exports both `notifications` and `hubItems` over the same table.
- `packages/shared/src/constants.ts` exports persistent `NOTIFICATION_TYPES`.
- `packages/shared/src/hub.ts` exports `HubSemanticType`, lane mapping, and authority mapping.
- `server/src/services/hub-items.ts` is canonical for hub emit/query/action/reconcile, but emit currently writes `type = semanticType` and `summary`, not all legacy notification columns.
- `server/src/services/notifications.ts` still accepts `type: string` and raw-inserts into `notifications`.
- `server/src/services/notifications.ts` owns delivery retry fields and a retry worker for failed rows.
- `server/src/routes/notifications.ts` still exposes legacy list, unread count, mark-read, and dismiss endpoints.
- `server/src/services/cockpit.ts` still finds proactive rows by legacy type strings.

## Registry Contract

Create `packages/shared/src/notification-registry.ts`.

Key rules:

- `ACTIVE_NOTIFICATION_TYPES` is derived from `NOTIFICATION_TYPES`, excluding dead types.
- `PERSISTED_NOTIFICATION_ALIASES` documents old row values that may still exist but should not be emitted by new code, including `internal_agent_proactive`.
- `NOTIFICATION_REGISTRY` must satisfy `Record<NotificationType | PersistedNotificationAlias, NotificationRegistryEntry>`.
- `mapPersistedNotificationType(type: string)` returns a hub semantic type for read/backfill compatibility and returns `legacy_other` for unknown old rows.
- `getNotificationRegistryEntryForWrite(type: string)` returns an active entry or lets the server helper throw an HTTP 422-compatible error. Unknowns and dead types do not silently become `legacy_other` on writes.
- `discussion.extraction_complete` is dead for awareness notifications. Successful extraction is represented by discussion pending items, not a new notification row.
- `internal_agent.notification` is not in `NOTIFICATION_TYPES`; if a live caller still needs it, handle it as an explicit alias only after confirming it is persisted. Do not include it as an active persistent type unless tests prove a persistent caller exists.

Expected active mappings:

| Persistent type | Semantic type | Default source type |
|---|---|---|
| `discussion.extraction_failed` | `extraction_failed` | `discussion` |
| `internal_agent.reminder` | `reminder` | `internal_agent_reminder` |
| `internal_agent.proactive` | `proactive` | `internal_agent_check` |
| `internal_agent.action_result` | `legacy_other` | `internal_agent_action` |
| `thread.mention` | `mention` | `discussion` |
| `thread.scope_proposal_posted` | `scope_proposal` | `discussion` |
| `thread.artifact_needs_review` | `discussion_pending` | `discussion` |
| `thread.crew_failed` | `agent_error` | `discussion` |
| `thread.spinoff_suggested` | `suggestion` | `discussion` |
| `thread.human_input_needed` | `human_input_needed` | `discussion` |
| `marketplace.install_completed` | `marketplace_op` | `marketplace_operation` |
| `marketplace.install_failed` | `marketplace_op` | `marketplace_operation` |
| `marketplace.install_requested` | `marketplace_op` | `marketplace_operation` |
| `marketplace.update_available` | `marketplace_op` | `marketplace_update` |
| `marketplace.update_completed` | `marketplace_op` | `marketplace_update` |
| `marketplace.update_failed` | `marketplace_op` | `marketplace_update` |

Expected dead mappings:

| Persistent type | Replacement semantic type | Write behavior |
|---|---|---|
| `discussion.extraction_complete` | `discussion_pending` | reject with 422 |

Expected persisted-only aliases:

| Alias | Semantic type | Write behavior |
|---|---|---|
| `internal_agent_proactive` | `proactive` | reject with 422 |

## Implementation Tasks

### Task 1: Shared Registry Contract

**Files:**
- `packages/shared/src/notification-registry.ts`
- `packages/shared/src/index.ts`
- `packages/shared/src/__tests__/notification-registry.test.ts`

- [ ] Write failing tests that assert registry keys equal `NOTIFICATION_TYPES` plus `PERSISTED_NOTIFICATION_ALIASES`.
- [ ] Assert every active and dead mapping resolves to a shipped `HubSemanticType` and lane.
- [ ] Assert `mapPersistedNotificationType("old.plugin.type") === "legacy_other"`.
- [ ] Assert `getPersistentNotificationRegistryEntry("thread.mention")` is active and maps to `mention`.
- [ ] Assert `discussion.extraction_complete` is dead and maps persisted reads to `discussion_pending`.
- [ ] Assert `internal_agent_proactive` is an alias, maps persisted reads to `proactive`, and is not part of active write types.
- [ ] Export the registry from `packages/shared/src/index.ts`.

Run first and expect failure:

```sh
corepack pnpm@9.15.4 --filter @armyofagents/shared test -- notification-registry.test.ts
```

Run after implementation and expect pass:

```sh
corepack pnpm@9.15.4 --filter @armyofagents/shared test -- notification-registry.test.ts hub-contract.test.ts
```

### Task 2: Hub Emit Compatibility Fields

**Files:**
- `server/src/services/hub-items.ts`
- `server/src/__tests__/hub-items-emit.integration.test.ts`

- [ ] Extend `EmitArgs` with optional `legacyType`, `message`, `relatedEntityType`, `relatedEntityId`, `deliveryAttempts`, `deliveredAt`, and `deliveryError`.
- [ ] Keep canonical hub `type` as `semanticType`.
- [ ] Write legacy compatibility columns during emit:
  - `message` equals redacted `summary`.
  - `relatedEntityType` and `relatedEntityId` come from optional emit args.
  - `deliveryAttempts` defaults to `0`.
  - `deliveredAt` defaults to `now` for successful persistent emits.
  - `deliveryError` defaults to `null`.
- [ ] Add `message`, `relatedEntityType`, `relatedEntityId`, `deliveryAttempts`, `deliveredAt`, and `deliveryError` to conflict-update behavior when the same source key is intentionally deduped.
- [ ] When `reconcile` updates a redacted `summary`, update `message` to the same redacted value so legacy reads do not drift.
- [ ] Add or update hub emit integration tests for message sync, related field persistence, delivery fields, and reconcile summary/message sync.

Run first and expect failure:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/hub-items-emit.integration.test.ts
```

Run after implementation and expect pass:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/hub-items-emit.integration.test.ts
```

### Task 3: Server Notification Emit Adapter

**Files:**
- `server/src/services/notification-registry.ts`
- `server/src/services/notifications.ts`
- `server/src/__tests__/notifications-service.test.ts`
- `server/src/__tests__/notification-retry.test.ts`

- [ ] Create `buildNotificationHubEmit(input: NotificationInput): EmitArgs`.
- [ ] Use the registry write API, not the persisted-row mapper.
- [ ] Reject unknown types with 422.
- [ ] Reject dead types and aliases with 422.
- [ ] Preserve legacy compatibility fields in emit args:
  - `semanticType` from registry.
  - `sourceType` from `relatedEntityType` or registry default.
  - `sourceId` from `relatedEntityId` when present, otherwise a generated event id.
  - `scopeKey` or `sourceUniqueKey` includes company, user, type, and source id.
  - `message`, `relatedEntityType`, and `relatedEntityId` passed through.
- [ ] Avoid accidental dedupe collapse for repeat notifications. If `relatedEntityId` is absent, generate a unique source id for the create call. If `relatedEntityId` is present, dedupe only for types documented as idempotent; otherwise include a generated event suffix.
- [ ] Replace the happy path raw insert in `createNotification` with `hubItemsService(db).emit(buildNotificationHubEmit(params))`.
- [ ] Return a `NotificationRow` with the actual row fields, accepting that `type` is now the hub semantic type for new rows.
- [ ] Keep `retryFailedNotifications` and `countPersistentlyFailingNotifications` for historical failed rows.
- [ ] Remove the arbitrary raw fallback stub on invalid input. If hub emit throws due to a transient DB failure, rethrow after logging; do not write a second unvalidated row.
- [ ] Update `notification-retry.test.ts` so create tests cover the new contract:
  - happy path emits a delivered hub-backed row,
  - unknown type rejects with 422,
  - dead type rejects with 422,
  - retry worker still processes pre-existing failed rows,
  - persistently failing count still works.

Run first and expect failure:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/notifications-service.test.ts server/src/__tests__/notification-retry.test.ts
```

Run after implementation and expect pass:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/notifications-service.test.ts server/src/__tests__/notification-retry.test.ts
```

### Task 4: Legacy Route State Synchronization

**Files:**
- `server/src/services/notifications.ts`
- `server/src/__tests__/notifications-service.test.ts`

- [ ] Update `markRead` so it updates `notifications.readAt` and also records equivalent hub user-state when possible.
- [ ] Update `dismiss` so it updates `notifications.dismissedAt` and also transitions the hub item to the equivalent dismissed/resolved state expected by `hubItemsService.action`.
- [ ] Keep company and user scoping in every update predicate.
- [ ] Add tests that mark/dismiss through `notificationService` and then verify hub query/action state stays coherent.
- [ ] If an old row lacks hub metadata needed for hub action/state, legacy column update still succeeds and the test documents the fallback.

Run:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/notifications-service.test.ts server/src/__tests__/hub-items-actions.integration.test.ts
```

Expected: PASS.

### Task 5: Direct Write Guard

**Files:**
- `server/src/__tests__/notification-registry-guard.test.ts`

- [ ] Add a guard test that walks production `server/src/**/*.ts` files.
- [ ] The guard detects `.insert(...)` calls where the inserted table is `notifications`, `hubItems`, or an alias imported from `@armyofagents/db`.
- [ ] Approved writers are limited to `services/hub-items.ts` and narrowly documented historical retry/update helpers in `services/notifications.ts`.
- [ ] The guard also rejects new production use of string literals for dead persistent notification types except inside the shared registry, tests, docs, and compatibility predicates.

Run:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/notification-registry-guard.test.ts
```

Expected: PASS.

### Task 6: Cockpit Proactive Compatibility

**Files:**
- `server/src/services/cockpit.ts`
- Existing cockpit opt-in tests, or a new focused cockpit proactive test file if that is cleaner.

- [ ] Add a focused test covering all proactive compatibility cases:
  - new row with `semanticType = "proactive"`,
  - old row with `type = "internal_agent.proactive"` and null semantic type,
  - old row with `type = "internal_agent_proactive"` and null semantic type,
  - read rows excluded,
  - dismissed rows excluded,
  - other users excluded.
- [ ] Change the predicate to prefer `eq(notifications.semanticType, "proactive")`.
- [ ] Keep a temporary compatibility `or(...)` with the two old type strings because W2-L2 does not include a data backfill.
- [ ] Document the compatibility fallback in the roadmap as removable after a future backfill.

Run:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/cockpit-approvals.test.ts server/src/__tests__/cockpit-optin.test.ts server/src/__tests__/cockpit-optin-2.test.ts
```

Expected: PASS.

### Task 7: Roadmap Update

**Files:**
- `docs/aoa/plans/2026-06-29-inbox-hub-integration-roadmap.md`
- `docs/aoa/plans/2026-06-30-w2-layer2-notifications-registry-plan.md`

- [ ] Mark W1 final cutover merged in PR #246.
- [ ] Mark W2 Layer 2 active on `codex/inbox-hub-next-roadmap`.
- [ ] List W2-L2 scope as registry-driven persistent notifications, canonical hub emit, legacy route sync, and dead-type cleanup.
- [ ] List W2-L3 as deferred: realtime, toast bridge, preferences, anti-spam, quiet hours, and digests.
- [ ] Note that proactive type compatibility predicates remain until a separate backfill/migration plan.

Run:

```sh
git diff --check
```

Expected: PASS.

### Task 8: Focused And Full Verification

- [ ] Run focused shared tests:

```sh
corepack pnpm@9.15.4 --filter @armyofagents/shared test -- notification-registry.test.ts hub-contract.test.ts
```

- [ ] Run focused server tests:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/hub-items-emit.integration.test.ts server/src/__tests__/notifications-service.test.ts server/src/__tests__/notification-retry.test.ts server/src/__tests__/notification-registry-guard.test.ts
```

- [ ] Run cockpit compatibility tests:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/cockpit-approvals.test.ts server/src/__tests__/cockpit-optin.test.ts server/src/__tests__/cockpit-optin-2.test.ts
```

- [ ] Run typechecks:

```sh
corepack pnpm@9.15.4 --filter @armyofagents/shared typecheck
corepack pnpm@9.15.4 --filter @armyofagents/server typecheck
```

- [ ] Run full repo verification before PR handoff:

```sh
corepack pnpm@9.15.4 -r typecheck
corepack pnpm@9.15.4 test:run
corepack pnpm@9.15.4 build
```

If local build approval or Windows environment constraints block a command, capture the exact error and rely on GitHub CI for that gate only after focused typechecks and tests pass.

## Risk Register

| Risk | Impact | Mitigation |
|---|---:|---|
| Unknown write types silently persist again | High | Separate persisted-row mapping from write validation; write tests assert 422. |
| Legacy notification route state diverges from hub state | High | Task 4 synchronizes read/dismiss state and documents old-row fallback. |
| Retry tests mask arbitrary raw inserts | High | Remove raw fallback on invalid input; keep retry worker only for pre-existing failed rows. |
| Repeat notifications are deduped incorrectly | High | Source id rules distinguish idempotent related rows from unique event rows. |
| Existing proactive rows disappear | Medium | Keep temporary semantic-or-legacy predicate until a backfill plan lands. |
| Registry drifts from constants | Medium | Tests compare registry keys to `NOTIFICATION_TYPES` plus explicit aliases. |
| W2-L2 expands into W2-L3 | High | Verification rejects LiveEvents/toast/preferences/digest changes in this PR. |

## Review Checklist

- [ ] New writes reject unknown, dead, and alias notification types.
- [ ] Old persisted unknown rows still map to `legacy_other` for read compatibility.
- [ ] Registry coverage is tied to `NOTIFICATION_TYPES`.
- [ ] Hub emit writes legacy compatibility fields deliberately.
- [ ] Reconcile keeps `summary` and `message` in sync.
- [ ] Legacy mark-read/dismiss endpoints do not diverge from hub state.
- [ ] Retry worker remains covered for pre-existing failed rows.
- [ ] Direct production inserts are guarded.
- [ ] Cockpit proactive findings use semantic type with temporary old-row compatibility.
- [ ] Roadmap records W2-L2 active and W2-L3 deferred.

