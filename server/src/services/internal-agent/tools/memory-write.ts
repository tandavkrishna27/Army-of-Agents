// server/src/services/internal-agent/tools/memory-write.ts
//
// Task 9 W3 — `write_memory` crew tool.
//
// Creates a memory item via the shared `writeMemoryAndIndex` service so the
// item is immediately enqueued for RAG embedding (deduped, best-effort,
// non-fatal). The tool enforces Critical Rule #6 and Decisions #15/#52:
//
//   - Agent-sourced memory is ALWAYS created with status='pending'. The
//     founder (or, for active_context, team_lead of the department) must
//     approve it before it enters the company's Knowledge Base.
//   - `write_memory` does NOT accept a `status` param that could let the
//     caller self-approve — the status is hard-coded to 'pending'.
//   - To auto-approve into a personal working-memory bucket a crew agent
//     should use the MCP `memory.retain` tool (scopeToSelf=true + layer=working).
//
// Category: "memory". Required role: "team_member" (same as propose_memory_from_thread).
// No confirmation gate — crew tools execute in the agent loop which already
// has the task context.

import { and, eq, isNull } from "drizzle-orm";
import { projects, goals, memoryFolders } from "@armyofagents/db";
import { normalizeMemoryFolderPath } from "@armyofagents/shared";
import type { AgentTool } from "../types.js";
import { writeMemoryAndIndex } from "../../memory-write.js";

const VALID_LAYERS = new Set(["identity", "domain", "active_context", "working"]);
const VALID_CATEGORIES = new Set([
  "decision",
  "insight",
  "context",
  "reference",
  "preference",
]);

export const writeMemoryTool: AgentTool = {
  name: "write_memory",
  description:
    "Create a memory item (status='pending', founder approves per Critical Rule #6) and " +
    "enqueue it for RAG indexing. Use for capturing important knowledge discovered during " +
    "task execution that should be reviewed and promoted to company memory. " +
    "layer='domain' requires a departmentId; layer='identity' must not have one. " +
    "For temporary working notes scoped only to this agent, prefer the MCP memory.retain " +
    "tool with scopeToSelf=true and layer=working.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short, descriptive title for the memory item (required)",
      },
      content: {
        type: "string",
        description: "Full content of the memory item (required)",
      },
      layer: {
        type: "string",
        description:
          "Memory layer: identity|domain|active_context|working. The layer fixes the scope: " +
          "'identity' is company-wide and must NOT have a departmentId; 'domain' is " +
          "department-scoped and REQUIRES one. Both are enforced — a mismatched pair is " +
          "rejected, not silently accepted.",
      },
      category: {
        type: "string",
        description:
          "Optional category: decision|insight|context|reference|preference (default 'context')",
      },
      departmentId: {
        type: "string",
        description:
          "Department (project) id scoping the memory item. REQUIRED when layer='domain'; " +
          "must be omitted when layer='identity'. Optional for active_context/working.",
      },
      goalId: {
        type: "string",
        description: "Optional goal id to scope the memory item",
      },
      folderPath: {
        type: "string",
        description:
          "Optional folder in the company's memory tree to file this item under, e.g. " +
          "'Company/Decisions' or 'engineering/Architecture'. Must be an EXISTING folder " +
          "belonging to the same scope as this item: a company-wide item (no departmentId) " +
          "may only use a company folder, and a department item may only use a folder under " +
          "that department. Omit to leave the item unfiled at the root.",
      },
      sourceContext: {
        type: "string",
        description:
          "Optional short note on why/where this was learned (e.g. the task or " +
          "decision it came from). Required by the memory service for " +
          "agent-sourced items; a default is derived from the agent context " +
          "when omitted.",
      },
    },
    required: ["title", "content", "layer"],
  },
  category: "memory",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx) {
    const { title, content, layer, category, departmentId, goalId, folderPath, sourceContext } =
      (params ?? {}) as {
        title?: string;
        content?: string;
        layer?: string;
        category?: string;
        departmentId?: string;
        goalId?: string;
        folderPath?: string;
        sourceContext?: string;
      };

    // --- Validation ---
    if (!title || typeof title !== "string" || title.trim().length === 0) {
      return {
        success: false,
        data: null,
        summary: "title is required",
        error: "INVALID_PARAMS",
      };
    }
    if (!content || typeof content !== "string" || content.trim().length === 0) {
      return {
        success: false,
        data: null,
        summary: "content is required",
        error: "INVALID_PARAMS",
      };
    }
    if (!layer || !VALID_LAYERS.has(layer)) {
      return {
        success: false,
        data: null,
        summary: `layer is required and must be one of identity|domain|active_context|working`,
        error: "INVALID_PARAMS",
      };
    }

    const resolvedCategory =
      category && VALID_CATEGORIES.has(category) ? category : "context";

    // Normalize first: a whitespace-only folderPath means UNFILED, and the
    // scope guard below must judge the effective value, not the raw string.
    const normalizedFolderPath =
      typeof folderPath === "string" && folderPath.trim().length > 0
        ? normalizeMemoryFolderPath(folderPath)
        : "";

    // Layer/scope invariant. The prompt tells the Librarian which layer goes
    // with which scope, but a prompt is not an integrity boundary — a confused
    // or adversarial agent can send any combination, and the wrong one puts
    // department knowledge into company-wide memory (or vice versa).
    //
    // identity is company-wide BY DEFINITION (vision, values, brand), so a
    // departmentId on it is always a contradiction — rejected outright.
    if (layer === "identity" && departmentId) {
      return {
        success: false,
        data: null,
        summary:
          "identity-layer memory is company-wide and cannot carry a departmentId — " +
          'use layer="domain" for department knowledge',
        error: "INVALID_PARAMS",
      };
    }
    // domain is department-scoped by definition (Decision #40). An unscoped
    // domain item isn't merely untidy: it can't be retrieved by any department
    // context, and its folder lookup falls through to the COMPANY folder set,
    // quietly filing department knowledge company-wide. Reject it loudly —
    // an actionable error beats a memory item that silently belongs nowhere.
    if (layer === "domain" && !departmentId) {
      return {
        success: false,
        data: null,
        summary:
          "domain-layer memory is department-scoped and requires a departmentId — " +
          'use layer="identity" for company-wide knowledge',
        error: "INVALID_PARAMS",
      };
    }

    // Tenant isolation (P2, Codex): a scoped/compromised agent must not be able
    // to link a memory row to another company's project/goal by passing a known
    // UUID. Verify any provided departmentId/goalId belongs to ctx.companyId
    // before insert (the MCP memory.write path does the equivalent via scope
    // assertions; the crew tool has no ctx.scope, so check ownership directly).
    if (departmentId) {
      const [proj] = await ctx.db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, departmentId), eq(projects.companyId, ctx.companyId)))
        .limit(1);
      if (!proj) {
        return {
          success: false,
          data: null,
          summary: "departmentId not found in this company",
          error: "INVALID_PARAMS",
        };
      }
    }
    if (goalId) {
      const [goal] = await ctx.db
        .select({ id: goals.id })
        .from(goals)
        .where(and(eq(goals.id, goalId), eq(goals.companyId, ctx.companyId)))
        .limit(1);
      if (!goal) {
        return {
          success: false,
          data: null,
          summary: "goalId not found in this company",
          error: "INVALID_PARAMS",
        };
      }
    }

    // Folder placement (Item 5 / Phase 5b). The Librarian files braindump
    // output into the SEEDED memory tree rather than dumping everything at the
    // root, so it needs to name a folder. Two rules, both enforced here:
    //
    //   1. The folder must already EXIST (memory_folders row). The tool never
    //      creates folders — an agent inventing "Company/Secrets" would produce
    //      an item nobody can find in the tree UI, since the tree renders from
    //      memory_folders, not from distinct item paths.
    //   2. The folder must belong to the SAME scope as the item. memory_folders
    //      rows carry departmentId (null for company-level folders), so we match
    //      it against the item's departmentId. Without this, a department write
    //      could file itself under "Company/..." — visible company-wide, which
    //      is exactly the layer/scope boundary the memory model exists to keep.
    //
    // Omitted/empty => "" (unfiled root), which is the column default.
    if (normalizedFolderPath) {
      const [folder] = await ctx.db
        .select({ id: memoryFolders.id })
        .from(memoryFolders)
        .where(
          and(
            eq(memoryFolders.companyId, ctx.companyId),
            eq(memoryFolders.path, normalizedFolderPath),
            departmentId
              ? eq(memoryFolders.departmentId, departmentId)
              : isNull(memoryFolders.departmentId),
          ),
        )
        .limit(1);
      if (!folder) {
        return {
          success: false,
          data: null,
          summary:
            `folderPath "${normalizedFolderPath}" is not an existing folder for this ` +
            `${departmentId ? "department" : "company-wide"} scope — pick one of the folders ` +
            `listed in your task context, or omit folderPath to file at the root`,
          error: "INVALID_PARAMS",
        };
      }
    }

    // memoryService.create rejects agent-sourced memory without a non-empty
    // sourceContext (memory.ts). Use the caller's note when provided, else
    // derive a default from the agent context so a bare write_memory call still
    // succeeds instead of failing with INSERT_FAILED (P2, Codex).
    const resolvedSourceContext =
      sourceContext && sourceContext.trim().length > 0
        ? sourceContext.trim()
        : `Captured by ${ctx.agentId ?? "crew agent"} during task execution`;

    // --- Write + index ---
    // Critical Rule #6 + Decisions #15/#52: agent-sourced memory is always pending.
    // The status is hard-coded here and CANNOT be overridden by the caller.
    let row: Awaited<ReturnType<typeof writeMemoryAndIndex>> | null = null;
    try {
      row = await writeMemoryAndIndex(ctx.db, ctx.companyId, {
        title: title.trim(),
        content: content.trim(),
        layer,
        category: resolvedCategory,
        source: "agent",
        sourceContext: resolvedSourceContext,
        status: "pending",
        visibility: "scoped",
        priority: 0,
        createdBy: ctx.agentId ?? ctx.userId ?? "system",
        departmentId: departmentId ?? null,
        goalId: goalId ?? null,
        folderPath: normalizedFolderPath,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: null,
        summary: `Failed to create memory item: ${msg}`,
        error: "INSERT_FAILED",
      };
    }

    if (!row || !row.id) {
      return {
        success: false,
        data: null,
        summary: "Memory write returned no row",
        error: "INSERT_FAILED",
      };
    }

    return {
      success: true,
      data: { memoryItemId: row.id },
      summary:
        `Memory item created (status=pending, layer=${layer}` +
        `${normalizedFolderPath ? `, folder=${normalizedFolderPath}` : ""}) — awaiting founder review`,
    };
  },
};
