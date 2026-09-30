import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// DEP-003 (E6 deployment harness): the durable, operator-gated marker that records
// a completed, verified 0188 populated single-tenant -> cloud_auth cutover preflight.
//
// SECURITY MODEL (custom RLS migration, C14 / Decision #122; slug
// `distributed_cutover_marker`):
//   - `aoa_operator` WRITE — only the operator-gated migration job writes this row
//     (via the aoa_operator non-owner pool). Application startup READS it and can
//     NEVER write or synthesize it.
//   - `aoa_app` READ-ONLY — the control plane reads the marker to decide whether a
//     cutover is authorized, but only OUTSIDE a tenant transaction (the read policy
//     predicate is `current_setting('aoa.organization_id', true) IS NULL`).
//   - tenants NONE — a tenant-scoped query (aoa_app WITH the tenant GUC set) never
//     matches the read policy, so the marker is invisible to every tenant.
//   - FORCE ROW LEVEL SECURITY — defense-in-depth against a non-superuser owner
//     mistake (same rationale as the E2 tenant tables / E2-F004).
//
// This is PLATFORM/instance infrastructure: it has NO organization_id (it is not
// tenant data). Idempotency is keyed by `candidate_sha` (one durable marker per
// candidate image revision); a second preflight invocation for a present, verified
// marker for the same candidate SHA is a no-op success.
export const distributedCutoverMarkers = pgTable(
  "distributed_cutover_markers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The exact candidate image source revision the cutover was validated against
    // (AOA_0188_CANDIDATE_SHA == the image's recorded revision). One marker per SHA.
    candidateSha: text("candidate_sha").notNull(),
    // Object-store reference for the snapshot taken + checksum-validated + restored
    // to the isolated pre-cutover database before the marker was written.
    snapshotRef: text("snapshot_ref").notNull(),
    snapshotChecksum: text("snapshot_checksum").notNull(),
    // The read-back verification timestamp (the marker is written first, then
    // verified by read-back; verified_at is set on that successful read-back).
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    candidateShaUq: uniqueIndex("distributed_cutover_markers_candidate_sha_uq").on(
      table.candidateSha,
    ),
  }),
);

export type DistributedCutoverMarker = typeof distributedCutoverMarkers.$inferSelect;
export type NewDistributedCutoverMarker = typeof distributedCutoverMarkers.$inferInsert;
