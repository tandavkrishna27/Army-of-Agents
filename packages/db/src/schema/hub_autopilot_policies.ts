import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { HubAutopilotMode, HubAutopilotRule } from "@armyofagents/shared";
import { companies } from "./companies.js";

export const hubAutopilotPolicies = pgTable(
  "hub_autopilot_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    mode: text("mode").$type<HubAutopilotMode>().notNull().default("off"),
    rules: jsonb("rules").$type<HubAutopilotRule[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("hub_autopilot_policies_company_idx").on(table.companyId),
    companyUq: uniqueIndex("hub_autopilot_policies_company_uq").on(table.companyId),
  }),
);
