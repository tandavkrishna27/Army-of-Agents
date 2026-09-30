// server/src/services/internal-agent/tools/memory-archive-stale.ts
//
// Task C2 batch 3 — `archive_stale_memory` (memory tool, Memory Keeper).
//
// Memory hygiene: mark approved memory_items as 'archived' when their
// `accessedAt` is older than the threshold (default 90 days). Founder
// approval is required at the tool layer (requiresConfirmation=true) so the
// Memory Keeper never silently sweeps away items.
//
// Schema notes:
//   - The actual column is `accessedAt`, not `touchAccessedAt` (which is the
//     service-layer mutator name). See packages/db/src/schema/memory_items.ts.
//   - `MEMORY_ITEM_STATUSES` is `draft|pending|approved|archived|rejected` —
//     there is no `archive_pending` status. We move straight to 'archived'.
//     A future revision could introduce a soft-archival workflow.

import { sql, eq, and, isNotNull, lt } from "drizzle-orm";
import { memoryItems } from "@armyofagents/db";
import type { AgentTool } from "../types.js";

const DEFAULT_OLDER_THAN_DAYS = 90;
const VALID_LAYERS = new Set(["identity", "domain", "active_context", "working"]);

export const archiveStaleMemoryTool: AgentTool = {
  name: "archive_stale_memory",
  description:
    "Archive approved memory items whose accessedAt is older than the threshold (default 90 days). " +
    "Founder approval required.",
  parameters: {
    type: "object",
    properties: {
      olderThanDays: {
        type: "number",
        description: `Threshold in days (default ${DEFAULT_OLDER_THAN_DAYS})`,
      },
      layer: {
        type: "string",
        description: "Optional filter: identity|domain|active_context|working",
      },
    },
  },
  category: "memory",
  requiredRole: "team_member",
  requiresConfirmation: true,
  async execute(params, ctx) {
    const { olderThanDays, layer } = (params ?? {}) as {
      olderThanDays?: number;
      layer?: string;
    };

    if (layer !== undefined && !VALID_LAYERS.has(layer)) {
      return {
        success: false,
        data: { archivedCount: 0 },
        summary: `Invalid layer "${layer}" — must be one of identity|domain|active_context|working`,
        error: "INVALID_PARAMS",
      };
    }
    const days =
      typeof olderThanDays === "number" && olderThanDays > 0
        ? olderThanDays
        : DEFAULT_OLDER_THAN_DAYS;
    const cutoff = new Date(Date.now() - days * 86_400_000);

    const conditions = [
      eq(memoryItems.companyId, ctx.companyId),
      eq(memoryItems.status, "approved"),
      // Only sweep items that have been accessed at least once — never-touched
      // items get a pass (could be freshly approved and not yet retrieved).
      isNotNull(memoryItems.accessedAt),
      lt(memoryItems.accessedAt, cutoff),
    ];
    if (layer) {
      conditions.push(eq(memoryItems.layer, layer));
    }

    const rows = await ctx.db
      .update(memoryItems)
      .set({ status: "archived", updatedAt: sql`NOW()` })
      .where(and(...conditions))
      .returning({ id: memoryItems.id });

    const archivedCount = Array.isArray(rows) ? rows.length : 0;
    return {
      success: true,
      data: { archivedCount },
      summary: `Marked ${archivedCount} item${archivedCount === 1 ? "" : "s"} as archived`,
    };
  },
};
