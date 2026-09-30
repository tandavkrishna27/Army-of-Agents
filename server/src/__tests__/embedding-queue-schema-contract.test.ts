import { describe, it, expect } from "vitest";
import { embeddingQueue } from "@armyofagents/db";

/**
 * Embedding Queue Schema Contract Tests (Task 4, keyless-except-embeddings)
 *
 * Verifies that the embedding_queue table has the columns required for
 * per-company key resolution (companyId) and exponential backoff (nextRetryAt).
 *
 * These tests are intentionally lightweight — they only assert column presence
 * on the Drizzle table object. No mocks needed; the table is just an object.
 */

// Helper: get column names from a Drizzle table (same pattern as discussions-schema-contract.test.ts)
function getColumnNames(table: Record<string, unknown>): string[] {
  return Object.keys(table).filter(
    (key) =>
      typeof table[key] === "object" &&
      table[key] !== null &&
      "name" in (table[key] as Record<string, unknown>),
  );
}

describe("embeddingQueue table", () => {
  const cols = getColumnNames(embeddingQueue as unknown as Record<string, unknown>);

  it("has all original columns", () => {
    const original = [
      "id",
      "targetTable",
      "targetId",
      "targetColumn",
      "inputText",
      "status",
      "attempts",
      "error",
      "createdAt",
      "updatedAt",
    ];
    for (const col of original) {
      expect(cols, `missing original column: ${col}`).toContain(col);
    }
  });

  it("has companyId column (nullable uuid for per-company key resolution)", () => {
    expect(cols, "missing column: companyId").toContain("companyId");
  });

  it("has nextRetryAt column (nullable timestamp for exponential backoff)", () => {
    expect(cols, "missing column: nextRetryAt").toContain("nextRetryAt");
  });

  it("has the two new columns (companyId + nextRetryAt) together", () => {
    expect(cols).toContain("companyId");
    expect(cols).toContain("nextRetryAt");
  });
});
