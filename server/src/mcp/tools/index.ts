import { APPROVAL_STATUSES, APPROVAL_TYPES, CREATABLE_APPROVAL_TYPES, ISSUE_STATUSES, type McpActorType } from "@armyofagents/shared";
import { readToolHandlers } from "./read-tools.js";
import { writeToolHandlers } from "./write-tools.js";
import { documentToolHandlers } from "./document-tools.js";
import { approvalToolHandlers } from "./approval-tools.js";
import { skillToolHandlers } from "./skill-tools.js";
import { askFounderToolHandlers } from "./ask-founder-tool.js";
import type { ToolHandler } from "./types.js";

export {
  readToolHandlers,
  writeToolHandlers,
  documentToolHandlers,
  approvalToolHandlers,
  skillToolHandlers,
};
export * from "./types.js";
// U10: plugin tool descriptors for the broker's tools/list (plugin dispatch
// for tools/call follows in U10-c).
export * from "./plugin-broker-tools.js";

export const toolHandlers: Record<string, ToolHandler> = {
  ...readToolHandlers,
  ...writeToolHandlers,
  ...documentToolHandlers,
  ...approvalToolHandlers,
  ...skillToolHandlers,
  ...askFounderToolHandlers,
};

/**
 * Per-tool actor-type gate.
 *
 * Tools NOT in this map are open to all actor types (existing
 * behavior). Tools listed here are restricted to the given actor sources.
 *
 * Used by mcp/server.ts at tool-dispatch time. A caller whose
 * ProtocolActor.source is not in the allowed list gets a 403.
 *
 * Convention:
 *   ALL_ACTORS = ["board", "agent", "commander", "mcp"]
 *   Read tools (memory.search, memory.get): ALL_ACTORS — knowledge
 *     should reach any authenticated caller.
 *   Worker-write tools (memory.retain): ALL_ACTORS, but the handler
 *     auto-approves only when the caller is an agent retaining to its
 *     own personal scope.
 *   Privileged write tools (future memory.create, memory.update):
 *     ["board", "commander"] — only founder + commander, never worker
 *     agents. (Reserved for follow-up commits.)
 */
const ALL_ACTORS: McpActorType[] = ["board", "agent", "commander", "mcp"];

export const toolAllowedActors: Record<string, McpActorType[]> = {
  "memory.search": ALL_ACTORS,
  "memory.get": ALL_ACTORS,
  "memory.retain": ALL_ACTORS,
  // memory.write is all-actors: board/mcp/commander/agent may call it.
  // Unlike memory.retain there is NO auto-approve path — every write is pending.
  // (Critical Rule #6: founders approve identity/domain; this tool never bypasses that.)
  "memory.write": ALL_ACTORS,
  "attach-artifact-version": ["board", "mcp"],
  "use_skill": ["board", "commander"],  // HTTP MCP endpoint gate only: founder (board) + commander; worker agents + mcp excluded (skill markdown may contain company IP). Commander's CLI bridge dispatches via tool-registry and does NOT consult this map.
  // Ask Human is for org/heartbeat task-execution agents only. The handler
  // additionally requires an active runId; crew/internal-agent (whose question
  // channel is the in-thread reply) are excluded by this actor gate. board/mcp/
  // commander cannot call it.
  "ask_human": ["agent"],
  "ask_founder": ["agent"],
};

export const TOOL_DEFINITIONS = [
  {
    name: "me",
    description: "Return the authenticated caller's identity and role",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list-agents",
    description: "List agents in the caller's company, scoped by RBAC",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string" } },
    },
  },
  {
    name: "get-agent",
    description: "Get a single agent by id (RBAC scoped)",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string" } },
      required: ["agentId"],
    },
  },
  {
    name: "list-projects",
    description: "List projects (departments + projects) in the caller's company",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["department", "project"] },
      },
    },
  },
  {
    name: "get-project",
    description: "Get a single project by id (RBAC scoped)",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
    },
  },
  {
    name: "list-tasks",
    description:
      "List tasks in the caller's company with RBAC scoping. Supports filters: status, projectId, assigneeAgentId, assigneeUserId, responsibleUserId, touchedByUserId, unreadForUserId, labelId, q",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        projectId: { type: "string" },
        assigneeAgentId: { type: "string" },
        assigneeUserId: { type: "string" },
        responsibleUserId: { type: "string" },
        touchedByUserId: { type: "string" },
        unreadForUserId: { type: "string" },
        labelId: { type: "string" },
        q: { type: "string" },
      },
    },
  },
  {
    name: "get-heartbeat-context",
    description:
      "Return a compact { task, recentComments } payload for a task (last 10 comments)",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "list-task-comments",
    description: "List comments on a task (RBAC scoped)",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "get-task-comment",
    description: "Get a single task comment by id (RBAC scoped via its task)",
    inputSchema: {
      type: "object",
      properties: { commentId: { type: "string" } },
      required: ["commentId"],
    },
  },
  {
    name: "debrief-push",
    description: "Push content into the Debrief pipeline",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        title: { type: "string" },
        departmentId: { type: "string" },
        projectId: { type: "string" },
        source: { type: "object" },
      },
      required: ["content"],
    },
  },
  {
    name: "suggest-memory",
    description: "Create a pending memory suggestion",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        category: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        departmentId: { type: "string" },
        projectId: { type: "string" },
        layer: { type: "string" },
        priority: { type: "number" },
        goalId: { type: "string" },
        taskId: { type: "string" },
      },
      required: ["title", "content", "category"],
    },
  },
  // Worker-facing memory tools: multi-pathway search, scope-checked
  // get, and self-scope-aware retain. See toolAllowedActors above for gating.
  {
    name: "memory.search",
    description:
      "Search company memory using multi-pathway retrieval (semantic + keyword + temporal). Returns top-K items ranked by RRF + trust weighting, scoped to the caller's RBAC visibility.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        layer: { type: "string", enum: ["identity", "domain", "active_context", "working"] },
        category: { type: "string" },
        departmentId: { type: "string" },
        projectId: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 50 },
      },
      required: ["query"],
    },
  },
  {
    name: "memory.get",
    description:
      "Fetch a single approved memory item by id. Returns 404 when the item is outside the caller's RBAC scope.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  // Task 9 W3 — memory.write: unified write+RAG-index (always pending, no auto-approve).
  {
    name: "memory.write",
    description:
      "Create a memory item and immediately enqueue it for RAG embedding. Always creates with " +
      "status='pending' — the founder must approve before the item enters the Knowledge Base " +
      "(Critical Rule #6: agents/MCP cannot self-approve identity or domain memory). " +
      "Use this when you have structured knowledge to persist; use debrief-push for " +
      "unstructured content that needs LLM extraction first.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        category: { type: "string" },
        layer: { type: "string", enum: ["identity", "domain", "active_context", "working"] },
        sourceContext: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        departmentId: { type: "string" },
        projectId: { type: "string" },
        goalId: { type: "string" },
        taskId: { type: "string" },
      },
      required: ["title", "content", "category", "layer", "sourceContext"],
    },
  },
  {
    name: "memory.retain",
    description:
      "Persist an observation to memory. When called by an agent actor with scopeToSelf=true AND layer=\"working\", the item is auto-approved into that agent's personal working-memory bucket. Self-scoped retains targeting identity/domain/active_context — and all non-agent writes — instead create a pending item awaiting founder review (Critical Rule #6: only the founder approves identity/domain).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        category: { type: "string" },
        layer: { type: "string", enum: ["identity", "domain", "active_context", "working"] },
        sourceContext: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        departmentId: { type: "string" },
        projectId: { type: "string" },
        goalId: { type: "string" },
        taskId: { type: "string" },
        scopeToSelf: { type: "boolean" },
      },
      required: ["title", "content", "category", "layer", "sourceContext"],
    },
  },
  {
    name: "update-task-status",
    description: "Update a task status with permission checks",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        status: { type: "string", enum: [...ISSUE_STATUSES] },
      },
      required: ["taskId", "status"],
    },
  },
  {
    name: "create-task",
    description:
      "Create a task directly in the caller's company (RBAC scoped). Does NOT route through Discussion; use debrief-push for unstructured content extraction (Decision #14 revised)",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        projectId: { type: "string" },
        goalId: { type: "string" },
        parentId: { type: "string" },
        status: { type: "string", enum: [...ISSUE_STATUSES] },
        priority: { type: "string" },
        assigneeAgentId: { type: "string" },
        assigneeUserId: { type: "string" },
        responsibleUserId: { type: ["string", "null"] },
        labelIds: { type: "array", items: { type: "string" } },
      },
      required: ["title"],
    },
  },
  {
    name: "update-task",
    description:
      "Update a task's fields (title, description, status, priority, assignee, etc.) with RBAC checks",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        projectId: { type: "string" },
        goalId: { type: "string" },
        status: { type: "string", enum: [...ISSUE_STATUSES] },
        priority: { type: "string" },
        assigneeAgentId: { type: "string" },
        assigneeUserId: { type: "string" },
        responsibleUserId: { type: ["string", "null"] },
        labelIds: { type: "array", items: { type: "string" } },
      },
      required: ["taskId"],
    },
  },
  {
    name: "add-task-comment",
    description: "Add a comment to a task the caller can access",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        body: { type: "string" },
      },
      required: ["taskId", "body"],
    },
  },
  {
    name: "attach-artifact-version",
    description: "Add a new immutable version to an artifact",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string" },
        sourceDetail: { type: "string" },
        changelog: { type: "string" },
        parentVersionId: { type: "string" },
        content: { type: "string" },
        fileUrl: { type: "string" },
        storageKind: { type: "string", description: "inline | asset" },
        assetId: { type: "string", description: "Existing asset id (company-owned) for an asset-backed version" },
        filename: { type: "string" },
        contentType: { type: "string" },
        extension: { type: "string" },
        byteSize: { type: "number" },
        sha256: { type: "string" },
      },
      required: ["artifactId", "sourceDetail"],
    },
  },
  {
    name: "upsert-task-document",
    description:
      "Create or update the task's document (markdown). If the task already has a document artifact, appends a new immutable version; otherwise creates an artifact of type 'document' and links it to the task. Maps Paperclip's upsert-issue-document to AoA's artifact subsystem.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        changeSummary: { type: "string" },
        baseRevisionId: { type: "string" },
      },
      required: ["taskId", "body"],
    },
  },
  {
    name: "list-task-documents",
    description:
      "List document artifacts attached to a task (0 or 1 — AoA has 1:1 task↔artifact)",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "get-task-document",
    description: "Return the task's document artifact with its latest version (content + metadata)",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "list-task-document-revisions",
    description:
      "List all immutable revisions of the task's document artifact, ordered ascending by version number",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "restore-task-document-revision",
    description:
      "Create a NEW document artifact version whose content is copied from the specified older revision. The older revision is never mutated (preserves Decisions #43/#45 — artifact versions are immutable).",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        revisionId: { type: "string" },
      },
      required: ["taskId", "revisionId"],
    },
  },
  {
    name: "list-approvals",
    description:
      "List approvals in the caller's company. Scoped users see only approvals linked to tasks in their projects. Filterable by status and type.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: [...APPROVAL_STATUSES] },
        type: { type: "string", enum: [...APPROVAL_TYPES] },
      },
    },
  },
  {
    name: "get-approval",
    description: "Get an approval by id (RBAC scoped; cross-company 404)",
    inputSchema: {
      type: "object",
      properties: { approvalId: { type: "string" } },
      required: ["approvalId"],
    },
  },
  {
    name: "get-approval-tasks",
    description:
      "List tasks linked to an approval. Scoped users see only tasks in their projects.",
    inputSchema: {
      type: "object",
      properties: { approvalId: { type: "string" } },
      required: ["approvalId"],
    },
  },
  {
    name: "list-approval-comments",
    description: "List comments on an approval (RBAC scoped)",
    inputSchema: {
      type: "object",
      properties: { approvalId: { type: "string" } },
      required: ["approvalId"],
    },
  },
  {
    name: "list-task-approvals",
    description: "List approvals linked to a task (RBAC scoped via the task)",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "create-approval",
    description:
      "Create a new approval request. Founders + team leads only. Team leads must link at least one task from their scope.",
    inputSchema: {
      type: "object",
      properties: {
        // Advertise only externally-creatable types — crew_dispatch is system-internal
        // and rejected by createApprovalSchema at runtime (list/filter still uses the full
        // APPROVAL_TYPES set). Keeps the listTools schema honest for MCP clients.
        type: { type: "string", enum: [...CREATABLE_APPROVAL_TYPES] },
        requestedByAgentId: { type: "string" },
        payload: { type: "object" },
        issueIds: { type: "array", items: { type: "string" } },
      },
      required: ["type", "payload"],
    },
  },
  {
    name: "approval-decision",
    description:
      "Approve, reject, request revision, or resubmit an approval. Founders + team leads only. Team leads limited to approvals with at least one task in their scope.",
    inputSchema: {
      type: "object",
      properties: {
        approvalId: { type: "string" },
        action: {
          type: "string",
          enum: ["approve", "reject", "requestRevision", "resubmit"],
        },
        decisionNote: { type: "string" },
        payloadJson: { type: "string" },
      },
      required: ["approvalId", "action"],
    },
  },
  {
    name: "add-approval-comment",
    description:
      "Add a comment to an approval. Any role may comment on approvals they can see.",
    inputSchema: {
      type: "object",
      properties: {
        approvalId: { type: "string" },
        body: { type: "string" },
      },
      required: ["approvalId", "body"],
    },
  },
  {
    name: "link-task-approval",
    description:
      "Link an existing approval to an existing task. Founders + team leads only.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        approvalId: { type: "string" },
      },
      required: ["taskId", "approvalId"],
    },
  },
  {
    name: "unlink-task-approval",
    description:
      "Unlink an approval from a task. Founders + team leads only.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        approvalId: { type: "string" },
      },
      required: ["taskId", "approvalId"],
    },
  },
  {
    name: "use_skill",
    description:
      "Load the full instructions for an AoA skill by key (e.g. 'skill:aoa/brainstorm'). Returns the skill's markdown so your model can follow it. Call query_skills first if you are unsure of the available skill keys.",
    inputSchema: {
      type: "object",
      properties: {
        "key": {
          type: "string",
          description: "The skill key, e.g. 'skill:aoa/sprint-planning'",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "ask_human",
    description:
      "Ask the responsible human a durable task question and block (up to ~5 min) for the answer. For " +
      "org/heartbeat task-execution agents during an active run only. Surfaces in " +
      "Commander and Inbox as a question the recipient answers (free-text, or one of your " +
      "options). On timeout the run is parked and you get {answered:false, " +
      "status:\"parked\"} — stop gracefully; do not retry.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              value: { type: "string" },
              description: { type: "string" },
              rationale: { type: "string" },
            },
            required: ["label", "value"],
          },
        },
        context: { type: "string" },
      },
      required: ["question"],
    },
  },
  {
    name: "ask_founder",
    description:
      "Compatibility alias for ask_human. Recipient routing follows the task's responsible human, reviewer, then founder fallback.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              value: { type: "string" },
              description: { type: "string" },
              rationale: { type: "string" },
            },
            required: ["label", "value"],
          },
        },
        context: { type: "string" },
      },
      required: ["question"],
    },
  },
];
