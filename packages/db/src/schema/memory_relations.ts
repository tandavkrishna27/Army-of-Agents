import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { memoryItems } from "./memory_items.js";

/**
 * Graph edges between memory items.
 *
 * Kinds:
 *   - supersedes      — newer item replaces older (older is auto-flagged in UI)
 *   - related_to      — soft association (no semantic implication)
 *   - applies_to      — this item applies in the context of the target (e.g.
 *                       a brand-voice rule applies_to a specific department)
 *   - conflicts_with  — items disagree; needs human resolution
 *   - derived_from    — this item was extracted from / inspired by the target
 *
 * Bidirectional relationships (e.g. related_to) are typically stored as a single
 * row; UI renders the link from both ends. Directional relationships (supersedes,
 * derived_from, applies_to) MUST follow the from→to convention documented above.
 *
 * Cascade: deleting either endpoint deletes the edge.
 */
export const memoryRelations = pgTable(
  "memory_relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    fromItemId: uuid("from_item_id").notNull().references(() => memoryItems.id, { onDelete: "cascade" }),
    toItemId: uuid("to_item_id").notNull().references(() => memoryItems.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Prevent duplicate edges of the same kind in the same direction.
    fromToKindUq: uniqueIndex("memory_relations_from_to_kind_uq").on(
      table.fromItemId,
      table.toItemId,
      table.kind,
    ),
    companyFromIdx: index("memory_relations_company_from_idx").on(table.companyId, table.fromItemId),
    companyToIdx: index("memory_relations_company_to_idx").on(table.companyId, table.toItemId),
    companyKindIdx: index("memory_relations_company_kind_idx").on(table.companyId, table.kind),
  }),
);
