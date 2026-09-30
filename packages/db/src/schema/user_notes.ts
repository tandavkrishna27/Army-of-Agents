import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";

export const userNotes = pgTable(
  "user_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    title: text("title"),
    body: text("body").notNull().default(""),
    color: text("color").notNull().default("yellow"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCompanyIdx: index("user_notes_user_company_idx").on(table.userId, table.companyId),
  }),
);
