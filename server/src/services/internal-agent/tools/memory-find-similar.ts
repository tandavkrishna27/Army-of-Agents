// server/src/services/internal-agent/tools/memory-find-similar.ts
//
// Task C2 batch 3 — `find_similar_memory_hnsw` (memory tool, Memory Keeper).
//
// Direct pgvector HNSW cosine search over `memory_items.embedding`, mirroring
// the `find_similar_threads` pattern (server/src/services/internal-agent/tools/
// thread-find-similar.ts). Distinct from the existing `find_similar_memory`
// tool (memory-tools.ts) which goes through `memoryService.searchSemantic` —
// this tool bypasses the service layer to give the agent a deterministic,
// rank-only result set without the service's score-blending logic.
//
// Graceful fallbacks:
//   - If the embedding service isn't wired (tests, pre-worker startup):
//     return EMBEDDINGS_UNAVAILABLE.
//   - If pgvector isn't available (embedded-postgres bundles): the
//     embedding-IS-NOT-NULL guard keeps un-embedded rows out of the result
//     so the ORDER BY can't crash.

import { sql, eq, and, or, isNull, gt } from "drizzle-orm";
import { memoryItems } from "@armyofagents/db";
import type { AgentTool } from "../types.js";
import { actorForAgentRun, memoryAccessConditions } from "../../memory-access-sql.js";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;

const VALID_LAYERS = new Set(["identity", "domain", "active_context", "working"]);

export const findSimilarMemoryHnswTool: AgentTool = {
  name: "find_similar_memory_hnsw",
  description:
    "Find existing memory items semantically similar to a query via direct HNSW cosine search.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Query text" },
      layer: {
        type: "string",
        description:
          "Optional filter: identity|domain|active_context|working",
      },
      limit: {
        type: "number",
        description: `Max results (default ${DEFAULT_LIMIT}, hard-capped at ${MAX_LIMIT})`,
      },
    },
    required: ["text"],
  },
  category: "memory",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx) {
    const { text, layer, limit } = (params ?? {}) as {
      text?: string;
      layer?: string;
      limit?: number;
    };
    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return {
        success: false,
        data: [],
        summary: "text is required",
        error: "INVALID_PARAMS",
      };
    }
    if (layer !== undefined && !VALID_LAYERS.has(layer)) {
      return {
        success: false,
        data: [],
        summary: `Invalid layer "${layer}" — must be one of identity|domain|active_context|working`,
        error: "INVALID_PARAMS",
      };
    }
    const cappedLimit = Math.min(
      typeof limit === "number" && limit > 0 ? limit : DEFAULT_LIMIT,
      MAX_LIMIT,
    );

    const embedSync = ctx.services?.embeddings?.embedSync;
    if (typeof embedSync !== "function") {
      return {
        success: false,
        data: [],
        summary:
          "Embedding service unavailable — find_similar_memory_hnsw requires a configured embedding service",
        error: "EMBEDDINGS_UNAVAILABLE",
      };
    }

    let vector: number[];
    try {
      vector = await embedSync(text, ctx.companyId);
    } catch (err: any) {
      return {
        success: false,
        data: [],
        summary: `Embedding failed: ${err?.message ?? "unknown error"}`,
        error: "EMBEDDING_FAILED",
      };
    }

    const conditions = [
      eq(memoryItems.companyId, ctx.companyId),
      sql`${memoryItems.embedding} IS NOT NULL`,
      // Governance gate (P1, Codex): only approved, non-expired memory may be
      // retrieved. Agent/MCP suggestions are stored 'pending' and are now
      // indexed for RAG on write, so WITHOUT this filter find_similar_memory_hnsw
      // would surface unapproved pending memory and bypass the founder-approval
      // gate (Critical Rule #6). Mirrors the memoryService retrieval filters.
      eq(memoryItems.status, "approved"),
      or(isNull(memoryItems.expiresAt), gt(memoryItems.expiresAt, sql`now()`))!,
    ];
    if (layer) {
      conditions.push(eq(memoryItems.layer, layer));
    }
    // RBAC gate (U2a): this tool's projection (id/title/content/layer/status/
    // category) doesn't satisfy AccessibleMemoryRow (no visibility/agentId), so
    // filterMemoryForActor can't run here. Gate IN-SQL only, agent actor only —
    // board/Commander stays unfiltered (byte-unchanged behavior).
    if (ctx.actorType === "agent" && ctx.agentId) {
      const actor = await actorForAgentRun(ctx.db, ctx.companyId, ctx.agentId);
      conditions.push(...memoryAccessConditions(ctx.db, actor));
    }

    const vectorLiteral = `[${vector.join(",")}]`;
    const rows = await ctx.db
      .select({
        id: memoryItems.id,
        title: memoryItems.title,
        content: memoryItems.content,
        layer: memoryItems.layer,
        status: memoryItems.status,
        category: memoryItems.category,
      })
      .from(memoryItems)
      .where(and(...conditions))
      .orderBy(sql`${memoryItems.embedding} <=> ${vectorLiteral}::vector`)
      .limit(cappedLimit);

    const list = Array.isArray(rows) ? rows : [];
    return {
      success: true,
      data: list,
      summary: `Found ${list.length} similar memory item${list.length === 1 ? "" : "s"}`,
    };
  },
};
