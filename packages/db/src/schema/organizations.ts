import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { authUsers } from "./auth.js";

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // GLOBALLY unique tenant handle (P4 routing keys on it). slug = 'default'
    // for the sentinel Organization.
    slug: text("slug").notNull(),
    status: text("status").notNull().default("active"),
    plan: text("plan").notNull().default("beta"),
    // P5 concurrency governance dial. NULL = no org-level cap (semantics owned
    // by P5); added now so P5 needs no schema migration.
    concurrencyCap: integer("concurrency_cap"),
    createdByUserId: text("created_by_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    // Optional client-generated replay anchor for self-serve tenant creation.
    // Scoped to the authenticated creator by the composite unique constraint
    // below; legacy/internal organization writers may continue to omit it.
    creationRequestId: uuid("creation_request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    slugUq: uniqueIndex("organizations_slug_uq").on(table.slug),
    creatorCreationRequestUq: uniqueIndex("organizations_creator_creation_request_uq").on(
      table.createdByUserId,
      table.creationRequestId,
    ),
    statusIdx: index("organizations_status_idx").on(table.status),
    statusValid: check("organizations_status_check", sql`status IN ('active', 'suspended', 'archived')`),
  }),
);
