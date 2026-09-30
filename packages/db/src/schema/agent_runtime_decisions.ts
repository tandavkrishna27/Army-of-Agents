import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const agentRuntimeDecisions = pgTable(
  "agent_runtime_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    adapterType: text("adapter_type").notNull(),
    adapterSessionId: text("adapter_session_id"),
    adapterSessionParams: jsonb("adapter_session_params").$type<Record<string, unknown>>(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("created"),
    nonce: text("nonce").notNull(),
    sourceRevision: integer("source_revision").notNull().default(0),
    promptHash: text("prompt_hash").notNull(),
    sourceUniqueKey: text("source_unique_key"),
    title: text("title").notNull(),
    summary: text("summary"),
    promptText: text("prompt_text"),
    toolName: text("tool_name"),
    command: text("command"),
    commandHash: text("command_hash"),
    cwd: text("cwd"),
    path: text("path"),
    networkTarget: text("network_target"),
    riskClass: text("risk_class"),
    options: jsonb("options").$type<Array<Record<string, unknown>>>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    timeoutPolicy: text("timeout_policy").notNull(),
    decision: text("decision"),
    answerPayload: jsonb("answer_payload").$type<Record<string, unknown>>(),
    answerIdempotencyKey: text("answer_idempotency_key"),
    answeredByUserId: text("answered_by_user_id"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    relayedAt: timestamp("relayed_at", { withTimezone: true }),
    relayError: text("relay_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusExpiryIdx: index("agent_runtime_decisions_company_status_expiry_idx").on(
      table.companyId,
      table.status,
      table.expiresAt,
    ),
    companyRunStatusIdx: index("agent_runtime_decisions_company_run_status_idx").on(
      table.companyId,
      table.runId,
      table.status,
    ),
    companyAgentCreatedIdx: index("agent_runtime_decisions_company_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
    statusExpiryIdx: index("agent_runtime_decisions_status_expiry_idx").on(
      table.status,
      table.expiresAt,
    ),
    sourceUniqueIdx: uniqueIndex("agent_runtime_decisions_source_unique_idx")
      .on(table.sourceUniqueKey)
      .where(sql`source_unique_key is not null`),
  }),
);

export const agentRuntimeTrustRules = pgTable(
  "agent_runtime_trust_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    grantScope: text("grant_scope").notNull().default("persistent"),
    adapterType: text("adapter_type").notNull(),
    toolName: text("tool_name"),
    commandHash: text("command_hash"),
    pathScope: text("path_scope"),
    networkScope: text("network_scope"),
    riskClass: text("risk_class"),
    enabled: boolean("enabled").notNull().default(true),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentEnabledIdx: index("agent_runtime_trust_rules_company_agent_enabled_idx").on(
      table.companyId,
      table.agentId,
      table.enabled,
    ),
    companyAdapterToolIdx: index("agent_runtime_trust_rules_company_adapter_tool_idx").on(
      table.companyId,
      table.adapterType,
      table.toolName,
    ),
    runScopeIdx: index("agent_runtime_trust_rules_run_scope_idx").on(
      table.runId,
      table.enabled,
    ),
  }),
);
