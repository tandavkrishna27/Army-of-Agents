// server/src/services/internal-agent/tools/thread-find-similar.ts
//
// Task C2 batch 1 — `find_similar_threads` (query tool, HNSW).
//
// Embeds the query text synchronously via the embedding service's
// `embedSync` (added in C2 to the existing embedding service), then runs a
// pgvector cosine-distance (`<=>`) ORDER BY against `discussions.summary_embedding`.
//
// Graceful fallbacks:
//   - If the embedding service isn't wired into the ServiceContainer (e.g.
//     tests, pre-worker startup): return `EMBEDDINGS_UNAVAILABLE`.
//   - If pgvector isn't available (embedded-postgres): the column-NULL
//     filter ensures no rows are returned without crashing.
//
// Task 1.1 (Inbound Dirty-Data Routing) — `findSimilarThreadsScored`
//
// A reusable service-layer function (not gated behind an AgentTool ctx) that
// also SELECTs the raw cosine distance so the inbound router can:
//   - threshold on top-1 distance (confidence gate)
//   - compute the top-1-vs-top-2 ambiguity gap (Codex #10)
//
// Embedding access for a plain service (no AgentTool ctx):
//   The caller passes `embedText` as a plain async function. In the router this
//   will be `ctx.services.embeddings?.embedSync.bind(ctx.services.embeddings)`,
//   or `undefined` when the service is absent. When it is undefined / throws,
//   `findSimilarThreadsScored` returns `{ available: false, results: [] }` —
//   the fail-closed signal (Decision D2) that tells the router to hand off to
//   human review rather than guess.

import { sql, and, eq } from "drizzle-orm";
import { discussions } from "@armyofagents/db";
import type { Db } from "@armyofagents/db";
import type { AgentTool } from "../types.js";

// ─── findSimilarThreadsScored ─────────────────────────────────────────────────

export interface ScoredThreadResult {
  threadId: string;
  distance: number;
}

export interface FindSimilarThreadsScoredResult {
  available: boolean;
  results: ScoredThreadResult[];
}

/**
 * Embed `text` and run a pgvector cosine-distance query against
 * `discussions.summary_embedding`, returning `{ threadId, distance }` rows
 * ordered by distance ASC (closest first).
 *
 * @param args.db           - Drizzle DB handle.
 * @param args.embedText    - Async function that converts a string to a
 *                            1536-dim number[]. Mirrors `EmbeddingService.embedSync`.
 *                            Pass `undefined` (or omit) to signal that the
 *                            embedding service is absent; the function will
 *                            return `{ available: false, results: [] }`.
 * @param args.companyId    - Scope the search to this company.
 * @param args.text         - Raw text to embed and search for.
 * @param args.limit        - Max rows to return (default 5, hard-capped at 25).
 */
export async function findSimilarThreadsScored(args: {
  db: Db;
  embedText?: ((text: string) => Promise<number[]>) | null;
  companyId: string;
  text: string;
  limit?: number;
}): Promise<FindSimilarThreadsScoredResult> {
  const { db, embedText, companyId, text, limit } = args;

  // Fail-closed: embedding service unavailable.
  if (typeof embedText !== "function") {
    return { available: false, results: [] };
  }

  let vector: number[];
  try {
    vector = await embedText(text.trim());
  } catch {
    // Embedding fn threw (network error, missing key, etc.) — fail-closed.
    return { available: false, results: [] };
  }

  const cappedLimit = Math.min(
    typeof limit === "number" && limit > 0 ? limit : DEFAULT_LIMIT,
    MAX_LIMIT,
  );

  const vectorLiteral = `[${vector.join(",")}]`;

  // SELECT id AS threadId, summary_embedding <=> <vector> AS distance
  // ORDER BY distance ASC LIMIT n
  const rows = await db
    .select({
      threadId: discussions.id,
      distance: sql<number>`${discussions.summaryEmbedding} <=> ${vectorLiteral}::vector`,
    })
    .from(discussions)
    .where(
      and(
        eq(discussions.companyId, companyId),
        sql`${discussions.summaryEmbedding} IS NOT NULL`,
      ),
    )
    .orderBy(sql`${discussions.summaryEmbedding} <=> ${vectorLiteral}::vector`)
    .limit(cappedLimit);

  const results: ScoredThreadResult[] = (Array.isArray(rows) ? rows : []).map(
    (r) => ({ threadId: r.threadId, distance: Number(r.distance) }),
  );

  return { available: true, results };
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;

export const findSimilarThreadsTool: AgentTool = {
  name: "find_similar_threads",
  description:
    "Find threads similar to a text query via embedding cosine similarity (HNSW).",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Query text to find semantically similar threads",
      },
      limit: {
        type: "number",
        description: `Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
      },
    },
    required: ["text"],
  },
  category: "query",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx) {
    const { text, limit } = (params ?? {}) as {
      text?: string;
      limit?: number;
    };
    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return {
        success: false,
        data: null,
        summary: "text is required",
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
          "Embedding service unavailable — find_similar_threads requires a configured embedding service",
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

    // pgvector cosine distance via the `<=>` operator. ORDER BY ASC because
    // distance is small-is-similar; LIMIT pulls from the HNSW index when
    // pgvector is available. The summary_embedding IS NOT NULL guard keeps
    // un-embedded rows out of the result set.
    const vectorLiteral = `[${vector.join(",")}]`;
    const rows = await ctx.db
      .select({
        id: discussions.id,
        title: discussions.title,
        summaryText: discussions.summaryText,
        visibility: discussions.visibility,
        phase: discussions.phase,
      })
      .from(discussions)
      .where(
        and(
          eq(discussions.companyId, ctx.companyId),
          sql`${discussions.summaryEmbedding} IS NOT NULL`,
        ),
      )
      .orderBy(sql`${discussions.summaryEmbedding} <=> ${vectorLiteral}::vector`)
      .limit(cappedLimit);
    const list = Array.isArray(rows) ? rows : [];
    return {
      success: true,
      data: list,
      summary: `Found ${list.length} similar thread(s)`,
    };
  },
};
