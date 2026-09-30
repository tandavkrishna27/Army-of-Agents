import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { HubLane } from "@armyofagents/shared";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";

export const hubPreferences = pgTable(
  "hub_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    defaultLanding: text("default_landing").notNull().default("home"),
    visibleLanes: jsonb("visible_lanes").$type<HubLane[]>().notNull(),
    groupMode: text("group_mode").notNull().default("auto"),
    density: text("density").notNull().default("comfortable"),
    showAutopilotEntry: boolean("show_autopilot_entry").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("hub_preferences_company_idx").on(table.companyId),
    userIdx: index("hub_preferences_user_idx").on(table.userId),
    userCompanyUq: uniqueIndex("hub_preferences_user_company_uq").on(table.userId, table.companyId),
  }),
);
