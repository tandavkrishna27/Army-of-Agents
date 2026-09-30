import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { notifications } from "./notifications.js";

// Append-only. One row per hub action (manual OR autonomous) written in the same
// transaction as the state transition, BEFORE any DB-only effect; external/
// irreversible relays happen after commit so the record survives a relay failure.
export const hubAudit = pgTable(
  "hub_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Nullable + set-null on delete: the immutable decision record must OUTLIVE
    // its hub item (audit survives item purge/retention). NEVER cascade-delete.
    hubItemId: uuid("hub_item_id").references(() => notifications.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key"), // action dedup (partial-unique below)
    actorType: text("actor_type").notNull(),      // "user" | "agent" | "autonomy" | "system"
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    authorityBasis: text("authority_basis"),       // why the actor was allowed (role/grant)
    autonomyLevel: text("autonomy_level"),         // null for manual actions
    priorState: jsonb("prior_state"),              // {status, version, ...} before the transition
    sourceRevision: text("source_revision"),
    reason: text("reason"),
    decisionContext: jsonb("decision_context"),
    undoDeadline: timestamp("undo_deadline", { withTimezone: true }),
    irreversibleSideEffects: jsonb("irreversible_side_effects"),
    relayResult: jsonb("relay_result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    itemIdx: index("hub_audit_item_idx").on(table.hubItemId, table.createdAt),
    companyIdx: index("hub_audit_company_idx").on(table.companyId, table.createdAt),
    idemUq: uniqueIndex("hub_audit_idem_uq")
      .on(table.companyId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  }),
);
