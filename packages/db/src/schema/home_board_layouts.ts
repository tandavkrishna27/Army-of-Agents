import { pgTable, uuid, text, integer, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";

export interface HomeBoardLayoutItem { i: string; x: number; y: number; w: number; h: number; }

/** Per-user, per-company canonical desktop (lg) Home layout. md/sm are derived at render, never stored. Null row => role default. */
export const homeBoardLayouts = pgTable(
  "home_board_layouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    layout: jsonb("layout").$type<HomeBoardLayoutItem[]>().notNull(), // canonical lg
    schemaVersion: integer("schema_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("home_board_layouts_company_idx").on(table.companyId),
    userIdx: index("home_board_layouts_user_idx").on(table.userId),
    userCompanyUq: uniqueIndex("home_board_layouts_user_company_uq").on(table.userId, table.companyId),
  }),
);
