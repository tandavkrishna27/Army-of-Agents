import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const companyUserCapabilityDocuments = pgTable(
  "company_user_capability_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    slug: text("slug").notNull(),
    filename: text("filename").notNull(),
    title: text("title").notNull(),
    kind: text("kind").notNull(),
    content: text("content").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    isStandard: boolean("is_standard").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
  },
  (table) => ({
    companyUserSlugUq: uniqueIndex("company_user_capability_documents_company_user_slug_uq").on(
      table.companyId,
      table.userId,
      table.slug,
    ),
    companyUserSortIdx: index("company_user_capability_documents_company_user_sort_idx").on(
      table.companyId,
      table.userId,
      table.sortOrder,
    ),
  }),
);
