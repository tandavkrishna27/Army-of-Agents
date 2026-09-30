import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const memoryFeedbackPatterns = pgTable(
  "memory_feedback_patterns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    patternType: text("pattern_type").notNull(),
    occurrenceCount: integer("occurrence_count").notNull().default(0),
    status: text("status").notNull().default("detected"),
    evidence: jsonb("evidence").$type<Record<string, unknown>[]>(),
    sourceAgentId: uuid("source_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("memory_feedback_patterns_company_idx").on(table.companyId),
    companyStatusIdx: index("memory_feedback_patterns_company_status_idx").on(table.companyId, table.status),
  }),
);
