import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import {
  internalAgentConversations,
  internalAgentRuns,
} from "./internal_agent.js";

export const internalAgentRuntimeApprovals = pgTable(
  "internal_agent_runtime_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(
      () => internalAgentConversations.id,
      { onDelete: "set null" },
    ),
    runId: uuid("run_id").references(() => internalAgentRuns.id, {
      onDelete: "set null",
    }),
    userId: text("user_id").notNull(),
    toolName: text("tool_name").notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().notNull(),
    paramsHash: text("params_hash").notNull(),
    paramsHashVersion: text("params_hash_version").notNull().default("v1"),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decision: text("decision"),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    resultSummary: text("result_summary"),
    resultError: text("result_error"),
    resultEntityType: text("result_entity_type"),
    resultEntityId: text("result_entity_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyStatusExpiryIdx: index("ia_runtime_approvals_company_status_expiry_idx").on(
      table.companyId,
      table.status,
      table.expiresAt,
    ),
    companyUserStatusIdx: index("ia_runtime_approvals_company_user_status_idx").on(
      table.companyId,
      table.userId,
      table.status,
    ),
    runIdx: index("ia_runtime_approvals_run_idx").on(table.runId),
    toolIdx: index("ia_runtime_approvals_tool_idx").on(table.toolName),
  }),
);
