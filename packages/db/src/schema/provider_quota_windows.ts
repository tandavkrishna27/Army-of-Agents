import { pgTable, uuid, text, timestamp, integer, index, unique } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Provider quota window snapshots.
 *
 * AoA-specific table (Paperclip has no equivalent — it computes quota state live
 * from adapter `getQuotaWindows()` calls). AoA persists snapshots so the `/costs`
 * UI and budget logic can read last-known usage without blocking on adapter polls.
 *
 * A row represents one window (e.g. Anthropic "5h" for model "sonnet") at a point
 * in time. Rows are upserted on adapter reports; fields beyond the window key are
 * nullable because different providers report different subsets (some give raw
 * limit/used ints, others give only a percent or a free-form value label).
 */
export const providerQuotaWindows = pgTable(
  "provider_quota_windows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model"),
    windowKind: text("window_kind").notNull(),
    label: text("label"),
    limitValue: integer("limit_value"),
    usedValue: integer("used_value"),
    usedPercent: integer("used_percent"),
    valueLabel: text("value_label"),
    resetAt: timestamp("reset_at", { withTimezone: true }),
    lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProviderIdx: index("provider_quota_windows_company_provider_idx").on(
      table.companyId,
      table.provider,
    ),
    companyResetAtIdx: index("provider_quota_windows_company_reset_at_idx").on(
      table.companyId,
      table.resetAt,
    ),
    // `nullsNotDistinct()` is required because `model` is nullable and the
    // primary writer (quota-windows.ts refreshWithAdapter) always upserts with
    // `model = null`. Without it, Postgres treats NULL as DISTINCT, so the
    // upsert's ON CONFLICT never matches an existing NULL-model row and every
    // refresh inserts a duplicate. With NULLS NOT DISTINCT the NULL-model rows
    // collide so the upsert UPDATEs in place. Requires PostgreSQL 15+.
    companyWindowUniqueIdx: unique("provider_quota_windows_company_window_unique_idx")
      .on(
        table.companyId,
        table.provider,
        table.model,
        table.windowKind,
      )
      .nullsNotDistinct(),
  }),
);
