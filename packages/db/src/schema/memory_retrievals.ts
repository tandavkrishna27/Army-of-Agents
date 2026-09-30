import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { memoryItems } from "./memory_items.js";
import { internalAgentConversations } from "./internal_agent.js";

/**
 * Per-call audit log for memory retrievals.
 *
 * One row per item returned from a retrieval call. Powers:
 *   - Workspace right-panel MemorySection (shows what an agent saw per run)
 *   - Founder debugging ("why didn't agent X see memory item Y?")
 *   - Cost / usage analytics (which agents query memory most, what they search for)
 *   - Validation signal (shownToAgent → bumps memory_items.validationCount)
 *
 * Cascade behavior:
 *   - companyId: cascade (delete company → all retrievals gone)
 *   - All other FKs: SET NULL (audit log preserved even when source rows deleted)
 *
 * Retention: trim after 90 days (handled by Commander janitor / scheduled job).
 */
export const memoryRetrievals = pgTable(
  "memory_retrievals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    taskId: uuid("task_id").references(() => issues.id, { onDelete: "set null" }),
    /** Commander conversation that triggered this retrieval (null for agent/skill). */
    conversationId: uuid("conversation_id").references(() => internalAgentConversations.id, { onDelete: "set null" }),
    /** Which path triggered this retrieval. See MEMORY_RETRIEVAL_TRIGGERS. */
    triggeredBy: text("triggered_by").notNull(),
    /** The query text (raw or assembled). Nullable for skill_materialize (no query). */
    query: text("query"),
    itemId: uuid("item_id").references(() => memoryItems.id, { onDelete: "set null" }),
    /** Cosine similarity 0-1 for semantic; null for keyword-only or skill-materialize hits. */
    similarityScore: numeric("similarity_score", { precision: 10, scale: 6 }),
    /** Rank within the result set (1-indexed). */
    rank: integer("rank"),
    /** Whether the result reached the agent (true) or was filtered post-search (false). */
    shownToAgent: boolean("shown_to_agent").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runIdx: index("memory_retrievals_run_idx").on(table.runId),
    companyCreatedIdx: index("memory_retrievals_company_created_idx").on(table.companyId, table.createdAt),
    agentCreatedIdx: index("memory_retrievals_agent_created_idx").on(table.agentId, table.createdAt),
    itemCreatedIdx: index("memory_retrievals_item_created_idx").on(table.itemId, table.createdAt),
    conversationCreatedIdx: index("memory_retrievals_conversation_created_idx").on(table.conversationId, table.createdAt),
  }),
);
