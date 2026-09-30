---
title: Workspaces
summary: Execution workspaces, runtime services, workspace git operations, and project git graph
---

In `cloud_auth`, tenant-authored workspace provision, teardown, cleanup, one-shot
job, and local runtime-service commands cannot execute on the control-plane host.
New command configuration and persisted legacy commands fail closed unless the
operator enables the explicit process-wide unsafe override. Self-hosted behavior
is unchanged. A future worker/provider implementation must move the entire
workspace lifecycle—not only the final agent process—behind its isolation boundary.
On upgrade, AoA reaps identity-matched persisted local runtime-service processes
before auto-restart. A cloud instance refuses to boot if a tracked live PID cannot
be verified and stopped; operators must stop the reported process before retrying.
The generic project-workspace create/update payload rejects
`metadata.runtimeConfig`, which is reserved for governed runtime-control APIs.

Execution workspaces are per-task git worktrees and runtime surfaces for software-development work. They are company-scoped through the owning task/project and enforce workspace authorization.

## Execution Workspaces

```
GET /api/companies/{companyId}/execution-workspaces
GET /api/execution-workspaces/{id}
PATCH /api/execution-workspaces/{id}
GET /api/execution-workspaces/{id}/runtime-services
GET /api/execution-workspaces/{id}/close-readiness
GET /api/execution-workspaces/{id}/workspace-operations
POST /api/execution-workspaces/{id}/runtime-services/{action}
POST /api/execution-workspaces/{id}/runtime-commands/{action}
```

Runtime actions start, stop, restart, or inspect configured services for a workspace.

## Workspace Git

```
GET /api/execution-workspaces/{id}/git/status
GET /api/execution-workspaces/{id}/git/safety
GET /api/execution-workspaces/{id}/git/log
POST /api/execution-workspaces/{id}/git/commit
POST /api/execution-workspaces/{id}/git/push
```

Git write operations require permission to operate on the workspace and are guarded by safety checks.

## Project Git

```
GET /api/companies/{companyId}/projects/{projectId}/git/graph
GET /api/companies/{companyId}/projects/{projectId}/git/enrich
```

These routes power project-level git graph visualizations and enrichment.
