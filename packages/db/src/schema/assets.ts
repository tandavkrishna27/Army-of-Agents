import { pgTable, uuid, text, integer, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    originalFilename: text("original_filename"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    // Trusted upload provenance (PR #291 round-6 #2 security). The upload endpoint
    // records which namespace an asset came in through, and sets composer_validated
    // = true ONLY when the upload passed the composer allowlist + size + byte-sniff
    // guard. Attachment-binding + runtime-delivery boundaries require
    // composer_validated so a caller cannot upload via the unrestricted
    // namespace=files (50MB, no sniff) and then bind that asset as a composer
    // attachment — closing the spoofed-text-into-Commander-turn vector.
    uploadNamespace: text("upload_namespace"),
    composerValidated: boolean("composer_validated").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("assets_company_created_idx").on(table.companyId, table.createdAt),
    companyProviderIdx: index("assets_company_provider_idx").on(table.companyId, table.provider),
    companyObjectKeyUq: uniqueIndex("assets_company_object_key_uq").on(table.companyId, table.objectKey),
  }),
);
