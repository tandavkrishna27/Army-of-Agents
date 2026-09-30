import { companies, type Db } from "@armyofagents/db";
import { DEFAULT_ORGANIZATION_ID } from "@armyofagents/shared";

/**
 * TEN-006a / E2-D07 — shared explicit-Organization company insert for tests.
 *
 * ALWAYS writes `organization_id` explicitly. Tests must never rely on the
 * `companies.organization_id` schema default (dropped in TEN-006b) — once that
 * default is gone, an omitted column is a NOT NULL violation. `organizationId`
 * defaults to the single-tenant Default Organization so a test may pass it
 * deliberately (or omit it and still get an explicit value), but the column is
 * ALWAYS present on the insert.
 *
 * Returns the inserted company row (via `.returning()`), so callers that need
 * the id can `const company = await insertTestCompany(db, { ... })`.
 */
export type InsertTestCompanyFields = Partial<typeof companies.$inferInsert> & {
  organizationId?: string;
};

export async function insertTestCompany(
  db: Db,
  fields: InsertTestCompanyFields = {},
): Promise<typeof companies.$inferSelect> {
  const { organizationId = DEFAULT_ORGANIZATION_ID, name = "Test Co", ...rest } = fields;
  const rows = await db
    .insert(companies)
    .values({ name, organizationId, ...rest })
    .returning();
  return rows[0]!;
}
