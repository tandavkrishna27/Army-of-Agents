---
title: Hub and Notifications
summary: Inbox Hub items, notification state, sidebar badges, and hub actions
---

The Hub powers Home and Inbox. It materializes actionable work from approvals, runtime decisions, notifications, suggestions, stale work, and workflow events into one company-scoped item stream.

All routes are under `/api` and require company access. Results are RBAC-scoped to the caller.

## Preferences

```
GET /api/companies/{companyId}/hub-items/preferences/me
PATCH /api/companies/{companyId}/hub-items/preferences/me
POST /api/companies/{companyId}/hub-items/preferences/me/reset
```

Stores the current user's hub grouping/display preferences.

## List Hub Items

```
GET /api/companies/{companyId}/hub-items
```

Common query parameters:

| Param | Description |
|-------|-------------|
| `lane` | Hub lane: `waiting_on_you`, `notifications`, or `suggestions` |
| `limit` | Page size, capped by the shared hub validator |
| `cursor` | Pagination cursor |
| `q` | Search text |
| `includeDismissed` | Include personally dismissed items |
| `includeSnoozed` | Include snoozed items |

The route reconciles open approval, runtime-decision, and stale-work sources before returning rows. The response shape is:

```json
{
  "items": [],
  "nextCursor": null,
  "totalKnown": 0
}
```

Item rows are passthrough records because each semantic type carries source-specific fields. Boolean query params accept `true`/`false` and `1`/`0`. Use item `version` as an optimistic concurrency guard when acting on a hub item.

## Counts and Badges

```
GET /api/companies/{companyId}/hub-items/counts
GET /api/companies/{companyId}/hub-items/hidden-count
GET /api/companies/{companyId}/sidebar-badges
```

Counts are scoped to the current user and company. Sidebar badges are the compact counts used by the primary navigation.

## Item Detail and Actions

```
GET /api/companies/{companyId}/hub-items/{id}
POST /api/companies/{companyId}/hub-items/{id}/action
PATCH /api/companies/{companyId}/hub-items/{id}/state
POST /api/companies/{companyId}/hub-items/{id}/undo
GET /api/companies/{companyId}/hub-items/{id}/audit
POST /api/companies/{companyId}/hub-items/bulk-action
```

Actions are source-aware. Runtime decisions, approvals, suggestions, and notifications each validate the source row before closing or updating the hub item. Shared lifecycle actions use `/action`; personal visibility state uses `/state`; bulk operations use `/bulk-action`.

Runtime decision answers require the backing source revision and nonce so stale browser tabs cannot answer old prompts.

## Autopilot

```
GET /api/companies/{companyId}/hub-autopilot/policy
GET /api/companies/{companyId}/hub-autopilot/actions
PATCH /api/companies/{companyId}/hub-autopilot/policy
POST /api/companies/{companyId}/hub-autopilot/policy/reset
```

Autopilot policy controls which hub actions can be suggested or taken automatically. The Hub Home surface displays recent autopilot actions and policy status.

## Notifications

```
GET /api/companies/{companyId}/notifications
GET /api/companies/{companyId}/notifications/unread-count
PATCH /api/companies/{companyId}/notifications/{id}/read
PATCH /api/companies/{companyId}/notifications/{id}/dismiss
```

Notifications are lower-level records used by the Hub and Settings/notification surfaces. Prefer Hub routes for operator Inbox behavior.
