import {
  pgTable,
  uuid,
  integer,
  real,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const agentTrustScores = pgTable(
  "agent_trust_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    totalCompleted: integer("total_completed").notNull().default(0),
    approvedWithoutChanges: integer("approved_without_changes").notNull().default(0),
    recentCompleted: integer("recent_completed").notNull().default(0),
    recentApproved: integer("recent_approved").notNull().default(0),
    currentScore: real("current_score").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdx: index("agent_trust_scores_agent_idx").on(table.agentId),
    companyIdx: index("agent_trust_scores_company_idx").on(table.companyId),
    companyAgentUq: uniqueIndex("agent_trust_scores_company_agent_uq").on(table.companyId, table.agentId),
  }),
);
