---
title: Memory
summary: Memory search, CRUD, approvals, graph edges, folders, lifecycle, retrievals, and embedding re-indexing
---

Memory is company-scoped and approval-gated. Agents can suggest memory, but founder/team permissions determine what becomes approved knowledge. Embeddings use OpenAI `text-embedding-3-small` through the configured Memory secret; extraction remains CLI-only.

## Search and Read

```
GET /api/companies/{companyId}/memory/search
GET /api/companies/{companyId}/memory/find-similar
GET /api/companies/{companyId}/memory
GET /api/companies/{companyId}/memory-pending
GET /api/companies/{companyId}/memory/{id}
```

Search and list routes are RBAC-scoped. Pending items are used by review surfaces.

## Graph and Usage

```
GET /api/companies/{companyId}/memory/graph
GET /api/companies/{companyId}/memory/items/{id}/neighbors
GET /api/companies/{companyId}/memory/items/{id}/usage
POST /api/companies/{companyId}/memory/graph/edges
PATCH /api/companies/{companyId}/memory/graph/edges/{edgeId}
DELETE /api/companies/{companyId}/memory/graph/edges/{edgeId}
```

Graph routes power Memory Explorer relationship and backlink views.

## Create, Update, and Review

```
POST /api/companies/{companyId}/memory
PATCH /api/companies/{companyId}/memory/{id}
DELETE /api/companies/{companyId}/memory/{id}
POST /api/companies/{companyId}/memory/{id}/approve
POST /api/companies/{companyId}/memory/{id}/reject
POST /api/companies/{companyId}/memory/{id}/restore
POST /api/companies/{companyId}/memory/{id}/touch
```

Founder is the sole gatekeeper for identity and domain layers. Team leads may approve active-context items for their departments. Working memory is auto-created by approved flows.

## Versions

```
GET /api/companies/{companyId}/memory/{id}/versions
POST /api/companies/{companyId}/memory/{id}/draft
POST /api/companies/{companyId}/memory/{id}/publish
POST /api/companies/{companyId}/memory/{id}/versions/{versionId}/approve
POST /api/companies/{companyId}/memory/{id}/versions/{versionId}/reject
```

Memory edits use draft/publish/review semantics rather than mutating approved knowledge silently.

## Folders, Assets, Lifecycle, and Retrievals

```
GET /api/companies/{companyId}/memory/folders
POST /api/companies/{companyId}/memory/folders
PATCH /api/companies/{companyId}/memory/folders/{id}
DELETE /api/companies/{companyId}/memory/folders/{id}

GET /api/companies/{companyId}/memory/assets
GET /api/companies/{companyId}/memory/assets/{id}
GET /api/companies/{companyId}/memory/assets/{id}/content
GET /api/companies/{companyId}/memory/assets/{id}/render
POST /api/companies/{companyId}/memory/assets/upload
PATCH /api/companies/{companyId}/memory/assets/{id}
DELETE /api/companies/{companyId}/memory/assets/{id}

POST /api/companies/{companyId}/memory/lifecycle/archive-expired
POST /api/companies/{companyId}/memory/lifecycle/archive-working
POST /api/companies/{companyId}/memory/lifecycle/flag-stale

GET /api/companies/{companyId}/issues/{issueId}/memory-retrievals
GET /api/companies/{companyId}/conversations/{conversationId}/memory-retrievals
```

Asset routes list, upload, stream, render, update, and delete files attached to memory items. Render currently supports DOCX assets; use `/content` for raw bytes. Lifecycle routes are operational controls for expiry, working-memory archival, and stale-memory suggestion passes.

## Embedding Re-index

```
POST /api/companies/{companyId}/memory/{memoryItemId}/reindex
POST /api/companies/{companyId}/memory/reindex-failed
POST /api/companies/{companyId}/memory/reindex-all
```

Single item re-index returns:

```json
{ "reindexed": true }
```

Failed bulk requeue returns:

```json
{ "requeued": 4 }
```

`reindex-failed` and `reindex-all` are founder-only operational actions. They enqueue embedding work; they do not run hosted extraction.
