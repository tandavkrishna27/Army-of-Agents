import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { assets } from "./assets.js";

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    type: text("type").notNull(),
    status: text("status").notNull().default("draft"),
    currentVersionId: uuid("current_version_id").references((): AnyPgColumn => artifactVersions.id, { onDelete: "set null" }),
    createdById: text("created_by_id").notNull(),
    // #197: idempotency anchor for action-gated artifact commits (thread-agent-actions).
    sourceActionId: uuid("source_action_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("artifacts_company_idx").on(table.companyId),
    companyStatusIdx: index("artifacts_company_status_idx").on(table.companyId, table.status),
    // #197: idempotent action-gated artifact commit. At most one artifact per
    // (company, source_action_id); partial so non-gated artifacts (NULL) are exempt.
    sourceActionUniq: uniqueIndex("artifacts_source_action_uq")
      .on(table.companyId, table.sourceActionId)
      .where(sql`source_action_id IS NOT NULL`),
  }),
);

export const artifactVersions = pgTable(
  "artifact_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactId: uuid("artifact_id").notNull().references(() => artifacts.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    source: text("source").notNull(),
    sourceDetail: text("source_detail"),
    changelog: text("changelog"),
    parentVersionId: uuid("parent_version_id").references((): AnyPgColumn => artifactVersions.id, { onDelete: "set null" }),
    content: text("content"),
    fileUrl: text("file_url"),
    // Artifact Lifecycle P1: file-backed versions.
    // storageKind = "inline" (text content, today's model) or "asset" (file
    // stored in `assets`). Purely additive: every existing row defaults to
    // "inline", nothing migrates.
    storageKind: text("storage_kind").notNull().default("inline"),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    filename: text("filename"),
    contentType: text("content_type"),
    extension: text("extension"),
    byteSize: integer("byte_size"),
    sha256: text("sha256"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    artifactIdx: index("artifact_versions_artifact_idx").on(table.artifactId),
    assetIdx: index("artifact_versions_asset_idx").on(table.assetId),
    artifactVersionUq: uniqueIndex("artifact_versions_artifact_version_uq").on(table.artifactId, table.versionNumber),
  }),
);
