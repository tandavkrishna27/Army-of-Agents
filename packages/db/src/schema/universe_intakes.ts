import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { UniverseIntakeDestination } from "@armyofagents/shared";
import { assets } from "./assets.js";
import { companies } from "./companies.js";
import { organizations } from "./organizations.js";

export const universeIntakes = pgTable("universe_intakes", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  actorKey: text("actor_key").notNull(),
  clientKey: uuid("client_key").notNull(),
  payloadSha256: text("payload_sha256").notNull(),
  destination: jsonb("destination").$type<UniverseIntakeDestination>().notNull(),
  filename: text("filename").notNull(),
  declaredContentType: text("declared_content_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  sha256: text("sha256").notNull(),
  state: text("state").notNull().default("receiving"),
  revision: integer("revision").notNull().default(1),
  assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
  finalObjectKey: text("final_object_key"),
  finalByteSize: integer("final_byte_size"),
  finalSha256: text("final_sha256"),
  reason: text("reason"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  ownerClientUq: uniqueIndex("universe_intakes_owner_client_uq").on(table.companyId, table.actorKey, table.clientKey),
  companyStateIdx: index("universe_intakes_company_state_idx").on(table.companyId, table.state, table.expiresAt),
  assetIdx: index("universe_intakes_asset_idx").on(table.assetId),
}));

export const universeIntakeParts = pgTable("universe_intake_parts", {
  intakeId: uuid("intake_id").notNull().references(() => universeIntakes.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  partIndex: integer("part_index").notNull(),
  objectKey: text("object_key").notNull(),
  byteSize: integer("byte_size").notNull(),
  sha256: text("sha256").notNull(),
  state: text("state").notNull().default("reserved"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.intakeId, table.partIndex] }),
  companyIntakeIdx: index("universe_intake_parts_company_intake_idx").on(table.companyId, table.intakeId),
  objectKeyUq: uniqueIndex("universe_intake_parts_object_key_uq").on(table.objectKey),
}));
