import {
  pgTable,
  uuid,
  text,
  bigint,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** A persisted destination-scoped composer draft (Universe). One canonical row per
 * (company, user, conversation, destinationKind, destinationId), owner-only, with a
 * `revision` for optimistic concurrency. Text + validated attachment asset IDs
 * only — never inline attachment content, and geometry never lives here. Uses the
 * company-scoped app boundary, not the frozen replatform RLS tenant set. */
export const universeDrafts = pgTable(
  "universe_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    destinationKind: text("destination_kind").notNull(),
    destinationId: text("destination_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    text: text("text").notNull().default(""),
    attachmentAssetIds: jsonb("attachment_asset_ids")
      .$type<string[]>()
      .notNull(),
    payload: jsonb("payload").$type<Record<string, unknown> | null>(),
    pendingAttempt: jsonb("pending_attempt").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("universe_drafts_company_user_idx").on(
      table.companyId,
      table.userId,
    ),
    ownerDestinationUq: uniqueIndex("universe_drafts_owner_destination_uq").on(
      table.userId,
      table.companyId,
      table.conversationId,
      table.destinationKind,
      table.destinationId,
    ),
  }),
);
