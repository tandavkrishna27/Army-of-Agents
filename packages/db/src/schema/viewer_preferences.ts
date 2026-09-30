import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";

export const viewerPreferences = pgTable(
  "viewer_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Nullable: null = inherit the company default (internal_agent_config.viewerControlLevel).
    viewerControlLevel: text("viewer_control_level"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("viewer_preferences_company_idx").on(table.companyId),
    userIdx: index("viewer_preferences_user_idx").on(table.userId),
    userCompanyUq: uniqueIndex("viewer_preferences_user_company_uq").on(table.userId, table.companyId),
  }),
);
