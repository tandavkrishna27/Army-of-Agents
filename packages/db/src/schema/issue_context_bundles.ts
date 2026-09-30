import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { discussions } from "./discussions.js";
import { threadScopeItems } from "./thread_scope_items.js";
import { threadScopeVersions } from "./thread_scope_versions.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";

export const issueContextBundles = pgTable(
  "issue_context_bundles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceIssueId: uuid("source_issue_id").references(() => issues.id, { onDelete: "cascade" }),
    sourceDiscussionId: uuid("source_discussion_id").references(() => discussions.id, { onDelete: "cascade" }),
    sourceScopeVersionId: uuid("source_scope_version_id").references(() => threadScopeVersions.id, {
      onDelete: "set null",
    }),
    sourceScopeItemId: uuid("source_scope_item_id").references(() => threadScopeItems.id, { onDelete: "set null" }),
    sourceKind: text("source_kind").notNull().default("issue"),
    targetIssueId: uuid("target_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    brief: text("brief"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTargetIdx: index("issue_context_bundles_company_target_idx").on(table.companyId, table.targetIssueId),
    companySourceIdx: index("issue_context_bundles_company_source_idx").on(table.companyId, table.sourceIssueId),
    companySourceDiscussionIdx: index("issue_context_bundles_company_source_discussion_idx").on(
      table.companyId,
      table.sourceDiscussionId,
    ),
    companyScopeVersionIdx: index("issue_context_bundles_company_scope_version_idx").on(
      table.companyId,
      table.sourceScopeVersionId,
    ),
  }),
);
