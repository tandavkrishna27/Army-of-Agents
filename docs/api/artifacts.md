---
title: Artifacts API
summary: Versioned company deliverables, task links, archival, and MCP publication
---

Artifacts are company-scoped deliverables such as documents, reports, code, designs, and presentations. Metadata is mutable, but every artifact version is immutable. `currentVersionId` points to the version currently shown by the board.

## List Artifacts

```http
GET /api/companies/{companyId}/artifacts
GET /api/companies/{companyId}/artifacts?includeArchived=true
```

Archived artifacts are excluded by default. Results are ordered by most recently updated.

## Get an Artifact

```http
GET /api/artifacts/{artifactId}
```

Returns the artifact and all versions, newest first. Access is limited to actors with access to the artifact's company.

## Create an Artifact

```http
POST /api/companies/{companyId}/artifacts
Content-Type: application/json

{
  "title": "Launch report",
  "description": "Final launch analysis",
  "type": "report",
  "source": "founder",
  "content": "# Launch report",
  "storageKind": "inline",
  "filename": "launch-report.md",
  "contentType": "text/markdown"
}
```

`title` is required. `type` is one of `document`, `presentation`, `code`, `design`, `report`, or `other`. The optional initial-version fields are supplied at the top level, and the initial version is created only when `source` is present. Returns `201`.

## Update Metadata

```http
PATCH /api/artifacts/{artifactId}

{
  "title": "Launch report — final",
  "description": "Approved analysis",
  "type": "report"
}
```

Metadata updates do not rewrite version history. The PATCH schema also accepts
`status` as `draft`, `active`, or `archived`; unlike the dedicated lifecycle
routes below, the current PATCH route uses the ordinary company-access check and
does not enforce archive transitions.

## Publish a Version

```http
POST /api/artifacts/{artifactId}/versions

{
  "source": "founder",
  "sourceDetail": "Board editor",
  "changelog": "Added the final metrics",
  "parentVersionId": "{versionId}",
  "content": "# Launch report\n\n...",
  "storageKind": "inline",
  "filename": "launch-report.md",
  "contentType": "text/markdown"
}
```

This REST route requires a board actor with founder authority and returns
`201`. Agents and MCP keys cannot use it. The server assigns the next version
number and moves `currentVersionId`; older versions remain unchanged. `source`
is one of `agent`, `founder`, `mcp`, `teammate`, or `external`.

Use `storageKind: "inline"` with `content`, or `storageKind: "asset"` with an `assetId` from the same company. Asset-backed versions can also include `fileUrl`, `filename`, `contentType`, `extension`, `byteSize`, and `sha256`.

`parentVersionId`, when present, must identify a version of the same artifact.

## Archive and Restore

```http
POST /api/artifacts/{artifactId}/archive
POST /api/artifacts/{artifactId}/unarchive
```

Both operations require board access and founder authority. Archiving is allowed only from `active`; unarchiving is allowed only from `archived`. Invalid transitions return `400`. Archiving hides the artifact from the default list but does not delete its versions.

## Artifact Linked to a Task

```http
GET /api/issues/{issueId}/artifacts
```

Returns the task's linked artifact, or `null` when the task has none.

## Publish from MCP

```http
POST /api/mcp/artifacts/{artifactId}/versions

{
  "sourceDetail": "docs-publisher",
  "changelog": "Published from the documentation tool",
  "content": "# Updated document",
  "storageKind": "inline"
}
```

This legacy direct-ingress route accepts a board founder or an MCP API key
owned by a founder. It rejects agents, forces `source` to `mcp`, and requires
`sourceDetail`.

JSON-RPC MCP clients should normally call `attach-artifact-version` on
`POST /api/companies/{companyId}/mcp`. That tool accepts board and MCP actors,
then enforces company isolation, project scope, and artifact-update permission;
it is not a founder-only tool. See the [MCP API](mcp.md).

## Common Errors

- `400` — invalid payload, archive transition, parent version, or cross-company asset
- `403` — no company access or insufficient role
- `404` — artifact, task, version, or asset not found
