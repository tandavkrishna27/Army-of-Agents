import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { environments } from "./environments.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { internalAgentConversations } from "./internal_agent.js";
import { issues } from "./issues.js";

export const environmentLeases = pgTable(
  "environment_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
    executionWorkspaceId: uuid("execution_workspace_id").references(() => executionWorkspaces.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    // Warm-reuse (Wave 6 / U7.1): the org agent this lease is held warm for.
    // Only set on `reuse_by_agent` leases — ephemeral leases leave this NULL.
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    // Warm-reuse (W7.5c): the Commander conversation this lease is held warm
    // for. Commander has no agent row, so it keys its warm lease on the
    // conversation instead of `agentId`. Only set on Commander `reuse_by_agent`
    // leases; org/crew/ephemeral leave it NULL.
    commanderConversationId: uuid("commander_conversation_id").references(
      () => internalAgentConversations.id,
      { onDelete: "set null" },
    ),
    status: text("status").notNull().default("active"),
    leasePolicy: text("lease_policy").notNull().default("ephemeral"),
    provider: text("provider"),
    providerLeaseId: text("provider_lease_id"),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    // Set when a `reuse_by_agent` lease is paused (E2B snapshot) at run end
    // instead of killed. `releasedAt` stays NULL while paused.
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    cleanupStatus: text("cleanup_status"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyEnvironmentStatusIdx: index("environment_leases_company_environment_status_idx").on(
      table.companyId,
      table.environmentId,
      table.status,
    ),
    companyExecutionWorkspaceIdx: index("environment_leases_company_execution_workspace_idx").on(
      table.companyId,
      table.executionWorkspaceId,
    ),
    companyIssueIdx: index("environment_leases_company_issue_idx").on(table.companyId, table.issueId),
    heartbeatRunIdx: index("environment_leases_heartbeat_run_idx").on(table.heartbeatRunId),
    companyLastUsedIdx: index("environment_leases_company_last_used_idx").on(table.companyId, table.lastUsedAt),
    providerLeaseIdx: index("environment_leases_provider_lease_idx").on(table.providerLeaseId),
    // Warm-resume lookup: find an agent's paused lease for a given environment.
    companyAgentEnvironmentStatusIdx: index("environment_leases_company_agent_environment_status_idx").on(
      table.companyId,
      table.agentId,
      table.environmentId,
      table.status,
    ),
    // Warm-resume lookup for Commander: find a conversation's paused lease.
    companyCommanderConvEnvironmentStatusIdx: index(
      "environment_leases_company_commander_conv_environment_status_idx",
    ).on(table.companyId, table.commanderConversationId, table.environmentId, table.status),
    // Idle reaper scan: sweep paused leases past the TTL.
    pausedReaperIdx: index("environment_leases_paused_reaper_idx").on(table.status, table.pausedAt),
  }),
);
