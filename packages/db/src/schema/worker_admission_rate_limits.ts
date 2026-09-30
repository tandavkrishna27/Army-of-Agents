import { pgTable, uuid, integer, timestamp, primaryKey, foreignKey } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

// DEP-009 — the PostgreSQL-backed SHARED admission rate limiter for the distributed
// worker-control path. `rate-limit.ts` (express-rate-limit) is a per-PROCESS in-memory
// bucket and is not applied to worker-control at all, so two control-plane replicas would
// each keep their own counter — process-local admission state, which the two-replica
// acceptance forbids. This table is the shared authority: ONE per-`(organizationId,
// window_start)` fixed-window counter both replicas increment, so a burst split across
// replica A + replica B observes ONE limit.
//
// The limiter does an ATOMIC single-statement upsert-increment-returning-count
// (INSERT ... ON CONFLICT (organization_id, window_start) DO UPDATE SET
// request_count = request_count + 1 RETURNING request_count) inside the request's tenant
// transaction — no read-then-write race — and rejects over the cap. It is fail-CLOSED: a
// shared-store error DENIES (never a per-process fallback).
//
// SECURITY MODEL (custom RLS migration, C14 / Decision #122; slug
// `worker_admission_rate_limit`): tenant-scoped `aoa_app` read+write under FORCE ROW LEVEL
// SECURITY, one org-scoped isolation policy keyed on the `aoa.organization_id` GUC (mirrors
// 0228/0231/0235/0237). No operator authority. A row for one org is invisible/unwritable to
// any other tenant, so the counter cannot be read or tampered across tenants.
export const workerAdmissionRateLimits = pgTable(
  "worker_admission_rate_limits",
  {
    organizationId: uuid("organization_id").notNull(),
    // The fixed-window bucket boundary: floor(now / windowMs) * windowMs. All requests in
    // the same window increment the same row; a later window mints a fresh row. Old rows are
    // inert (no lifecycle logic depends on them) and are pruned best-effort by the org's
    // periodic reconciliation tick (`sweepAdmissionRateWindows` in job-reconciliation.ts,
    // retention ≫ the 60s window), so the counter table stays bounded.
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    requestCount: integer("request_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // The composite PK is the ON CONFLICT target for the atomic upsert-increment.
    pk: primaryKey({
      columns: [table.organizationId, table.windowStart],
      name: "worker_admission_rate_limits_pkey",
    }),
    // Named explicitly (a bounded ≤63-char identifier) so the auto-generated FK name is
    // not silently truncated by PostgreSQL. organization_id is the tenant key.
    orgFk: foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
      name: "worker_admission_rate_limits_org_fk",
    }).onDelete("cascade"),
  }),
);

export type WorkerAdmissionRateLimit = typeof workerAdmissionRateLimits.$inferSelect;
export type NewWorkerAdmissionRateLimit = typeof workerAdmissionRateLimits.$inferInsert;
