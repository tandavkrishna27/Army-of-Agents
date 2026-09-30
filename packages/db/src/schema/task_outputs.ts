import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import { artifacts, artifactVersions } from "./artifacts.js";
import { assets } from "./assets.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { workspaceRuntimeServices } from "./workspace_runtime_services.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";

export const taskOutputs = pgTable(
  "task_outputs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull().default("aoa"),
    externalId: text("external_id"),
    artifactId: uuid("artifact_id").references(() => artifacts.id, { onDelete: "set null" }),
    artifactVersionId: uuid("artifact_version_id").references(() => artifactVersions.id, { onDelete: "set null" }),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    executionWorkspaceId: uuid("execution_workspace_id").references(() => executionWorkspaces.id, { onDelete: "set null" }),
    runtimeServiceId: uuid("runtime_service_id").references(() => workspaceRuntimeServices.id, { onDelete: "set null" }),
    url: text("url"),
    title: text("title").notNull(),
    status: text("status").notNull().default("active"),
    reviewState: text("review_state").notNull().default("none"),
    isPrimary: boolean("is_primary").notNull().default(false),
    healthStatus: text("health_status").notNull().default("unknown"),
    summary: text("summary"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueTypeIdx: index("task_outputs_company_issue_type_idx").on(
      table.companyId,
      table.issueId,
      table.type,
    ),
    companyIssuePrimaryIdx: index("task_outputs_company_issue_primary_idx").on(
      table.companyId,
      table.issueId,
      table.isPrimary,
    ),
    companyWorkspaceTypeIdx: index("task_outputs_company_workspace_type_idx").on(
      table.companyId,
      table.executionWorkspaceId,
      table.type,
    ),
    companyRuntimeServiceIdx: index("task_outputs_company_runtime_service_idx").on(
      table.companyId,
      table.runtimeServiceId,
    ),
    companyArtifactIdx: index("task_outputs_company_artifact_idx").on(
      table.companyId,
      table.artifactId,
    ),
    companyIssueProviderExternalUq: uniqueIndex("task_outputs_company_issue_provider_external_uq")
      .on(table.companyId, table.issueId, table.provider, table.externalId)
      .where(sql`external_id IS NOT NULL`),
    companyUpdatedIdx: index("task_outputs_company_updated_idx").on(
      table.companyId,
      table.updatedAt,
    ),
  }),
);
