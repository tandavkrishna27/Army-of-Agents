import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";

/**
 * WS6 — durable per-department braindump capture, feeding the Librarian
 * crew agent (see server/src/services/internal-agent/aoa-agents/ensure-librarian.ts).
 *
 * Status machine: pending -> running -> proposed -> failed. ("approved" is a
 * DERIVED view, not a stored terminal status — see
 * server/src/services/braindump.ts for why: it depends on the founder
 * approving every linked memory_items row, which is many-to-one and already
 * tracked on memory_items itself.)
 *
 * Scope: a capture is either company-wide (`scope="company"`, departmentId
 * NULL → identity-layer proposals under the "Company" seed folder) or
 * department-scoped (`scope="department"` → domain-layer under the dept's
 * urlKey folder).
 *
 * Idempotency: TWO partial unique indexes, because Postgres treats NULLs as
 * distinct — a single (companyId, departmentId, idempotencyKey) index would
 * silently allow duplicate company-wide captures (and double-dispatch the
 * Librarian). Department rows dedupe on (company, department, key); company
 * rows on (company, key). Conflict lookups for company scope must use
 * `isNull(departmentId)`, never `eq(departmentId, null)`.
 */
export const braindumpCaptures = pgTable(
  "braindump_captures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** NULL for a company-wide capture (`scope = "company"`); set for a
     *  department capture. See the two partial unique indexes below — Postgres
     *  treats NULLs as distinct, so a single composite unique index would NOT
     *  dedupe company captures. */
    departmentId: uuid("department_id").references(() => projects.id, { onDelete: "cascade" }),
    /** "company" (→ identity-layer proposals, filed under the "Company" seed
     *  folder) | "department" (→ domain-layer, filed under the dept's urlKey). */
    scope: text("scope").notNull().default("department"),
    idempotencyKey: text("idempotency_key").notNull(),
    content: text("content").notNull(),
    contentLength: integer("content_length").notNull(),
    status: text("status").notNull().default("pending"), // pending | running | proposed | failed
    librarianAgentId: uuid("librarian_agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** internal_agent_runs.id for the dispatch, when one was created. No FK
     *  (mirrors work_questions.originatingRunId) — cross-cutting run id, kept
     *  loosely coupled so a run-table cleanup never blocks a capture row. */
    runId: uuid("run_id"),
    /** Best-effort correlation only (time-window + agent + department query
     *  against memory_items after a successful run) — see braindump.ts. Not
     *  authoritative; the memory_items rows themselves are the source of
     *  truth for what was proposed. */
    proposedMemoryItemIds: jsonb("proposed_memory_item_ids").$type<string[]>().notNull().default([]),
    /** `memory_assets.id`s dropped on this scope's card. The upload route
     *  (/memory/assets/upload) already created those rows at the scope's
     *  folderPath — submission only validates + stores the ids here, it never
     *  inserts memory_assets again (that would duplicate the asset). */
    assetIds: jsonb("asset_ids").$type<string[]>().notNull().default([]),
    failureReason: text("failure_reason"),
    dispatchStartedAt: timestamp("dispatch_started_at", { withTimezone: true }),
    dispatchCompletedAt: timestamp("dispatch_completed_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** Department captures: dedupe on (company, department, key). Partial —
     *  only rows that actually have a department. */
    idempotencyUq: uniqueIndex("braindump_captures_idempotency_uq")
      .on(table.companyId, table.departmentId, table.idempotencyKey)
      .where(sql`${table.departmentId} IS NOT NULL`),
    /** Company-wide captures: department_id is NULL, and Postgres treats NULLs
     *  as DISTINCT — so the composite index above cannot dedupe them. This
     *  partial index enforces one row per (company, key) for company scope.
     *  Lookups must use isNull(departmentId), not eq(departmentId, null). */
    companyIdempotencyUq: uniqueIndex("braindump_captures_company_idempotency_uq")
      .on(table.companyId, table.idempotencyKey)
      .where(sql`${table.departmentId} IS NULL`),
    companyDepartmentStatusIdx: index("braindump_captures_company_department_status_idx").on(
      table.companyId,
      table.departmentId,
      table.status,
    ),
  }),
);
