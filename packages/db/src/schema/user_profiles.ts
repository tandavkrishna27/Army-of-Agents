import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export type UserProfileSocialLink = {
  type: string; // "linkedin" | "github" | "x" | "website" | "other"
  label: string | null;
  url: string;
};

/**
 * Global, per-human identity (Stage 0 §2.1 / D7). Filled once at signup; the
 * true "once per human" profile. `userId` is `text` to match better-auth's
 * `authUsers.id` (no FK — better-auth tables are managed separately).
 * company_user_profiles is NOT touched in Phase 1 (revC R10).
 */
export const userProfiles = pgTable("user_profiles", {
  userId: text("user_id").primaryKey(),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  title: text("title"),
  bio: text("bio"),
  /** IANA timezone (e.g. "Asia/Kolkata"). Collected during onboarding; the
   *  approval transaction copies it into company_user_profiles. */
  timezone: text("timezone"),
  socialLinks: jsonb("social_links").$type<UserProfileSocialLink[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
