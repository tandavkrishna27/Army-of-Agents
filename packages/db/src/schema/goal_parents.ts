import { pgTable, uuid, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import { goals } from "./goals.js";

/**
 * goal_parents — multi-parent edges for the goals DAG.
 *
 * Replaces the single `goals.parentId` column (left vestigial, non-destructive).
 * A goal may have many parents; a parent may have many children. Integrity is
 * enforced on write in the goal service (no cycles; child scope ⊆ parent scope)
 * — see docs/superpowers/plans/2026-05-25-threads-goals-followup.md (B2) and
 * Decision #20 (superseded 2026-05-25).
 */
export const goalParents = pgTable(
  "goal_parents",
  {
    goalId: uuid("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.goalId, table.parentId] }),
    goalIdx: index("goal_parents_goal_idx").on(table.goalId),
    parentIdx: index("goal_parents_parent_idx").on(table.parentId),
  }),
);
