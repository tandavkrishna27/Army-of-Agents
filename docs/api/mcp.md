---
title: MCP Server
summary: AoA's generated MCP tool registry and four resources, RBAC-scoped
---

AoA exposes a JSON-RPC 2.0 MCP endpoint at `/companies/:companyId/mcp`. Agents, Commander, the board UI, and external MCP clients can call it to read and write company data.

## Authentication

Three actor types are accepted:

| Actor | How it authenticates |
|-------|---------------------|
| `mcp` | `Authorization: Bearer <mcp_api_key>` matching an `mcp_api_keys` row |
| `board` | Valid board session cookie (or synthetic `local-board` actor in `local_trusted` mode) |
| `agent` | Agent run JWT or agent API key context during a heartbeat run |

Requests with neither → `401` in authenticated deployments. In `local_trusted` mode, no-token loopback requests are treated as trusted board context, and requests carrying a valid run id may be treated as the running agent.

## Tool Call Format

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "list-tasks",
    "arguments": { "status": "in_progress" }
  }
}
```

## Read Tools

| Tool | Description |
|------|-------------|
| `me` | Return the authenticated caller's identity and role |
| `list-agents` | List agents in the company, RBAC-scoped. Filter: `status` |
| `get-agent` | Get a single agent by id. Required: `agentId` |
| `list-projects` | List departments + projects. Filter: `type` (`department` \| `project`) |
| `get-project` | Get a single project by id. Required: `projectId` |
| `list-tasks` | List tasks with RBAC scoping. Filters: `status`, `projectId`, `assigneeAgentId`, `assigneeUserId`, `responsibleUserId`, `touchedByUserId`, `unreadForUserId`, `labelId`, `q`. Results include task ownership fields including `assigneeAgentId`, `assigneeUserId`, `responsibleUserId`, and `reviewerUserId`. |
| `get-heartbeat-context` | Compact `{ task, recentComments }` payload for a task (last 10 comments). Required: `taskId` |
| `list-task-comments` | List comments on a task. Required: `taskId` |
| `get-task-comment` | Get a single comment by id. Required: `commentId` |
| `memory.search` | Multi-pathway retrieval (semantic + keyword + temporal). RRF + trust ranking, RBAC-scoped. Required: `query`. Optional: `layer`, `category`, `departmentId`, `projectId`, `limit` (1–50) |
| `memory.get` | Fetch a single approved memory item. Returns `404` outside RBAC scope. Required: `id` |

## Write Tools

| Tool | Description |
|------|-------------|
| `debrief-push` | Push unstructured content into the Discussion pipeline for LLM extraction. Required: `content`. Optional: `title`, `departmentId`, `projectId`, `source` |
| `suggest-memory` | Create a pending memory suggestion (awaits founder approval). Required: `title`, `content`, `category`. Optional: `layer`, `tags`, `departmentId`, `projectId`, `goalId`, `taskId` |
| `memory.write` | Create a structured memory item and enqueue it for RAG embedding. Always `status='pending'` — the founder must approve before it enters the Knowledge Base (Critical Rule #6). Use for structured knowledge; use `debrief-push` for unstructured content needing extraction first. Required: `title`, `content`, `category`, `layer`, `sourceContext`. Optional: `tags`, `departmentId`, `projectId`, `goalId`, `taskId` |
| `memory.retain` | Persist an observation to memory. When called by an agent with `scopeToSelf: true`, auto-approved into agent's personal scope. All other writes create a pending item (Critical Rule #6). Required: `title`, `content`, `category`, `layer`, `sourceContext`. Optional: `tags`, `departmentId`, `projectId`, `goalId`, `taskId`, `scopeToSelf` |
| `update-task-status` | Update a task's status with permission checks. Required: `taskId`, `status` |
| `create-task` | Create a task directly (RBAC-scoped). Does not route through Discussion. Required: `title`. Optional: `description`, `projectId`, `goalId`, `parentId`, `status`, `priority`, `assigneeAgentId`, `assigneeUserId`, `responsibleUserId` (`string` or `null`), `labelIds` |
| `update-task` | Update task fields. Required: `taskId`. Optional: `title`, `description`, `projectId`, `goalId`, `status`, `priority`, `assigneeAgentId`, `assigneeUserId`, `responsibleUserId` (`string` or `null`; `null` clears), `labelIds` |
| `add-task-comment` | Add a comment to a task. Required: `taskId`, `body` |
| `attach-artifact-version` | Add an immutable version to an artifact. Available to board and MCP actors with same-company, project-scope, and artifact-update permission. Required: `artifactId`, `sourceDetail`. Optional: `changelog`, `parentVersionId`, `content`, `fileUrl` |

## Protocol Workflow Tools

| Tool | Description |
|------|-------------|
| `use_skill` | Load and apply a named Commander skill. Available only to `board` and `commander` actors. |
| `ask_human` | Ask the responsible human, assigned reviewer, or founder fallback a durable work question during an active heartbeat task run. Supports free text or unique-value options. On timeout the run is parked and returns `{answered:false, status:"parked"}`; stop gracefully instead of retrying. |
| `ask_founder` | Compatibility alias for the agent-only work-question flow. Prefer `ask_human` for new callers. |

## Document Tools

| Tool | Description |
|------|-------------|
| `upsert-task-document` | Create or update the task's document artifact. Appends a new immutable version if document exists; creates artifact + links if not. Required: `taskId`, `body`. Optional: `title`, `changeSummary`, `baseRevisionId` |
| `list-task-documents` | List document artifacts on a task (0 or 1 — AoA has 1:1 task↔artifact). Required: `taskId` |
| `get-task-document` | Return the task's document with its latest version content. Required: `taskId` |
| `list-task-document-revisions` | List all immutable revisions of the task document, ordered by version ascending. Required: `taskId` |
| `restore-task-document-revision` | Create a new version copying content from an older revision. Does not mutate the original (Decisions #43, #45). Required: `taskId`, `revisionId` |

## Approval Tools

| Tool | Description |
|------|-------------|
| `list-approvals` | List approvals, RBAC-scoped. Filters: `status`, `type` |
| `get-approval` | Get an approval by id. Required: `approvalId` |
| `get-approval-tasks` | List tasks linked to an approval. Required: `approvalId` |
| `list-approval-comments` | List comments on an approval. Required: `approvalId` |
| `list-task-approvals` | List approvals linked to a task. Required: `taskId` |
| `create-approval` | Create an approval request. Founders + team leads only. Required: `type`, `payload`. Optional: `requestedByAgentId`, `issueIds` |
| `approval-decision` | Approve, reject, request revision, or resubmit. Founders + team leads only. Required: `approvalId`, `action` (`approve` \| `reject` \| `requestRevision` \| `resubmit`). Optional: `decisionNote`, `payloadJson` |
| `add-approval-comment` | Add a comment to an approval (any role). Required: `approvalId`, `body` |
| `link-task-approval` | Link an approval to a task. Founders + team leads only. Required: `taskId`, `approvalId` |
| `unlink-task-approval` | Unlink an approval from a task. Founders + team leads only. Required: `taskId`, `approvalId` |

## Resources

MCP resources are read via `resources/list` and `resources/read`. They are separate from tools and are not counted in the tool total.

| URI | Description |
|-----|-------------|
| `aoa://tasks` | List all tasks or read a single task (`aoa://tasks/{id}`) |
| `aoa://goals` | List all goals or read a single goal (`aoa://goals/{id}`) |
| `aoa://memory` | List approved memory items or read one (`aoa://memory/{id}`) |
| `aoa://artifacts` | List artifacts with versions or read one (`aoa://artifacts/{id}`) |

## Actor Gate

Most tools are open to all authenticated protocol actors unless listed in the server's `toolAllowedActors` map. Actor gates are enforced before the tool handler runs; handlers still perform company, scope, and RBAC checks.

| Tool | Allowed actors |
|------|---------------|
| `memory.search` | All actors (`board`, `agent`, `commander`, `mcp`) |
| `memory.get` | All actors |
| `memory.retain` | All actors — but agent + `scopeToSelf: true` auto-approves; all others create pending items |
| `memory.write` | All actors — always creates pending memory, never auto-approves |
| `attach-artifact-version` | `board`, `mcp`; handler still enforces company, project-scope, and artifact-update permission |
| `use_skill` | `board`, `commander` |
| `ask_human` | `agent` only; the handler also requires an active heartbeat task run |
| `ask_founder` | `agent` only; compatibility alias with the same active-run requirement |

## Key Behaviors

- **`debrief-push` vs `create-task`:** Use `debrief-push` for unstructured content that needs extraction into tasks + memory. Use `create-task` when the task title/fields are already known. Revised Decision #14 allows authenticated direct task writes because RBAC is the quality gate; anonymous MCP traffic is rejected outside `local_trusted`.
- **Task ownership fields:** `assigneeAgentId` and `assigneeUserId` identify the executor doing the work. `responsibleUserId` identifies the accountable human for outcome and escalation; it does not dispatch execution or change the single-assignee checkout model. `reviewerUserId` identifies the human expected to review output when review is needed.
- **Task assignment permission:** Explicitly setting `responsibleUserId` or clearing it with `responsibleUserId: null` in `create-task` or `update-task` requires `tasks:assign`. Omitting `responsibleUserId` does not require that permission.
- **Memory write gate:** Agents cannot write memory directly to approved status except into their own personal scope via `memory.retain` + `scopeToSelf: true`. All other memory writes land in `pending` status awaiting founder review (Critical Rule #6).
- **Artifact immutability:** `attach-artifact-version` and `upsert-task-document` always create new versions. Existing versions are never modified (Decisions #43, #45).
- **RBAC enforcement:** All tools enforce company isolation. `team_member` actors see only their project-scoped data. Cross-company access returns `404`.

The runtime registry in `server/src/mcp/tools/index.ts` is authoritative. Avoid
copying its total into prose: the catalog changes as tools are generated and
registered.
