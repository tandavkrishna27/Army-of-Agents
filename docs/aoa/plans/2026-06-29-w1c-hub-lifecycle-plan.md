# W1c Hub Lifecycle Implementation Plan

> **For agentic workers:** This is the execution plan for W1c on the active `feat/inbox-hub` branch / PR #244. W1a is the merged data core; W1b is the hub shell. Keep this work in the same PR so W1b+W1c+later W1d can be tested as one user-facing Inbox Hub before landing.

**Goal:** Complete the first real triage lifecycle inside the Inbox/Approvals Hub: read/unread, snooze and return, resolve versus dismiss versus archive, undo for reversible hub-only actions, bulk actions with partial-failure reporting, history, owner/authority display, and board-pool claim/release.

**Architecture:** Keep W1a's hub index as the control-plane source of truth. Shared lifecycle decisions (`resolve`, `archive`, `claim`, `release`) mutate `hub_items` with optimistic concurrency and immutable audit. Personal state (`read`, `unread`, `snooze`, `unsnooze`, `dismiss`, `undismiss`) stays in `hub_item_user_state`. Undo replays from `hub_audit.priorState` only for reversible hub-only mutations before `undoDeadline`; source side effects remain non-undoable until their dedicated W2/W5 bridges exist.

**Tech Stack:** Drizzle ORM schema + generated migrations, Express 5 routes/services, shared Zod validators/types, React/Vite hub UI, Vitest unit/integration tests, Playwright e2e.

**Implementation status (PR #244):** Implemented through Task 9 in the active `feat/inbox-hub` branch. Focused shared/db/server/UI tests are in place, and the W1c Playwright user-flow spec has been authored. Local Windows verification cannot run focused e2e specs with the default embedded-Postgres config because `tests/e2e/playwright.config.ts` switches to the Windows skip spec when `DATABASE_URL` is unset; Linux CI remains the required Playwright gate before the PR is marked ready.

---

## Scope

### In

- Read and unread state for hub items.
- Per-user snooze and automatic return when `snoozedUntil <= now`.
- Per-user dismiss and undismiss; dismissed items are hidden for that user only.
- Shared resolve and archive lifecycle transitions.
- Undo timer for reversible hub-only lifecycle actions.
- Bulk lifecycle actions with deterministic per-item results.
- History list for resolved and archived items.
- Owner, pool, claim state, and authority affordances in list/viewer.
- Board-pool claim/release for open items.
- Stale-version and permission error recovery in UI.

### Out

- Full route/reassign/escalate workflow, OOO delegation, and multi-human live concurrency. W1c shows route/escalate affordances when an actor lacks authority, but those workflows belong to later W1d/W2+ work unless this plan is revised.
- External source side-effect undo, approval accept/reject relays, and W5 runtime adapter bridges.
- Maintained counters; W1c keeps live counts. W1d owns maintained counter performance work.

---

## Product Decisions

1. **Snooze is personal state, not shared status.** `hub_items.status = 'snoozed'` remains reserved/backward-compatible, but W1c UI snooze writes `hub_item_user_state.snoozedUntil`. The default list and counts hide future-snoozed rows and naturally show them again after the timestamp passes.

2. **Dismiss is not resolve and not archive.** Dismiss writes only `hub_item_user_state.dismissedAt`. The shared item remains open for other visible users and for the source reconciler.

3. **Resolve and archive are shared.** They update `hub_items.status`, bump `version`, and write `hub_audit` in the same transaction.

4. **Actions are named, not client-chosen statuses.** Replace the W1a-era client contract of `{ action, nextStatus }` with action-specific validation. The server maps `resolve -> resolved`, `archive -> archived`, `claim -> open + claimedBy`, `release -> open + unclaimed`. This prevents contradictory payloads such as `action: "resolve", nextStatus: "archived"`.

5. **Undo is short and explicit.** Use an 8-second undo window. Shared lifecycle undo is audit-backed: only hub-only shared mutations with `undoDeadline` and no irreversible side effects are undoable through `/undo`. Personal-state undo is client-context-backed: the UI captures the previous `readAt` / `snoozedUntil` / `dismissedAt` values before the state mutation and reverses with the existing state route during the undo window.

6. **Bulk is partial success by design.** Each item is processed independently with its own optimistic-concurrency guard and audit. The endpoint never pretends heterogeneous source-backed actions are all-or-nothing.

7. **Claim is a work lock, not ownership transfer.** `ownerUserId` remains the accountable/responsible human resolved by W1a. Claim adds `claimedByUserId`/`claimedAt` for board-pool items so someone can take the work without rewriting provenance.

8. **Activity log mirrors user-visible shared mutations.** `hub_audit` is the immutable hub decision log; `activity_log` remains the operator-facing company activity feed. W1c shared lifecycle and assignment actions write both. Personal state actions do not need activity-log rows unless they change the shared item.

---

## Data Model

### Add claim fields to `notifications` / `hubItems`

File: `packages/db/src/schema/notifications.ts`

Add:

```ts
claimedByUserId: text("claimed_by_user_id"),
claimedAt: timestamp("claimed_at", { withTimezone: true }),
```

Add partial index:

```ts
hubClaimedOpenIdx: index("hub_items_claimed_open_idx")
  .on(table.companyId, table.claimedByUserId)
  .where(sql`${table.status} = 'open'`),
```

Then run:

```sh
pnpm db:generate
```

Expected migration shape: `ALTER TABLE "notifications" ADD COLUMN "claimed_by_user_id" text;`, `ADD COLUMN "claimed_at" timestamp with time zone;`, and the partial index.

No new audit columns are needed; W1a already added `priorState`, `undoDeadline`, `irreversibleSideEffects`, and `relayResult`.

---

## API Contract

### Query

Update `packages/shared/src/validators/hub.ts`:

- Add `includeSnoozed?: boolean` for debugging/history support, default false.
- Keep `includeDismissed`.
- Keep `status` for `open`, `resolved`, `archived`, and legacy `snoozed`.

Default list behavior:

- `status` omitted -> `open`.
- `includeDismissed=false` -> hide rows where current user's `dismissedAt` is not null.
- `includeSnoozed=false` -> hide rows where current user's `snoozedUntil > now`.
- Returned rows with `snoozedUntil <= now` are considered active again; the row can remain sparse until the next personal-state write.

### Personal State

Replace `hubUserStateSchema` with a fuller discriminated union:

```ts
{ kind: "read" }
{ kind: "unread" }
{ kind: "snooze", until: string }
{ kind: "unsnooze" }
{ kind: "dismiss" }
{ kind: "undismiss" }
```

Route:

```http
PATCH /api/companies/:companyId/hub-items/:id/state
```

Response:

```ts
{
  id: string;
  companyId: string;
  hubItemId: string;
  readAt: string | null;
  snoozedUntil: string | null;
  dismissedAt: string | null;
  updatedAt: string;
}
```

### Lifecycle Action

Replace `nextStatus` with named actions:

```ts
{
  action: "resolve" | "archive" | "claim" | "release";
  expectedVersion: number;
  idempotencyKey?: string;
  reason?: string;
}
```

Route:

```http
POST /api/companies/:companyId/hub-items/:id/action
```

Response:

```ts
{
  item: HubItemListRow;
  auditId: string;
  undoDeadline: string | null;
}
```

Rules:

- `resolve` and `archive`: use authority gate from `HUB_AUTHORITY_BY_TYPE`; status must be open; bump version.
- `claim`: item must be open, `ownerPool === "board"`, and `claimedByUserId === null`; founder/board-authorized actors only for W1c.
- `release`: item must be open and claimed; allowed for claimant or founder.
- Every shared mutation is company-scoped and writes `hub_audit` and `activity_log` before returning.

### Undo

New route:

```http
POST /api/companies/:companyId/hub-items/:id/undo
```

Payload:

```ts
{
  auditId: string;
  expectedVersion: number;
}
```

Response:

```ts
{
  item: HubItemListRow;
  auditId: string;
}
```

Rules:

- The audit row must match company + item.
- `undoDeadline >= now`.
- `irreversibleSideEffects` and `relayResult` must both be null.
- The current item version must match `expectedVersion`.
- The audit `priorState` restores only hub-owned fields used by W1c (`status`, `version`, `resolvedAt`, `archivedAt`, `claimedByUserId`, `claimedAt`).
- Undo itself writes a new audit row with `action = "undo"` and `priorState` equal to the pre-undo state.
- This route is for shared hub lifecycle/claim mutations only. Personal-state undo does not write `hub_audit`; the client stores the previous visible state in mutation context and calls the inverse `PATCH .../state` within the same 8-second UI window.

Supported W1c undo matrix:

| Action | Mutation type | Undoable? | Recovery |
|---|---|---:|---|
| `read` | personal state | Yes, client-state undo | Restore previous `readAt` from UI mutation context by calling the state route. |
| `unread` | personal state | Yes, client-state undo | Restore previous `readAt` from UI mutation context by calling the state route. |
| `snooze` | personal state | Yes, client-state undo | Restore previous `snoozedUntil` from UI mutation context by calling the state route. |
| `unsnooze` | personal state | Yes, client-state undo | Restore previous `snoozedUntil` from UI mutation context by calling the state route. |
| `dismiss` | personal state | Yes, client-state undo | Restore previous `dismissedAt` from UI mutation context by calling the state route. |
| `undismiss` | personal state | Yes, client-state undo | Restore previous `dismissedAt` from UI mutation context by calling the state route. |
| `resolve` | shared hub status | Yes, server audit undo | Restore prior status/timestamps/version via audit before deadline. |
| `archive` | shared hub status | Yes, server audit undo | Restore prior status/timestamps/version via audit before deadline. |
| `claim` | shared claim lock | Yes, server audit undo | Restore prior claim fields via audit before deadline. |
| `release` | shared claim lock | Yes, server audit undo | Restore prior claim fields via audit before deadline. |
| future source relay action | external side effect | No in W1c | Show non-undoable completion; reconciliation/source-specific rollback belongs to W2/W5. |

### Bulk Action

New route:

```http
POST /api/companies/:companyId/hub-items/bulk-action
```

Payload:

```ts
{
  bulkId?: string;
  items: Array<{
    id: string;
    action: "resolve" | "archive" | "dismiss" | "snooze" | "claim" | "release";
    expectedVersion?: number;
    until?: string;
    reason?: string;
    idempotencyKey?: string;
  }>;
}
```

Response:

```ts
{
  bulkId: string;
  summary: { succeeded: number; failed: number; skipped: number };
  results: Array<{
    id: string;
    status: "success" | "failed" | "skipped";
    item?: HubItemListRow;
    state?: HubItemUserState;
    auditId?: string;
    undoDeadline?: string | null;
    error?: { status: number; message: string; code?: string };
  }>;
}
```

Rules:

- Shared lifecycle actions use optimistic concurrency; missing `expectedVersion` fails with `400`.
- Personal state actions do not require `expectedVersion`.
- Each item is isolated; a failure never rolls back earlier successes.
- Results preserve request order.

### Audit / History

Add item audit route:

```http
GET /api/companies/:companyId/hub-items/:id/audit
```

Use `svc.getVisible` with `status` support so history items can show their audit trail.

History list uses the existing list route with `status=resolved` or `status=archived`, plus a UI history toggle. No separate `/history` endpoint is required unless implementation shows the route becomes awkward.

---

## Service Plan

### `server/src/services/hub-items.ts`

Add these internal helpers:

- `applyGuardedPatch(...)`: general version-guarded update for status and claim fields.
- `insertAudit(...)`: returns audit row id and undo deadline.
- `mapLifecycleAction(action)`: maps named action to allowed DB patch and authorization rules.
- `applyPersonalState(...)`: upsert/clear current user's sparse state.
- `undoAction(...)`: restore from audit prior state.
- `bulkAction(...)`: loop through per-item action handlers and normalize errors.

Update existing functions:

- `query`: add snooze filter and include claim fields in returned rows.
- `getVisible`: accept `status?: HubItemStatus | "any"` so undo/audit/history can read non-open items safely.
- `recordAndAct`: rename or wrap as `recordLifecycleAction`, with named actions and audit-returning response.
- `counts`: hide dismissed and future-snoozed rows so badges agree with visible active lists.

Keep invariants:

- All queries include `companyId`.
- All shared mutations guard on `version`.
- Authority gate uses semantic type, not current UI lane.
- Audit is written inside the same DB transaction as the hub mutation.

---

## UI Plan

### API Client

File: `ui/src/api/hub-items.ts`

Add:

- `markUnread(companyId, itemId)`
- `snooze(companyId, itemId, until)`
- `unsnooze(companyId, itemId)`
- `dismiss(companyId, itemId)`
- `undismiss(companyId, itemId)`
- `act(companyId, itemId, payload)`
- `undo(companyId, itemId, payload)`
- `bulkAction(companyId, payload)`
- `audit(companyId, itemId)`

Extend `HubItemListRow` with:

- `claimedByUserId`
- `claimedAt`

### Components

Files:

- `ui/src/pages/InboxHub.tsx`
- `ui/src/components/hub/HubShell.tsx`
- `ui/src/components/hub/HubList.tsx`
- `ui/src/components/hub/HubViewer.tsx`
- `ui/src/components/hub/HubHome.tsx`
- `ui/src/components/hub/hubTypes.ts`

Add UI behavior:

- List rows show read/unread state, snooze state, owner/pool, and claimed-by chip.
- Viewer action bar shows primary lifecycle actions appropriate for selected item:
  - Resolve
  - Archive
  - Dismiss
  - Snooze menu
  - Claim / Release when board-pool rules allow
  - Route/Escalate affordance when actor lacks final authority
- History toggle switches list query to `status=resolved` or `status=archived`.
- Bulk mode uses checkboxes, stable row dimensions, and a compact action toolbar.
- Undo toast/banner appears for 8 seconds after reversible actions.
- `409` conflicts show "Changed elsewhere" and refetch item/list/counts.
- `403` authority failures keep item visible and surface Route/Escalate affordance.
- `404` source/item gone removes selection and refetches.

Design constraints:

- Keep the dense operational shell from W1b.
- No nested cards.
- Use icons for repeated action buttons where existing icon library supports them.
- Avoid adding explanatory marketing/help text inside the app; labels should be task-facing.

---

## Implementation Tasks

### Task 0: Contract Tests First

Files:

- `packages/shared/src/validators/hub.ts`
- `packages/shared/src/__tests__/hub-contract.test.ts`

Add failing tests for:

- Named lifecycle action schema accepts `resolve/archive/claim/release`.
- Lifecycle action schema rejects `nextStatus`.
- User state schema accepts `unread/unsnooze/undismiss`.
- Bulk schema accepts mixed personal/shared action payloads and rejects invalid missing `until` for snooze.

Run:

```sh
pnpm --filter @armyofagents/shared test -- hub-contract.test.ts
```

### Task 1: Schema + Migration for Claim Fields

Files:

- `packages/db/src/schema/notifications.ts`
- `packages/db/src/__tests__/hub-items-schema.test.ts`
- generated migration under `packages/db/src/migrations/`

Steps:

1. Add `claimedByUserId`, `claimedAt`, and open-claimed index.
2. Update schema tests to assert the columns and index are present.
3. Run `pnpm db:generate`.

Run:

```sh
pnpm --filter @armyofagents/db test -- hub-items-schema.test.ts
```

### Task 2: Query Semantics for Snooze/Dismiss/Counts

Files:

- `server/src/services/hub-items.ts`
- `server/src/__tests__/hub-items-service.test.ts` or new `server/src/__tests__/hub-items-lifecycle.test.ts`

Add failing tests for:

- Future-snoozed item is hidden from default list and counts.
- Past-snoozed item returns to default list.
- `includeSnoozed=true` includes future-snoozed rows for explicit snoozed/history/debug views.
- Two-user snooze isolation: Alice snoozing an item does not hide it from Bob.
- Dismissed item is hidden only for the dismissing user.
- `includeDismissed=true` includes dismissed rows.
- Counts match default list semantics.

Implementation:

- Join `hubItemUserState` before user-state filters.
- Add `or(isNull(snoozedUntil), lte(snoozedUntil, now))` when `includeSnoozed` is false.
- Add the same personal-state filters to `counts`.

Run:

```sh
pnpm test:run server/src/__tests__/hub-items-lifecycle.test.ts
```

### Task 3: Personal State Route Completeness

Files:

- `server/src/routes/hub-items.ts`
- `server/src/services/hub-items.ts`
- `server/src/__tests__/hub-items-routes.test.ts`

Add failing route tests for:

- `read` sets `readAt`.
- `unread` clears `readAt`.
- `snooze` sets `snoozedUntil`.
- `unsnooze` clears `snoozedUntil`.
- `dismiss` sets `dismissedAt`.
- `undismiss` clears `dismissedAt`.
- State route returns 404 when item is not visible to the actor.
- Personal-state undo is covered at the UI mutation layer, not by server `/undo`.

Implementation:

- Move state write logic into service for reuse by bulk.
- Keep route thin: auth/company access -> role -> service call -> response.

### Task 4: Named Lifecycle Actions + Undo

Files:

- `server/src/services/hub-items.ts`
- `server/src/routes/hub-items.ts`
- `server/src/__tests__/hub-items-lifecycle.test.ts`
- `server/src/__tests__/hub-items-routes.test.ts`

Add failing tests for:

- `resolve` maps to `status=resolved`, bumps version, writes audit with undo deadline.
- `archive` maps to `status=archived`, bumps version, writes audit with undo deadline.
- `resolve/archive/claim/release` write `activity_log` entries with company id, actor, entity id, action, and reason when present.
- `claim` sets `claimedByUserId/claimedAt` without changing owner.
- `claim` conflicts if already claimed.
- Two users racing to claim the same board-pool item results in one success and one 409/conflict.
- `release` clears claim fields.
- Founder-required semantic types reject non-founder actions with 403.
- Stale `expectedVersion` returns 409.
- Undo restores status/claim fields before deadline and writes a second audit row.
- Undo rejects expired deadlines, mismatched versions, missing audit rows, and non-undoable audits.

Implementation:

- Return `{ item, auditId, undoDeadline }` from action route.
- Set `undoDeadline = now + 8 seconds` for W1c reversible hub-only actions.
- Include claim fields in audit `priorState`.
- Do not route `read/unread/snooze/unsnooze/dismiss/undismiss` through `hub_audit`; those are sparse personal-state writes.

### Task 5: Bulk Endpoint

Files:

- `packages/shared/src/validators/hub.ts`
- `server/src/services/hub-items.ts`
- `server/src/routes/hub-items.ts`
- `server/src/__tests__/hub-items-bulk.test.ts`

Add failing tests for:

- Mixed `resolve + dismiss + snooze` succeeds with ordered result rows.
- One stale item returns failed 409 while later items still run.
- One unauthorized item returns failed 403 while authorized items succeed.
- Missing `expectedVersion` for shared action returns failed 400 per item.
- Reused idempotency key does not duplicate audit or side effects.

Implementation:

- Normalize thrown `HttpError` into result rows.
- Keep item-level transactions; no outer transaction across all items.

### Task 6: UI API + Query Invalidations

Files:

- `ui/src/api/hub-items.ts`
- `ui/src/api/__tests__/hub-items-api.test.ts`
- `ui/src/__tests__/InboxHub.test.tsx`

Add failing tests for:

- API client emits expected URLs/bodies for state, action, undo, bulk, audit.
- Successful action invalidates list and counts queries.
- `409` invalidates and refetches instead of silently dropping the action.
- Personal-state mutation hooks capture previous per-item state so the 8-second undo banner can restore read/snooze/dismiss without server audit.

### Task 7: UI Lifecycle Controls

Files:

- `ui/src/pages/InboxHub.tsx`
- `ui/src/components/hub/HubList.tsx`
- `ui/src/components/hub/HubViewer.tsx`
- `ui/src/components/hub/HubHome.tsx`
- `ui/src/components/hub/hubTypes.ts`
- `ui/src/components/hub/__tests__/HubShell.test.tsx`
- `ui/src/__tests__/InboxHub.test.tsx`

Add failing tests for:

- Selecting an unread item can mark it read and unread.
- Dismiss removes the item from the default list but not from history/source state.
- Snooze removes item until future timestamp.
- Undo after read/snooze/dismiss calls the inverse state mutation and restores the cached row.
- Resolve/archive move item out of active list.
- Claim/release buttons appear only for eligible board-pool items.
- Authority-denied items show route/escalate affordance instead of a dead primary action.
- Undo after resolve/archive/claim/release calls the server `/undo` endpoint and restores the item.

Implementation:

- Keep action bar compact and keyboard/focus accessible.
- Use existing toast/banner patterns where available.
- Avoid layout shift in bulk mode by reserving checkbox/action space.

### Task 8: History + Audit UI

Files:

- `ui/src/pages/InboxHub.tsx`
- `ui/src/components/hub/HubList.tsx`
- `ui/src/components/hub/HubViewer.tsx`
- `ui/src/__tests__/InboxHub.test.tsx`

Add failing tests for:

- History toggle requests `status=resolved` and `status=archived`.
- Resolved/archived item can still be opened in viewer.
- Audit timeline loads for selected history item and shows action/reason/actor/time.

Implementation:

- Keep history as a mode inside the hub, not a new top-level route.
- Do not include dismissed personal-state rows unless user explicitly switches into an include-dismissed view.

### Task 9: E2E User Flow

Files:

- `tests/e2e/inbox-hub-w1c.spec.ts`
- `tests/e2e/inbox-hub-operator.spec.ts`
- `tests/e2e/helpers/seed-hub-item.ts`

Cover:

1. Seed waiting-on-you, notification, suggestion, board-pool item, and history item.
2. Open hub from sidebar and verify active counts.
3. Mark item read then unread.
4. Snooze item and verify it disappears from active list.
5. Dismiss item and verify it disappears without changing shared status.
6. Resolve item, see undo banner, undo, then resolve again.
7. Archive another item.
8. Claim and release a board-pool item.
9. Select multiple items and run bulk archive/dismiss with one stale-version failure.
10. Open history and verify resolved/archived items and audit timeline.

Operator matrix coverage in `tests/e2e/inbox-hub-operator.spec.ts`:

1. Founder can see all seeded lanes and act on founder-authority items.
2. Team lead sees owned items and department-scoped items, but not unrelated company items.
3. Team member sees only owned items.
4. Non-founder attempting a founder-only action sees the permission-denied state and Route/Escalate affordance.
5. Stale-version conflict refetches the row and preserves the user's context.
6. Source-deleted or reconciled-away item removes itself from the active list and shows a recoverable empty selection.
7. Mobile viewport preserves lane navigation, selection, action toolbar, undo, and bulk controls without overlap.
8. Header/sidebar deep links into `/inbox-hub/:lane/:itemId` keep selected lane/item stable after reload.

Implementation note: PR #244 landed the W1c user-flow spec in `tests/e2e/inbox-hub-w1c.spec.ts`. The fuller authenticated operator matrix remains a final cutover/W1d acceptance item because the current local trusted e2e path runs as an implicit founder-style operator and the Windows embedded-Postgres config skips focused specs without an explicit `DATABASE_URL`.

Run:

```sh
pnpm exec playwright test tests/e2e/inbox-hub-w1c.spec.ts tests/e2e/inbox-hub-operator.spec.ts --config tests/e2e/playwright.config.ts
```

### Task 10: Roadmap Notes + Final Verification

Files:

- `docs/aoa/plans/2026-06-29-inbox-hub-integration-roadmap.md`
- this plan

Update roadmap:

- Mark W1c implemented when complete.
- Record any explicit deferrals to W1d/W2/W5.

Required verification before handoff:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
pnpm exec playwright test tests/e2e/inbox-hub-w1b.spec.ts tests/e2e/inbox-hub-w1c.spec.ts tests/e2e/inbox-hub-operator.spec.ts --config tests/e2e/playwright.config.ts
```

If Playwright is impractical locally, run targeted Vitest locally and use GitHub CI e2e as the required gate before marking PR #244 ready.

---

## Risk Register

| Risk | Impact | Mitigation |
|---|---:|---|
| `nextStatus` contract leaks into W1c UI | High | Replace with named-action validator before UI implementation. |
| Snooze implemented as shared status | High | Personal-state tests first; counts/list both assert future-snoozed rows hidden only for the current user. |
| Undo restores stale state over newer changes | High | Require matching current version and live deadline. |
| Claim rewrites owner/accountability | Medium | Add separate claim fields; owner remains unchanged. |
| Bulk partial failures confuse users | Medium | Ordered per-item result plus banner summary; failed items remain visible/selected. |
| History/audit route exposes items across company/RBAC | High | Reuse `getVisible` with company + role checks for open/history statuses. |
| E2E becomes flaky on timing-based undo | Medium | Use deterministic UI timeout control where possible; test undo immediately, not at the expiry boundary. |
| Assignment scope expands into full routing workflow | Medium | W1c implements only board-pool Claim/Release. Route/Escalate remain visible affordances unless this plan is explicitly revised. |

---

## Review Checklist

- [x] Contract distinguishes shared lifecycle, personal state, and claim.
- [x] Every mutation is company-scoped.
- [x] Shared mutations use optimistic concurrency.
- [x] Audit is durable before any source side effect.
- [x] Shared actions write `activity_log` rows for operator visibility.
- [x] Undo refuses irreversible or stale actions.
- [x] Counts agree with default visible active list.
- [x] Snooze/dismiss are covered as personal user state in service and UI tests.
- [x] Bulk endpoint returns deterministic partial-failure results.
- [x] UI exposes eligible lifecycle, history, audit, claim/release, undo, and bulk controls.
- [x] Unit, integration, and W1c e2e spec coverage exist before final PR handoff.
- [ ] Authenticated multi-role operator matrix e2e is still deferred to final cutover/W1d acceptance.

---

## Review Notes

### Skills / Agent Review

- `superpowers:brainstorming`: used to lock W1c boundaries before implementation. Decision: same PR/branch, W1c includes lifecycle + board-pool claim/release; full route/reassign/escalate remains later.
- `superpowers:writing-plans`: used to write this tracked implementation plan with exact files, task order, tests, and commands.
- Independent read-only agent review: attempted against the current branch. The reviewer could not see the untracked draft file, but its substantive findings were still applied here:
  - resolve snooze semantics early;
  - add assignment/claim API + audit/activity requirements;
  - make undo/history a concrete server contract;
  - define bulk partial-failure contract;
  - add multi-role/unhappy-path operator e2e coverage.

### Review Status

- CEO/product scope: **cleared with constraint**. Keep W1c to lifecycle + board-pool claim/release; do not silently absorb full delegation/routing.
- Engineering: **cleared after patch**. The main ambiguity from W1a (`nextStatus` and shared snooze) is now an explicit first contract task.
- Design/UX: **cleared for implementation**. The plan preserves W1b's dense operational shell and adds lifecycle controls, undo, history, and bulk without introducing a new landing page or separate surface.

### Post-Implementation Notes

- W1c landed in PR #244 on top of W1b as the intended single user-facing Inbox Hub PR.
- Implemented scope includes named lifecycle actions, personal read/snooze/dismiss state, audit-backed shared undo, history/audit UI, board-pool Claim/Release, bulk action UI, and stale partial-failure reporting.
- Explicit deferrals remain full Route/Reassign/Escalate workflows, OOO/delegation automation, authenticated multi-role operator e2e, mobile-specific W1d hardening, maintained counters/search/grouping/performance, realtime/toast preferences, source-side undo/relay, Autopilot, and Steward intelligence.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` criteria | Scope & strategy | 1 | CLEAR | Held W1c to lifecycle + board-pool Claim/Release; full Reassign/Escalate/OOO/Route automation remains W1d/W2/W5+ unless explicitly revised. |
| Codex Review | Independent read-only agent | Second opinion | 1 | CLEAR AFTER PATCH | Substantive findings applied: snooze semantics, assignment/activity log expectations, undo contract, bulk partial-failure contract, and operator e2e coverage. |
| Eng Review | `/plan-eng-review` criteria | Architecture & tests | 1 | CLEAR AFTER PATCH | Found and fixed one P1 planning ambiguity: personal-state undo cannot rely on `hub_audit`; plan now separates client-state undo from server audit undo and adds matching tests. |
| Design Review | `/plan-design-review` criteria | UI/UX gaps | 1 | CLEAR AFTER PATCH | Dense W1b shell preserved; plan now distinguishes inverse state undo vs server `/undo`, includes stale/permission/source-gone states, and requires multi-role/mobile operator e2e. |
| DX Review | Manual checklist | Developer experience gaps | 1 | CLEAR | Plan names exact files, task order, migration command, targeted tests, final verification, and roadmap update step. |

- **CODEX:** Independent reviewer could not see the original untracked draft, but all applicable substantive findings were applied after the plan was tracked.
- **UNRESOLVED:** 0 blocking review decisions. Known deferrals are explicit: full routing/reassign/escalate automation, W2 realtime/toast bridge, W3 Autopilot, W4 Steward, W5 adapter bridges, and W1d search/mobile/performance.
- **VERDICT:** CEO + ENG + DESIGN + DX cleared after patch. Ready to implement W1c starting with Task 0 contract tests and Task 1 claim schema/migration.
