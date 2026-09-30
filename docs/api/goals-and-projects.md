---
title: Goals and Projects
summary: Goal hierarchy, project/department management, agent assignment, environment, and budget
---

Goals define the "why" and projects/departments define the "what" for organizing work.

## Goals

Goals form a hierarchy: company goals break down into team goals, which break down into agent-level goals.

### List Goals

```
GET /api/companies/{companyId}/goals
```

Query parameters:

| Param | Description |
|-------|-------------|
| `projectId` | Filter goals scoped to this project or department |

Goals support both the legacy single `parentId` shape and the current DAG-style `parentIds` shape. `projectIds` records department/project membership.

### Get Goal

```
GET /api/goals/{goalId}
```

### Create Goal

```
POST /api/companies/{companyId}/goals
{
  "title": "Launch MVP by Q1",
  "description": "Ship minimum viable product",
  "level": "company",
  "status": "active",
  "projectIds": ["{projectId}"]
}
```

`projectIds` is **required** — at least one department or project must be provided. Returns `400` if missing or empty. Requires `founder` or `team_lead` role.

### Update Goal

```
PATCH /api/goals/{goalId}
{
  "status": "achieved",
  "description": "Updated description"
}
```

### Delete Goal

```
DELETE /api/goals/{goalId}
```

Permanently removes the goal. Returns the deleted goal object. Requires `founder` or `team_lead` role.

### Goal Tree and Parents

```
GET /api/companies/{companyId}/goals/tree
PUT /api/goals/{goalId}/parents
```

The tree route returns the nested planning model used by the Objectives UI. Parent replacement enforces cycle prevention and scope integrity.

---

## Projects and Departments

The `projects` table serves both Departments and Projects, distinguished by `type`: `'department'` or `'project'`. Both use the same endpoints.

### List Projects

```
GET /api/companies/{companyId}/projects
```

Query parameters:

| Param | Description |
|-------|-------------|
| `type` | Filter by type: `department` or `project` |

### Get Project

```
GET /api/projects/{projectId}
```

Returns project details including workspaces. The `executionWorkspacePolicy` field is gated by the instance's `enableIsolatedWorkspaces` setting.

### Create Project

```
POST /api/companies/{companyId}/projects
{
  "name": "Auth System",
  "description": "End-to-end authentication",
  "type": "project",
  "status": "planned",
  "agentCompletionPolicyDefault": "review_required",
  "humanQuestionSlaHours": 12,
  "workspace": {
    "name": "auth-repo",
    "cwd": "/path/to/workspace",
    "repoUrl": "https://github.com/org/repo",
    "repoRef": "main",
    "isPrimary": true
  }
}
```

`workspace` is optional. If present, the project is seeded with that workspace. A workspace requires at least one of `cwd` or `repoUrl`.

Projects and departments can set `agentCompletionPolicyDefault` to `review_required`, `agent_can_complete`, or `null`. `null` inherits the company default. They can also set `humanQuestionSlaHours` from 1 to 720, or `null` to inherit the company's work-question SLA. Agents cannot change these scope policies; board operators need task-assignment authority.

The completion policy is resolved and snapshotted when a task is created. Project or department defaults override the company default, but the company review guardrail can still force review. See [Tasks](issues.md).

### Update Project

```
PATCH /api/projects/{projectId}
{
  "status": "in_progress",
  "name": "Updated Name"
}
```

### Delete Project

```
DELETE /api/projects/{projectId}
```

Deletes the project. Returns `409` if the project has active tasks or goals that must be reassigned first. Returns the deleted project object.

---

## Project Workspaces

Workspaces link a project to a repository and working directory. Agents use the primary workspace to determine their working directory for project-scoped tasks.

```
GET /api/projects/{projectId}/workspaces
POST /api/projects/{projectId}/workspaces
PATCH /api/projects/{projectId}/workspaces/{workspaceId}
DELETE /api/projects/{projectId}/workspaces/{workspaceId}
```

Create payload:

```json
{
  "name": "auth-repo",
  "cwd": "/path/to/workspace",
  "repoUrl": "https://github.com/org/repo",
  "repoRef": "main",
  "isPrimary": true
}
```

---

## Project Agent Assignment

Manage which agents are assigned to a project.

### List Assigned Agents

```
GET /api/projects/{projectId}/agents
```

Returns each assigned agent with `agentId`, `name`, `role`, `title`, `icon`, `status`, and `createdAt` (assignment date).

### Assign Agent

```
POST /api/projects/{projectId}/agents
{ "agentId": "{agentId}" }
```

Idempotent — assigning an already-assigned agent is a no-op. Returns `201 { ok: true }`.

### Unassign Agent

```
DELETE /api/projects/{projectId}/agents/{agentId}
```

Returns `404` if the agent was not assigned. Returns `{ ok: true }` on success.

---

## Project Environment

Environment variables scoped to the project. Passed to agent runs in the project context.

### Get Environment

```
GET /api/projects/{projectId}/environment
```

Returns `{ env: { KEY: "value", ... } }` or `{ env: null }`.

### Update Environment

```
PATCH /api/projects/{projectId}/environment
{ "env": { "NODE_ENV": "production", "API_URL": "https://..." } }
```

Pass `{ "env": null }` to clear all environment variables. Returns `{ env: { ... } }`.

Company-scoped execution environments are separate from this legacy project environment map. See `docs/api/environments.md` for `/api/companies/{companyId}/environments`.

---

## Project Git

```
GET /api/companies/{companyId}/projects/{projectId}/git/graph
GET /api/companies/{companyId}/projects/{projectId}/git/enrich
```

These routes power project git graph visualizations and enrichment.

---

## Project Budget

```
GET /api/projects/{projectId}/budget
```

Returns cost totals for the project for the current billing month: total spend, per-agent breakdown, and the project's budget limit if set.
