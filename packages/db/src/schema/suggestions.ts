import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { memoryItems } from "./memory_items.js";

export const suggestions = pgTable(
  "suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    actionType: text("action_type").notNull(),
    actionPayload: jsonb("action_payload").$type<Record<string, unknown>>(),
    title: text("title").notNull(),
    evidence: text("evidence"),
    status: text("status").notNull().default("pending"),
    // Stable per-finding identity (`${category}:${patternId}`) used to dedupe
    // concurrent detector runs at the DB layer. Nullable: legacy rows and any
    // detector output that cannot compute a stable key participate only via the
    // in-memory pre-filter, never the partial unique index below.
    dedupeKey: text("dedupe_key"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    relatedMemoryItemId: uuid("related_memory_item_id").references(() => memoryItems.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("suggestions_company_idx").on(table.companyId),
    companyStatusIdx: index("suggestions_company_status_idx").on(table.companyId, table.status),
    companyCategoryIdx: index("suggestions_company_category_idx").on(table.companyId, table.category),
    // Partial unique index: hard cross-process dedup of *pending* suggestions.
    // Only fires while a row is pending AND dedupe_key is not NULL, so a
    // dismissed/accepted/expired row may legitimately share a dedupe_key with
    // the next pending suggestion. NULL dedupe_key rows are excluded entirely.
    // Precedent: agent_wakeup_requests_dedup_key_queued_uq.
    pendingDedupeUq: uniqueIndex("suggestions_pending_dedupe_idx")
      .on(table.companyId, table.dedupeKey)
      .where(sql`status = 'pending' AND dedupe_key IS NOT NULL`),
  }),
);
