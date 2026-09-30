---
title: Activity
summary: Activity log queries and manual log entries
---

Query the audit trail of all mutations across the company. Issue identifiers (`PROJ-123` format) are accepted wherever issue IDs are required.

## List Company Activity

```
GET /api/companies/{companyId}/activity
```

Query parameters:

| Param | Description |
|-------|-------------|
| `agentId` | Filter by actor agent |
| `entityType` | Filter by entity type (`issue`, `agent`, `approval`, etc.) |
| `entityId` | Filter by specific entity |

## Log Manual Activity Entry

```
POST /api/companies/{companyId}/activity
{
  "actorType": "user",
  "actorId": "{userId}",
  "action": "custom.note",
  "entityType": "issue",
  "entityId": "{issueId}",
  "details": { "note": "Manual observation" }
}
```

Creates a custom activity log entry. Board access required. Returns `201` with the created entry. `details` values are sanitized before storage.

## Issue Activity

```
GET /api/issues/{issueId}/activity
```

Returns all activity log entries for a specific issue, **scoped to the company that owns the issue**. Accepts issue ID or identifier format (`PROJ-123`).

The company scope is a security predicate, not a convenience: `entityType`/`entityId` are free text on some writers, so before it existed a row recorded against another tenant but typed `issue` with this issue's id was returned here. Rows with no company are never returned by this route.

## Security Denial Evidence (operator only)

```
GET /api/instance/security-denials
```

Returns durable `security.denied.*` audit rows **across all tenants**, newest first. This is the reader for the security-denial namespace written by the deny paths in `services/security-denial-audit.ts`.

Requires **instance-operator** access (the same gate as `/api/instance/settings/*`). It is not reachable by any company member, founders included, and there is deliberately **no company-scoped denial feed**: a cross-tenant probe is attributed to the *actor's* own tenant and is never surfaced to the probed tenant. Whether a probed tenant is entitled to know it was probed is an open programme decision; this surface does not pre-empt it.

Query parameters (all optional; every one narrows, none widens):

| Param | Description |
|-------|-------------|
| `crossing` | Threat-control crossing id, e.g. `DE-19` (matched on `details.crossing`) |
| `surface` | Denial surface slug — the `action` suffix, e.g. `memory_read` |
| `actorId` | The refused identity (agent id, user id, worker id) |
| `entityType` / `entityId` | The refused resource |
| `companyId` | Narrow to one tenant's refusals |
| `since` | ISO-8601 timestamp **lower** bound (inclusive) |
| `before` | Keyset cursor: the `cursor` value of the last row of the previous page. Also usable alone as a plain upper bound |
| `beforeId` | Keyset cursor: the `id` of that same row. **Requires `before`** — sent alone it is a `400`, never a silently ignored filter |
| `limit` | Page size, 1–500, default 100 |

Rows carry the full attribution the recorder wrote: who was refused, in which tenant, on which resource, by which control, and why (`details.reason`, a stable machine code).

### Paging — and why you must page on `cursor`, not `createdAt`

Every row carries a `cursor` field alongside its columns. To walk backwards in time, take `cursor` and `id` from the **last** row of a page and send them as `before` and `beforeId`. Repeat until a page comes back shorter than `limit`.

Without paging, only the newest `limit` matching refusals are reachable at all: `since` is a *lower* bound, so moving it earlier only ever adds newer rows. A sustained series of identical denials — what an incident actually looks like — would otherwise hide its own beginning.

**Do not build the cursor out of `createdAt`.** `createdAt` is JSON, so it is truncated to milliseconds, while rows are ordered at the microsecond precision Postgres stores. Measured on real Postgres, 40 rows written by 40 separate statements had 40 distinct microsecond timestamps and only 21 distinct millisecond ones — a `createdAt`-based cursor would have skipped 19 of them silently, with a `200` and no error. The `cursor` field exists precisely to avoid this and casts back losslessly.

### What `limit` does not do, and what does it instead

`limit` bounds the **result set**, not the scan. The scan is bounded by an index, which is a different mechanism.

Migration `0276` adds a **partial** index — `(created_at DESC, id DESC) WHERE action LIKE 'security.denied.%'` — matching this endpoint's predicate and its total order exactly. The default cross-tenant query is now planned as `Limit <- Index Scan`, with no `Sort` and no `Seq Scan`, and a cursor page's row-value comparison becomes an `Index Cond` (a seek) instead of a per-row `Filter`. Measured on real Postgres over 60,300 rows, the first page went from 1,098 shared buffers to 6, and a deep cursor page from 1,098 to 4; `Rows Removed by Filter: 60000` disappears. Because the index is partial it holds denial rows only, so ordinary product rows cost nothing to maintain and are invisible to it.

**This is a matched pair, not a free win** — and the three ways it can come apart do *not* all look the same, which an earlier draft of this paragraph got wrong. Each was measured against `server/src/__tests__/e0-f013-denial-index-plan.integration.test.ts`, which builds both of its plans from `activityService.securityDenials` itself rather than from a copy of its SQL:

| Drift on this endpoint | What actually happens | Caught by |
|---|---|---|
| Change the **action prefix** | The `WHERE` no longer implies the partial predicate; the plan reverts to `Sort <- Seq Scan`. | The plan arms, and 5 of 7 arms in total — the reader also stops returning the seeded rows at all. |
| Change the **sort direction** | The index cannot be walked in that order; the `Sort` returns. | The plan arms, and 4 of 7 arms in total (the positive control's *restore* assertion reds too: there is no good plan left to restore to). |
| Drop the **`id` tiebreaker** from the sort | **The plan does not change.** `created_at DESC` alone is a *prefix* of the index key order, so Postgres keeps using the index and keeps `Limit <- Index Scan`. What silently breaks is the total order the keyset cursor needs: pages lose rows on a `created_at` tie, with a `200` and no error. | Only the matched-pair arm, which compares the reader's emitted `ORDER BY` against `pg_indexes.indexdef` (1 of 7 red). |

The earlier draft said all three "silently revert it to `Sort <- Seq Scan` with no error and no failing test". The third row of that claim is false, and — until this was fixed — the "no failing test" half was true of *every* row, because the test transcribed the endpoint's SQL by hand instead of deriving it. Dropping the tiebreaker left both suites 23/23 green. See `docs/replatform/epics/E0-foundation/findings.md`.

Before `0276` this section said deep paging re-scanned the table per page. That was accurate then and is not now.

**Not measured:** the index's *build* cost at production scale (a partial index still scans the whole heap to build, holding a `SHARE` lock that blocks writes to `activity_log`), and the plan guard runs against embedded-postgres at 40,000 rows, not production volumes.

## Issue Heartbeat Runs

```
GET /api/issues/{issueId}/runs
```

Returns the heartbeat run history for a specific issue — all runs that worked on it. Accepts issue ID or identifier format.

## Issues for a Run

```
GET /api/heartbeat-runs/{runId}/issues
```

Returns the issues that a specific heartbeat run touched or was working on.

---

## Activity Record Fields

| Field | Description |
|-------|-------------|
| `actor` | Agent or user who performed the action |
| `action` | What was done (e.g. `issue.created`, `agent.paused`, `approval.approved`) |
| `entityType` | Type of entity affected |
| `entityId` | ID of the affected entity |
| `details` | Specifics of the change |
| `createdAt` | When the action occurred |

The activity log is append-only and immutable. All mutations are automatically recorded:

- Issue creation, updates, status transitions, assignments, checkouts
- Agent creation, configuration changes, pausing, resuming, termination
- Approval creation, decisions, comments
- Comment creation and feedback votes
- Budget and company configuration changes
- Label, secret, and memory item changes
