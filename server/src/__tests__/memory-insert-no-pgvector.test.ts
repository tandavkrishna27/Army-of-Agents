// Guards against regressions of Finding J (rc.2 / rc.5). The fresh-install path
// must insert memory items without referencing the `embedding` column when
// pgvector is unavailable — otherwise postgres rejects the statement because
// migration 0038 only adds that column when the extension is present.

import { describe, it, expect, vi } from "vitest";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
  },
}));

import { buildMemoryInsert } from "../services/memory-projection.js";
import type { Db } from "@armyofagents/db";

/**
 * Minimal Db stub: captures the SQL string passed to `execute` by piping it
 * through Drizzle's sqlToQuery serializer (via the node-postgres dialect).
 * Returns a canned row so the caller sees a well-formed result.
 */
async function captureSql(values: Record<string, unknown>, hasVector: boolean) {
  let captured: { sql: string; params: unknown[] } | null = null;
  const dialectModule = await import("drizzle-orm/pg-core");
  const dialect = new (dialectModule as unknown as { PgDialect: new () => { sqlToQuery: (sql: unknown) => { sql: string; params: unknown[] } } }).PgDialect();
  const fakeDb = {
    execute: async (query: unknown) => {
      captured = dialect.sqlToQuery(query);
      return {
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000001",
            companyId: values.companyId,
            title: values.title,
            status: values.status,
            tags: values.tags ?? [],
          },
        ],
      };
    },
  } as unknown as Db;

  const rows = await buildMemoryInsert(fakeDb, values, hasVector);
  return { captured: captured as unknown as { sql: string; params: unknown[] } | null, rows };
}

describe("buildMemoryInsert (Finding J rc.5)", () => {
  const baseValues = {
    companyId: "00000000-0000-0000-0000-000000000aaa",
    title: "test",
    content: "content",
    category: "context",
    source: "founder" as const,
    status: "approved",
    tags: [] as string[],
    layer: "domain" as const,
    priority: 0,
    visibility: "scoped" as const,
    createdBy: "local-board",
  };

  it("omits the embedding column from the INSERT column list when hasVector=false", async () => {
    const { captured } = await captureSql(baseValues, false);
    expect(captured).not.toBeNull();
    expect(captured!.sql).toMatch(/INSERT INTO "memory_items"/i);
    expect(captured!.sql).not.toMatch(/"embedding"[^_]/); // must not list the bare "embedding" column
    expect(captured!.sql).toMatch(/"embedding_retries"/); // sibling column is fine
  });

  it("includes the embedding column when hasVector=true", async () => {
    const { captured } = await captureSql(baseValues, true);
    expect(captured).not.toBeNull();
    expect(captured!.sql).toMatch(/"embedding"/);
  });

  it("serializes empty tags as a jsonb-cast parameter (avoids `()` syntax error)", async () => {
    const { captured } = await captureSql(baseValues, false);
    // The tags value must appear as a single parameter with ::jsonb cast, not
    // as an empty tuple `()`. A bare Drizzle `sql`${[]}` expands to `()` which
    // is invalid SQL next to a scalar column.
    expect(captured!.sql).toMatch(/\$\d+::jsonb/);
    expect(captured!.sql).not.toMatch(/VALUES \([^)]*\(\)/);
  });

  it("returns JS-camelCase keys via the RETURNING aliases", async () => {
    const { rows } = await captureSql(baseValues, false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: expect.any(String),
      companyId: baseValues.companyId,
      title: baseValues.title,
    });
  });
});
