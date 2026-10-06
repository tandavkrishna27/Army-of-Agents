import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { organizations } from "./organizations.js";

// Positional IDs and closed enums only. Source content, names, prompts, secrets,
// warnings and provider errors must never be copied into this journal.
export type ImportCheckpoint = { id: string | null; action: "created" | "updated" | "skipped" }[];

export const companyImportOperations = pgTable("company_import_operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  operationId: uuid("operation_id").notNull(),
  actorUserId: text("actor_user_id"),
  fingerprint: text("fingerprint").notNull(),
  status: text("status", { enum: ["pending", "running", "failed", "completed"] }).notNull().default("pending"),
  claimToken: uuid("claim_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  checkpoints: jsonb("checkpoints").$type<Record<string, ImportCheckpoint>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  companyOperationUq: uniqueIndex("company_import_operations_company_operation_uq").on(table.companyId, table.operationId),
  organizationOperationUq: uniqueIndex("company_import_operations_org_operation_uq").on(table.organizationId, table.operationId),
}));
