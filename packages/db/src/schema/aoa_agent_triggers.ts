import { pgTable, uuid, text, boolean, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/** Trigger binding for a kind='aoa' agent. `kind` is the dispatch binding
 *  (distinct from internal_agent_runs.trigger_type provenance). 'task' is
 *  reserved for the future, NOT implemented in v1. */
export const aoaAgentTriggers = pgTable("aoa_agent_triggers", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companyAgentIdx: index("aoa_triggers_company_agent_idx").on(t.companyId, t.agentId),
  companyKindEnabledIdx: index("aoa_triggers_company_kind_enabled_idx").on(t.companyId, t.kind, t.enabled),
}));
export const aoaAgentTriggersRelations = relations(aoaAgentTriggers, ({ one }) => ({
  company: one(companies, { fields: [aoaAgentTriggers.companyId], references: [companies.id] }),
  agent: one(agents, { fields: [aoaAgentTriggers.agentId], references: [agents.id] }),
}));
