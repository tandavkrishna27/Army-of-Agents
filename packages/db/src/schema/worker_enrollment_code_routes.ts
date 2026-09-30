import { pgTable, text, uuid, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.js";

/** Opaque locator routing only. It never stores code authority or replay output. */
export const workerEnrollmentCodeRoutes = pgTable(
  "worker_enrollment_code_routes",
  {
    locatorHash: text("locator_hash").primaryKey(),
    candidateOrganizationId: uuid("candidate_organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    expiryIdx: index("worker_enrollment_code_routes_expiry_idx").on(table.expiresAt),
    locatorDigestValid: check(
      "worker_enrollment_code_routes_locator_hash_check",
      sql`locator_hash ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

export type WorkerEnrollmentCodeRoute = typeof workerEnrollmentCodeRoutes.$inferSelect;
export type NewWorkerEnrollmentCodeRoute = typeof workerEnrollmentCodeRoutes.$inferInsert;
