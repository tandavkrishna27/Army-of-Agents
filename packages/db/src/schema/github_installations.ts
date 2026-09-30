import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * GitHub App installations linked to AoA companies.
 *
 * One row per installation. A company may have at most one active installation
 * (enforced by the unique index on company_id).
 *
 * `github_host` defaults to "github.com". Override for GitHub Enterprise Server.
 * `suspended_at` is set when GitHub suspends the installation (webhook: installation.suspended).
 */
export const githubInstallations = pgTable(
  "github_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(), // "User" | "Organization"
    githubHost: text("github_host").notNull().default("github.com"),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: uniqueIndex("github_installations_company_id_unique").on(table.companyId),
    installationIdx: index("github_installations_installation_id_idx").on(table.installationId),
  }),
);

export type GitHubInstallation = typeof githubInstallations.$inferSelect;
export type NewGitHubInstallation = typeof githubInstallations.$inferInsert;
