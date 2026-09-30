import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import { goals } from "./goals.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const costEvents = pgTable(
  "cost_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // U13.4: nullable — one-shot CLI spawns (extraction/compaction/readiness,
    // one-shot-cli-budget.ts) have no owning agent and record cost events
    // with agentId:null. Every other writer (costService.createEvent,
    // costs.ts) still requires+validates a real agent and never passes null.
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    billingCode: text("billing_code"),
    provider: text("provider").notNull(),
    biller: text("biller").notNull().default("unknown"),
    billingType: text("billing_type").notNull().default("unknown"),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costCents: integer("cost_cents").notNull(),
    // JOB-012 — server-owned authoritative-cost provenance (all nullable; legacy
    // writers pass nothing → stay NULL). `sourceIdempotencyKey` is the stable
    // per-accepted-usage-event charge key that makes the authoritative charge
    // at-most-once (the partial unique below is the DB backstop alongside the
    // bridge's receipt fast-path). `rateId`/`rateVersion`/`roundingMode` pin the
    // versioned rate schedule the SERVER resolved (never a worker-supplied price).
    sourceIdempotencyKey: text("source_idempotency_key"),
    rateId: text("rate_id"),
    rateVersion: integer("rate_version"),
    roundingMode: text("rounding_mode"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyOccurredIdx: index("cost_events_company_occurred_idx").on(table.companyId, table.occurredAt),
    companyAgentOccurredIdx: index("cost_events_company_agent_occurred_idx").on(
      table.companyId,
      table.agentId,
      table.occurredAt,
    ),
    companyProviderOccurredIdx: index("cost_events_company_provider_occurred_idx").on(
      table.companyId,
      table.provider,
      table.occurredAt,
    ),
    companyBillerOccurredIdx: index("cost_events_company_biller_occurred_idx").on(
      table.companyId,
      table.biller,
      table.occurredAt,
    ),
    companyHeartbeatRunIdx: index("cost_events_company_heartbeat_run_idx").on(
      table.companyId,
      table.heartbeatRunId,
    ),
    // JOB-012 — at-most-once authoritative charge per (company, accepted-usage-event)
    // identity. Partial so legacy rows (source_idempotency_key IS NULL) are exempt.
    sourceIdemUq: uniqueIndex("cost_events_source_idem_uq")
      .on(table.companyId, table.sourceIdempotencyKey)
      .where(sql`${table.sourceIdempotencyKey} IS NOT NULL`),
  }),
);
