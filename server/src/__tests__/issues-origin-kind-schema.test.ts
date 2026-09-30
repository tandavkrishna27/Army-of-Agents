import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// Contract test for Task 1.1 — Crew Work-as-Tasks board index.
//
// The crew board (Phase 1.4) filters WHERE origin_kind='crew_thread' scoped by
// company_id. This test locks the structural invariant that the supporting
// composite index exists in a generated migration with IF NOT EXISTS
// (C14 idempotency rule).
//
// We discover the migration file dynamically so the test does not need to be
// updated if db:generate produces a different numeric tag.

const MIGRATIONS_DIR = resolve(
  __dirname,
  "../../../packages/db/src/migrations",
);

const INDEX_NAME = "issues_company_origin_kind_idx";

/**
 * Find the migration file that contains the given index name.
 * Searches all *.sql files in MIGRATIONS_DIR in ascending order.
 * Returns { file, sql } of the first match, or null if not found.
 */
function findMigrationForIndex(
  indexName: string,
): { file: string; sql: string } | null {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
    if (sql.includes(indexName)) {
      return { file, sql };
    }
  }
  return null;
}

describe(`Migration — issues board index on (company_id, origin_kind)`, () => {
  it(`a migration file containing "${INDEX_NAME}" exists`, () => {
    const result = findMigrationForIndex(INDEX_NAME);
    expect(
      result,
      `No migration file under packages/db/src/migrations/ contains "${INDEX_NAME}". ` +
        `Run pnpm db:generate to produce the migration, then verify IF NOT EXISTS was added.`,
    ).not.toBeNull();
  });

  it(`CREATE INDEX uses IF NOT EXISTS for idempotency (C14 rule)`, () => {
    const result = findMigrationForIndex(INDEX_NAME);
    if (!result) {
      throw new Error(
        `Migration for ${INDEX_NAME} not found — ensure db:generate has been run.`,
      );
    }
    expect(result.sql).toMatch(
      new RegExp(
        `CREATE INDEX IF NOT EXISTS "${INDEX_NAME}"`,
        "i",
      ),
    );
  });

  it(`index covers (company_id, origin_kind) columns`, () => {
    const result = findMigrationForIndex(INDEX_NAME);
    if (!result) {
      throw new Error(
        `Migration for ${INDEX_NAME} not found — ensure db:generate has been run.`,
      );
    }
    expect(result.sql).toMatch(
      new RegExp(
        `CREATE INDEX IF NOT EXISTS "${INDEX_NAME}"[^;]*\\("company_id",\\s*"origin_kind"\\)`,
        "i",
      ),
    );
  });

  it(`index is on the "issues" table`, () => {
    const result = findMigrationForIndex(INDEX_NAME);
    if (!result) {
      throw new Error(
        `Migration for ${INDEX_NAME} not found — ensure db:generate has been run.`,
      );
    }
    expect(result.sql).toMatch(
      new RegExp(
        `CREATE INDEX IF NOT EXISTS "${INDEX_NAME}" ON "issues"`,
        "i",
      ),
    );
  });
});
