---
title: Discussions
summary: Discussion threads, entries, extracted items, annotations, and the approval flow
---

Discussions are the primary input pipeline for AoA. Paste text, write directly, record voice, or push via MCP — all routes land in a discussion thread where the LLM extracts tasks and memory suggestions for founder review.

See `CLAUDE.md` §Discussion Pipeline for the full architecture.

## List Discussions

```
GET /api/companies/{companyId}/discussions
```

Query parameters:

| Param | Description |
|-------|-------------|
| `status` | Filter by status: `active` \| `archived` |
| `scopeType` | Filter by scope: `department` \| `project` \| `goal` |
| `scopeId` | Filter by the scoped entity's ID |
| `hasPendingItems` | `true` \| `false` — filter by pending extracted item presence |
| `inputType` | Filter by entry input type: `paste` \| `write` \| `voice` \| `mcp` |

Returns `{ discussions: [...], total, limit, offset }`.

## Get Discussion

```
GET /api/companies/{companyId}/discussions/{discussionId}
```

Returns the discussion with its entries and extracted items.

## Create Discussion

```
POST /api/companies/{companyId}/discussions
```

Requires `founder` or `team_lead` role.

```json
{
  "title": "Q3 planning notes",
  "scopeType": "goal",
  "scopeId": "{goalId}",
  "tags": ["planning"],
  "entry": {
    "inputType": "paste",
    "rawContent": "We need to ship the new onboarding flow by end of Q3.",
    "departmentId": null,
    "projectId": "{projectId}",
    "goalId": "{goalId}"
  }
}
```

Fields:
- `title` — optional display name
- `scopeType` — `department`, `project`, or `goal` (optional; sets thread-level scope)
- `scopeId` — ID of the scoped entity (optional)
- `tags` — optional string array
- `entry` — optional first entry created alongside the thread (see Add Entry below)

Returns `201` with the created discussion.

## Update Discussion

```
PATCH /api/companies/{companyId}/discussions/{discussionId}
```

Requires `founder` or `team_lead` role. Updatable fields: `title`, `status` (`active` | `archived`), `tags`.

## Add Entry

```
POST /api/companies/{companyId}/discussions/{discussionId}/entries
```

Requires `founder` or `team_lead` role.

```json
{
  "inputType": "paste",
  "rawContent": "Decided: we will use SSE for all streaming endpoints.",
  "title": null,
  "departmentId": null,
  "projectId": "{projectId}",
  "goalId": null,
  "sourceInfo": null,
  "clientSubmissionId": "{stableClientId}",
  "attachments": [
    { "assetId": "{assetId}" }
  ]
}
```

Fields:
- `inputType` — `paste` \| `write` \| `voice` \| `mcp` (required)
- `rawContent` — raw text content; it may be empty when an attachment is present
- `title` — optional entry title
- `departmentId` / `projectId` / `goalId` — entry-level scope override. Entry scope takes priority over thread scope (Decision #61)
- `sourceInfo` — arbitrary metadata (used by MCP push to carry caller context)

The entry may contain text, attachments, or both. `attachments` accepts up to
five references, each containing exactly one usable `assetId` or `artifactId`.
`clientSubmissionId` is an optional stable retry identity up to 200 characters.

Returns `201` for a new entry and `200` when replaying a previously accepted
`clientSubmissionId`. Authorization is checked before replay lookup. A replay
returns the existing entry and does not duplicate it.

Agent mentions in accepted text are resolved and written to a durable mention
outbox in the same transaction as the entry. Delivery is retried and replay-safe;
it is durable processing, not a guarantee that an agent executes exactly once.

Extraction runs asynchronously — poll the discussion to see `extractionStatus`
updates on the entry. Reconnecting clients can catch up with
`GET .../entries?sinceSeq={n}`.

## Reprocess Entry

```
POST /api/companies/{companyId}/discussions/{discussionId}/entries/{entryId}/reprocess
```

Requires `founder` role. Re-runs LLM extraction on a failed or completed entry. Returns the new extraction result.

## Reprocess All Entries

```
POST /api/companies/{companyId}/discussions/{discussionId}/reprocess
```

Requires `founder` role. Reprocesses all entries in the thread. Returns `{ reprocessed: N }`.

## Update Extracted Item

```
PATCH /api/companies/{companyId}/discussions/{discussionId}/entries/{entryId}/items/{itemId}
```

Requires `founder` or `team_lead` role. Edit a pending extracted item before approving it. Accepts any subset of the item's fields.

## Approve / Reject Items

```
POST /api/companies/{companyId}/discussions/{discussionId}/approve
```

Requires `founder` role. Batch approval/rejection of extracted items. Creates tasks and memory items for approved items.

```json
{
  "items": [
    { "itemId": "{itemId1}", "action": "approved" },
    { "itemId": "{itemId2}", "action": "edited", "edits": { "title": "Revised title" } },
    { "itemId": "{itemId3}", "action": "rejected" }
  ],
  "dependencies": [
    { "dependentItemId": "{itemId2}", "dependencyItemId": "{itemId1}" }
  ]
}
```

Item actions:
- `approved` — create task or memory item as-is
- `edited` — apply `edits` then create
- `rejected` — dismiss the item

The optional `dependencies` array wires blocking relationships between approved items. Both items must have been approved in this call (or previously).

Returns:
```json
{
  "approved": 2,
  "rejected": 1,
  "tasksCreated": ["{taskId1}", "{taskId2}"],
  "memoryItemsCreated": []
}
```

## Add Annotation

```
POST /api/companies/{companyId}/discussions/{discussionId}/entries/{entryId}/annotations
```

Requires `founder` or `team_lead` role. Adds an inline annotation to a character range of an entry.

```json
{
  "anchorStart": 42,
  "anchorEnd": 78,
  "content": "This needs clarification — check with the design team."
}
```

`anchorStart` and `anchorEnd` are character offsets into the entry's `rawContent`.

Returns `201` with the annotation.

## Link Entry to Different Discussion

```
POST /api/companies/{companyId}/discussions/link
```

Requires `founder` role. Moves an entry from its current discussion to a different one.

```json
{
  "entryId": "{entryId}",
  "targetDiscussionId": "{targetDiscussionId}"
}
```

Returns:
```json
{
  "entryId": "{entryId}",
  "previousDiscussionId": "{sourceDiscussionId}",
  "newDiscussionId": "{targetDiscussionId}"
}
```

## Scope Versions

Scope versions turn a messy discussion into a reviewed handoff. A discussion can
have multiple scope versions over time; after an accepted version, a later
re-scope uses only the newer source range.

Read routes remain company-scoped:

```
GET /api/companies/{companyId}/discussions/{discussionId}/scope-versions
GET /api/companies/{companyId}/discussions/{discussionId}/scope-versions/{scopeVersionId}
```

Manual mutation routes are board/human actions. Agent API-key actors must use
the internal action-gated thread-agent path rather than these REST endpoints:

```
POST  /api/companies/{companyId}/discussions/{discussionId}/scope-versions/draft
PATCH /api/companies/{companyId}/discussions/{discussionId}/scope-versions/{scopeVersionId}
POST  /api/companies/{companyId}/discussions/{discussionId}/scope-versions/{scopeVersionId}/items/review
PATCH /api/companies/{companyId}/discussions/{discussionId}/scope-versions/{scopeVersionId}/items/{itemId}
POST  /api/companies/{companyId}/discussions/{discussionId}/scope-versions/{scopeVersionId}/items/{itemId}/create
POST  /api/companies/{companyId}/discussions/{discussionId}/scope-versions/{scopeVersionId}/apply
POST  /api/companies/{companyId}/discussions/{discussionId}/scope-versions/{scopeVersionId}/accept
POST  /api/companies/{companyId}/discussions/{discussionId}/scope-versions/{scopeVersionId}/reject
POST  /api/companies/{companyId}/discussions/{discussionId}/scope-versions/{scopeVersionId}/complete
PUT   /api/companies/{companyId}/discussions/{discussionId}/scope/plan
```

### Create Draft

```
POST /api/companies/{companyId}/discussions/{discussionId}/scope-versions/draft
```

Body:

```json
{
  "mode": "generate",
  "summary": "Optional override",
  "assumptions": [],
  "decisions": [],
  "openQuestions": []
}
```

Returns `201` when a new draft is created, `200` when an existing draft is
returned, and `409` when the thread cannot be scoped directly.

### Review Or Edit Scope Items

```
POST /api/companies/{companyId}/discussions/{discussionId}/scope-versions/{scopeVersionId}/items/review
PATCH /api/companies/{companyId}/discussions/{discussionId}/scope-versions/{scopeVersionId}/items/{itemId}
```

Review body:

```json
{
  "items": [
    { "itemId": "{itemId}", "status": "accepted" }
  ]
}
```

Item statuses are `draft`, `accepted`, or `rejected`.

### Create One Output

```
POST /api/companies/{companyId}/discussions/{discussionId}/scope-versions/{scopeVersionId}/items/{itemId}/create
```

For task cards, this creates a task with `sourceDiscussionId`,
`scopeVersionId`, and a scope handoff context bundle. For memory cards, the
optional `memoryStatus` controls whether the memory is saved as pending or
approved:

```json
{
  "memoryStatus": "pending"
}
```

`memoryStatus: "approved"` is allowed only when the current board user passes
the normal memory approval policy for the candidate layer and department.
Unauthorized approved saves return a permission error; callers should offer
`pending` as the safe fallback.

### Apply, Accept, Reject, Complete

`apply` creates outputs for accepted cards without accepting the whole version.
`accept` accepts selected cards and applies them. `reject` rejects the draft.
`complete` marks an already-accepted/applied version complete.

All successful scope mutations write activity log entries with the discussion,
scope version, item IDs, created task IDs, memory IDs, and artifact link IDs
where relevant.

## Extraction Item Types

Extracted items have a `type` field:

| Type | Creates |
|------|---------|
| `task` | A new task in `issues` |
| `memory` | A pending memory item |
| `decision` | Stored on the item; no downstream entity created automatically |
| `insight` | Same as decision |
| `context` | Same as decision |
| `reference` | Same as decision |
| `preference` | Same as decision |

## Extraction Status

Each entry tracks its extraction lifecycle:

| Status | Meaning |
|--------|---------|
| `pending` | Queued for extraction |
| `processing` | LLM extraction running |
| `completed` | Extraction succeeded; items available for review |
| `failed` | Extraction failed; founder notified via `notifications`. Use Reprocess Entry to retry. |

## Scope Fallback

Discussion scope resolves in this order (Decision #61):

1. Per-item founder override (highest priority)
2. Entry-level scope (`departmentId`/`projectId`/`goalId` on the entry)
3. Thread-level scope (`scopeType`/`scopeId` on the discussion)
4. `null` (company-wide)

## Thread Operations

The current Discussions UI is a Threads workspace. In addition to basic thread, entry, extraction, and scope-version routes, the server exposes thread operations for inbox intake, lifecycle, ownership, participation, routing, and crew workflow.

### Inbox Intake

```
GET /api/companies/{companyId}/discussions/inbox
POST /api/companies/{companyId}/discussions/inbox
POST /api/companies/{companyId}/discussions/inbox/{itemId}/triage
```

Inbox items are unlisted inbound material that can become threads or be dismissed.

### Lifecycle and Ownership

```
PATCH /api/companies/{companyId}/discussions/{threadId}/phase
POST /api/companies/{companyId}/discussions/{threadId}/claim
POST /api/companies/{companyId}/discussions/{threadId}/transfer
POST /api/companies/{companyId}/discussions/{threadId}/share-token
DELETE /api/companies/{companyId}/discussions/{threadId}/share-token
```

Lifecycle changes are company-scoped and then service-level thread RBAC applies. Share-token and crew-control actions are founder/board operations.

### Participants, Routing, and Crew Controls

```
POST /api/companies/{companyId}/discussions/{threadId}/participants
POST /api/companies/{companyId}/discussions/{threadId}/crew/pause
POST /api/companies/{companyId}/discussions/{threadId}/crew/resume
```

`autonomyLevel` accepts `0`, `1`, `2`, or `null`. It does not accept `3`.

### Scope Item Workflow

```
POST /api/companies/{companyId}/discussions/{threadId}/spin-off
POST /api/companies/{companyId}/discussions/{threadId}/scope-deps
POST /api/companies/{companyId}/discussions/{threadId}/scope-deps/graduate
PATCH /api/companies/{companyId}/discussions/{threadId}/items/{itemId}/routing
```

Spin-off accepts `scopeItemId` in the request body. Scope dependency routes wire extracted-item dependencies before creating work. Per-item routing lives under `/items/{itemId}/routing`.

### Links, Proposals, and Catch-up

```
GET /api/companies/{companyId}/discussions/{threadId}/links
POST /api/companies/{companyId}/discussions/{threadId}/links
POST /api/companies/{companyId}/discussions/{threadId}/proposals/{proposalEntryId}/approve
GET /api/companies/{companyId}/discussions/{threadId}/entries?sinceSeq={n}
```

`sinceSeq` returns catch-up entries ordered by sequence for clients that reconnect after missing live events.

## Extraction Runtime

Extraction is CLI-only. Discussion extraction, `debrief-push`, file import, and crew memory-extract tools all run through the same local CLI extraction path. AoA does not expose an extraction engine-status endpoint and does not fall back to hosted provider keys for extraction. Embeddings are the only hosted runtime API key use.

Failures are stored on the entry and surfaced to the founder with actionable setup copy. Typical failure classes include missing CLI, unauthenticated CLI, timeout, nonzero exit, and unparseable output. Retry through the Discussion UI after fixing the local CLI problem.

Memory embedding re-index routes are documented in `docs/api/memory.md`.
