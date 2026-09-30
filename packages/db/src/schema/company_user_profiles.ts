import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { assets } from "./assets.js";
import { companies } from "./companies.js";

export type CompanyUserProfileSocialLink = {
  type: string;
  label: string | null;
  url: string;
};

export const companyUserProfiles = pgTable(
  "company_user_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    displayName: text("display_name"),
    title: text("title"),
    bio: text("bio"),
    location: text("location"),
    timezone: text("timezone"),
    socialLinks: jsonb("social_links").$type<CompanyUserProfileSocialLink[]>().notNull().default([]),
    avatarAssetId: uuid("avatar_asset_id").references(() => assets.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: text("updated_by_user_id"),
  },
  (table) => ({
    companyUserUq: uniqueIndex("company_user_profiles_company_user_uq").on(table.companyId, table.userId),
  }),
);
