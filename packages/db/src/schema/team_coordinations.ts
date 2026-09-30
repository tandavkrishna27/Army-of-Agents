import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { teams } from "./teams.js";
import type { FileInventoryEntry } from "@armyofagents/shared";

export const teamCoordinations = pgTable(
  "team_coordinations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    markdown: text("markdown").notNull(),
    sourceType: text("source_type").notNull().default("local_path"),
    sourceLocator: text("source_locator"),
    sourceRef: text("source_ref"),
    trustLevel: text("trust_level").notNull().default("markdown_only"),
    compatibility: text("compatibility").notNull().default("compatible"),
    fileInventory: jsonb("file_inventory").$type<FileInventoryEntry[]>().notNull().default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("published"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUq: uniqueIndex("team_coordinations_company_key_uq").on(table.companyId, table.key),
    teamIdx: index("team_coordinations_team_idx").on(table.teamId),
    teamStatusIdx: index("team_coordinations_team_status_idx").on(table.teamId, table.status),
    // Partial unique index — at most one published coordination per team. Service-layer
    // upsert (team-coordination.ts:upsert) is TOCTOU-vulnerable without this; two concurrent
    // upserts could both see "no published row" and both insert. This index makes the second
    // insert fail with 23505. The 23505 is converted to a 409 Conflict at the service layer.
    onePublishedPerTeamUq: uniqueIndex("team_coordinations_one_published_uq")
      .on(table.teamId)
      .where(sql`status = 'published'`),
    statusValid: check(
      "team_coordinations_status_check",
      sql`status IN ('draft', 'published', 'archived')`,
    ),
  }),
);
