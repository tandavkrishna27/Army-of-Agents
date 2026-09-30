import { pgTable, uuid, text, timestamp, index, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.js";

/** Durable, bounded device-proof replay register. Contains no request body or tenant payload. */
export const workerProofReplays = pgTable(
  "worker_proof_replays",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    deviceThumbprint: text("device_thumbprint").notNull(),
    proofId: text("proof_id").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deviceProofUq: unique("worker_proof_replays_device_proof_uq").on(table.deviceThumbprint, table.proofId),
    digestValid: check("worker_proof_replays_thumbprint_check", sql`device_thumbprint ~ '^[0-9a-f]{64}$'`),
    expiryIdx: index("worker_proof_replays_expiry_idx").on(table.expiresAt),
  }),
);

export type WorkerProofReplay = typeof workerProofReplays.$inferSelect;
export type NewWorkerProofReplay = typeof workerProofReplays.$inferInsert;
