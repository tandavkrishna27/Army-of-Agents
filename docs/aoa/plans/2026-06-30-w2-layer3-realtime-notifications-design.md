# W2 Layer 3 Realtime Notifications Design

## Goal

Build the roadmap-scoped W2 Layer 3 slice for the Inbox Hub: realtime hub updates,
toast bridging, notification preferences, anti-spam, quiet hours, and digest
queuing. This builds on W1 Hub, W2 Layer 2 notification registry, and Toast Layer
1 without creating a second notification store or toast system.

## Scope

### In

- Publish safe hub realtime events through the existing `LiveEvents` bus.
- Replace Inbox Hub polling dependence with WebSocket-driven invalidation and
  refetch.
- Bridge visible, eligible hub notification items into the existing
  `ToastContext` API.
- Add per-user, per-company notification preference rules for `realtime`,
  `digest`, and `silent` delivery.
- Add quiet-hours handling and anti-spam suppression for toast delivery.
- Queue digest-eligible hub items for a digest summary flow.
- Add unit, integration, and Playwright coverage for the full operator flow.

### Out

- W3 Autopilot decisions, auto-handle, trust-gated actioning, and auto-action
  audit.
- W4 Steward curation intelligence.
- W5 runtime adapter bridges and CLI permission relay.
- Email delivery or a full mail client.
- A second notification persistence table for hub items.
- A second toast renderer or toast API.

## Design Principles

1. **Hub remains canonical.** Notifications are hub items. Realtime events notify
   clients that hub state changed; clients refetch through existing RBAC-scoped
   routes before showing content.
2. **Hub events are metadata-only and RBAC-filtered.** The WebSocket server must
   filter `hub.item.changed` through hub visibility before delivery. Hub live
   payloads must not include titles, summaries, message bodies, or source
   secrets.
3. **Preferences are per human operator.** Delivery choices belong to the user in
   a company context, not to the company globally.
4. **Toast bridge is optional delivery, not storage.** Toasts are an interrupting
   surface for eligible hub rows. The hub list remains the durable record.
5. **Digest is a queue first.** W2-L3 should persist digest intent and expose a
   deterministic summary path. Sending email remains out of scope.

## Architecture

### Server Realtime Publishing

Add shared live event types for hub changes:

- `hub.item.changed`
- `hub.counts.changed`
- `hub.digest.changed`

The payloads are intentionally narrow:

```ts
interface HubItemChangedPayload {
  itemId: string;
  semanticType: HubSemanticType;
  lane: HubLane;
  status: HubItemStatus;
  version: number;
  change: "created" | "updated" | "state_changed" | "resolved" | "archived";
}

interface HubCountsChangedPayload {
  reason: "item_changed" | "personal_state_changed" | "digest_changed";
}
```

`hubItemsService.emit`, `applyPersonalState`, lifecycle actions, bulk actions,
undo, reconcile, and sweeper-return paths publish these events after successful
DB writes. Publishing happens after the durable mutation, and failed publishing
does not roll back the hub mutation. Transaction-backed emit/reconcile callers
must avoid publishing before their outer transaction commits.

`hub.item.changed` is delivered only to board sockets that can see the item.
Agent sockets do not receive `hub.*` events because the hub is a human attention
plane. `local_trusted` board sockets may receive hub events under the existing
single-operator loopback trust boundary.

### Notification Preferences

Create a dedicated notification preferences model rather than overloading W1d
hub layout preferences.

The rule key is a hub semantic type for the first implementation. Category-level
defaults can be layered later by deriving semantic types into categories, but the
stored rule is explicit and testable.

```ts
type NotificationDeliveryMode = "realtime" | "digest" | "silent";

interface NotificationPreferenceRule {
  semanticType: HubSemanticType;
  deliveryMode: NotificationDeliveryMode;
  toastEnabled: boolean;
}

interface NotificationPreferences {
  rules: NotificationPreferenceRule[];
  quietHours: {
    enabled: boolean;
    start: string; // "HH:mm"
    end: string;   // "HH:mm"
    timezone: string;
  };
  digest: {
    enabled: boolean;
    cadence: "daily";
  };
}
```

Routes:

- `GET /api/companies/:companyId/notifications/preferences/me`
- `PATCH /api/companies/:companyId/notifications/preferences/me`
- `POST /api/companies/:companyId/notifications/preferences/me/reset`
- `GET /api/companies/:companyId/notifications/digest/me`
- `POST /api/companies/:companyId/notifications/digest/me/ack`

All routes require board/user context, assert company access, and return only the
current user's preferences and digest rows.

### Digest Queue

Add a digest queue table keyed by user, company, and hub item. Queue entries are
created when a visible hub item is eligible for digest delivery because the user's
preference or quiet-hours state suppresses realtime interruption.

Digest rows store hub item IDs and minimal metadata needed for stable ordering,
not message bodies. The digest endpoint joins back through hub visibility logic
before returning rows, so deleted, resolved, or no-longer-visible items do not
leak.

### UI Realtime Hook

Extend the existing `LiveUpdatesProvider` rather than opening a second company
WebSocket. The provider already owns reconnect behavior, online/offline state,
thread subscriptions, and toast gating.

On `hub.item.changed` or `hub.counts.changed`, the provider invalidates:

- `queryKeys.hubItems.counts(companyId)`
- active `queryKeys.hubItems.list(...)` queries
- `queryKeys.notifications.preferences(companyId)`
- `queryKeys.notifications.digest(companyId)` when digest events occur

### Toast Bridge

The toast bridge lives on the client because the client can only toast rows it
has fetched through RBAC-scoped APIs.

Flow:

1. WebSocket receives an RBAC-filtered `hub.item.changed`.
2. UI invalidates/refetches hub queries.
3. Inbox Hub hydrates the item through `GET /hub-items/:id`; this route uses the
   same hub RBAC checks as list/query.
4. If the changed item is visible to the current user and the preference says
   `realtime` with `toastEnabled = true`, the bridge shows a toast using existing
   `pushToast`.
5. The toast uses a stable dedupe key:
   `hub:${companyId}:${itemId}:${version}`.
6. If delivery is `digest`, `silent`, quiet-hours-suppressed, or anti-spam
   suppressed, no toast is shown.

Toast content comes from the authorized hub row after refetch. Live event payloads
never carry title or summary text.

### Anti-Spam And Quiet Hours

Anti-spam has two layers:

- client dedupe through `ToastContext` dedupe keys;
- server digest suppression records so repeated eligible events for the same
  user/item do not create duplicate pending digest entries.

Quiet hours are evaluated using the user's stored timezone. During quiet hours,
`realtime` rules fall back to digest when digest is enabled; otherwise they fall
back to silent.

### Settings UI

Replace the W1d disabled notification preferences entry with an active settings
panel in the Hub shell.

The panel includes:

- per-semantic-type delivery mode control;
- toast enabled toggle for realtime rules;
- quiet-hours enable/start/end/timezone controls;
- digest enabled/cadence controls;
- pending digest summary and acknowledge action;
- reset-to-defaults action.

The UI remains compact and operational, matching the existing Hub settings drawer
rather than introducing a new standalone page.

## Testing Strategy

### Unit

- Shared constants/types include the new live event types and notification
  preference modes.
- Preference validators reject invalid semantic types, duplicate rules, invalid
  quiet-hours times, and unsupported digest cadences.
- Toast bridge decision tests cover realtime, digest, silent, quiet-hours, and
  dedupe.
- `LiveUpdatesProvider` tests cover hub event invalidation, malformed event
  tolerance, reconnect reuse, and listener cleanup.

### Server Integration

- Hub emit publishes `hub.item.changed` without title/summary payload fields.
- Hub lifecycle and personal-state actions publish item/count change events.
- Preference routes are company-scoped and user-scoped.
- Digest queue only returns rows visible to the current user.
- Duplicate digest candidates are idempotent.

### UI Component

- Inbox Hub invalidates list/count queries when hub live events arrive.
- A visible realtime notification produces one toast.
- Digest/silent/quiet-hours preferences suppress toast delivery.
- Settings panel reads, patches, resets, and rolls back failures.

### E2E

Add a Playwright flow that:

1. opens Inbox Hub;
2. creates or emits a notification-backed hub item;
3. observes realtime list/count update without manual refresh;
4. verifies a realtime preference shows a toast;
5. switches the type to digest and verifies the next item appears in digest but
   does not toast;
6. switches the type to silent and verifies no toast/digest interruption;
7. exercises quiet-hours suppression.

## Rollout And Verification

The implementation PR should include the following verification before handoff:

```sh
corepack pnpm@9.15.4 test:run packages/shared/src/__tests__/constants.test.ts packages/shared/src/__tests__/notification-registry.test.ts
corepack pnpm@9.15.4 test:run server/src/__tests__/hub-items-lifecycle.test.ts server/src/__tests__/hub-items-routes.test.ts server/src/__tests__/notification-preferences.test.ts server/src/__tests__/notification-digest.test.ts
corepack pnpm@9.15.4 test:run ui/src/__tests__/InboxHub.test.tsx ui/src/context/__tests__/ToastContext.test.tsx ui/src/context/__tests__/LiveUpdatesProvider.test.tsx ui/src/components/hub/__tests__/HubShell.test.tsx
corepack pnpm@9.15.4 test:e2e -- tests/e2e/inbox-hub-realtime-notifications.spec.ts
corepack pnpm@9.15.4 -r typecheck
corepack pnpm@9.15.4 test:run
corepack pnpm@9.15.4 build
```

If local Windows embedded-postgres or Playwright constraints block a command, the
PR must rely on CI for that gate and document the skipped local command.

## Risks

| Risk | Mitigation |
|---|---|
| Company-wide live events leak notification content | Keep hub payloads metadata-only; refetch through RBAC routes before display. |
| Realtime duplicates toasts | Use stable toast dedupe keys and digest queue uniqueness. |
| Preferences become a layout-settings dumping ground | Use dedicated notification preference routes and DB table. |
| Digest grows into email | Persist digest queue and in-app summary only; email stays out of scope. |
| Scope drifts into W3/W4/W5 | Keep automation, Steward intelligence, and adapter bridges explicitly out. |

## Open Decisions Locked For Implementation

- Use the existing WebSocket `LiveEvents` transport, not a new SSE endpoint.
- Store notification preferences separately from hub layout preferences.
- Use hub semantic types as the first preference rule granularity.
- Keep digest in-app only for this PR.
- Do not include title, summary, message, or source payload text in live events.
