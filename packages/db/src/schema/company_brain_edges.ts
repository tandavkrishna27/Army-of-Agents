import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

const nodeTypes = [
  "company",
  "department",
  "project",
  "team",
  "human",
  "agent",
  "goal",
  "task",
  "discussion",
  "discussion_entry",
  "memory_item",
  "memory_folder",
  "memory_asset",
  "artifact",
].map((type) => `'${type}'`).join(", ");

const semanticKinds = [
  "applies_to",
  "related_to",
  "supports",
  "conflicts_with",
  "supersedes",
  "duplicate_of",
].map((kind) => `'${kind}'`).join(", ");

export const companyBrainEdges = pgTable(
  "company_brain_edges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    fromType: text("from_type").notNull(),
    fromId: text("from_id").notNull(),
    toType: text("to_type").notNull(),
    toId: text("to_id").notNull(),
    kind: text("kind").notNull(),
    confidence: numeric("confidence", { precision: 10, scale: 6 }),
    evidence: text("evidence"),
    createdByPrincipalType: text("created_by_principal_type").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    source: text("source").notNull().default("manual"),
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    companyFromIdx: index("company_brain_edges_company_from_idx").on(
      table.companyId,
      table.fromType,
      table.fromId,
    ),
    companyToIdx: index("company_brain_edges_company_to_idx").on(
      table.companyId,
      table.toType,
      table.toId,
    ),
    companyKindStatusIdx: index("company_brain_edges_company_kind_status_idx").on(
      table.companyId,
      table.kind,
      table.status,
    ),
    activeEdgeUq: uniqueIndex("company_brain_edges_active_edge_uq")
      .on(table.companyId, table.fromType, table.fromId, table.toType, table.toId, table.kind)
      .where(sql`status = 'active'`),
    fromTypeValid: check(
      "company_brain_edges_from_type_check",
      sql.raw(`from_type IN (${nodeTypes})`),
    ),
    toTypeValid: check(
      "company_brain_edges_to_type_check",
      sql.raw(`to_type IN (${nodeTypes})`),
    ),
    kindValid: check(
      "company_brain_edges_kind_check",
      sql.raw(`kind IN (${semanticKinds})`),
    ),
    statusValid: check(
      "company_brain_edges_status_check",
      sql`status IN ('active', 'archived')`,
    ),
    confidenceValid: check(
      "company_brain_edges_confidence_check",
      sql`confidence IS NULL OR (confidence >= 0 AND confidence <= 1)`,
    ),
  }),
);
