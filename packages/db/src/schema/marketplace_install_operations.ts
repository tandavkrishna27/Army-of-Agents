import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

/**
 * Saga audit log entry — one per cascade step.
 * Recorded inline in marketplace_install_operations.cascadeResults.
 */
export interface CascadeStepResult {
  step:
    | "preflight"
    | "plugin-precondition"
    | "team-body-txn"
    | "skill-install"
    | "agent-install"
    | "package-member-skill-install";
  itemId: string;          // catalog item ID being processed in this step
  status: "success" | "failure" | "skipped";
  resultEntityId?: string; // ID of the created plugin/skill/agent/team row
  errorMessage?: string;
  durationMs: number;
}

export const marketplaceInstallOperations = pgTable(
  "marketplace_install_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    catalogItemId: text("catalog_item_id").notNull(),
    itemType: text("item_type").$type<"plugin" | "skill" | "agent" | "team" | "package">().notNull(),
    targetDepartmentId: uuid("target_department_id"),  // null for plugins (instance-scoped)
    status: text("status").$type<"pending" | "running" | "success" | "failure" | "requested">().notNull().default("pending"),
    resultEntityId: text("result_entity_id"),
    errorMessage: text("error_message"),
    errorCode: text("error_code"),
    errorDocs: text("error_docs"),
    cascadeResults: jsonb("cascade_results").$type<CascadeStepResult[]>(),
    idempotencyKey: text("idempotency_key"),
    // text() not uuid() — actor.userId is "local-board" (literal string) in local_trusted mode.
    // Matches existing precedent in approvals.requestedByUserId (text), goals.createdByUserId (text), etc.
    requestedByUserId: text("requested_by_user_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique idempotency key per company (24h enforcement is app-layer via createdAt)
    idempotencyUq: uniqueIndex("midx_install_op_idemp")
      .on(table.companyId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    // Snapshot dedupe lookup (company + item + dept + status) for "already running?" check
    snapshotDedupeIdx: index("midx_install_op_snapshot")
      .on(table.companyId, table.catalogItemId, table.targetDepartmentId, table.status),
    // Per-company recent operations (used by status endpoint + UI list)
    companyRecentIdx: index("midx_install_op_company_created")
      .on(table.companyId, table.createdAt),
  }),
);
